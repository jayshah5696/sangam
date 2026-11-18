"""Assistant request failures, exercised through the real MCP broker and chat store.

Cases: duplicate inference after a lost wait; another actor's conversation;
narrowed grants exposing cached answers; omitted pending jobs; cancelled inference;
provider failure reported as success; restart replay; and review mistaken for a write.
"""

import asyncio
import json
from collections.abc import Iterator
from uuid import uuid4

import pytest
from agents.models.interface import ModelProvider
from conftest import issue_agent_token
from fastapi.testclient import TestClient
from test_mcp_slice import execute, seed
from test_phase_seven_chat import _RecordingResponsesModel, install_fake_model

from sangam.api import create_app
from sangam.chat_context import ChatRequestContext
from sangam.config import Settings
from sangam.db import Database
from sangam.errors import ValidationError
from sangam.mcp_models import SubmitAssistant


@pytest.fixture
def mcp_client(settings: Settings) -> Iterator[TestClient]:
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as client:
        yield client


def output(client: TestClient, token: str, code: str) -> dict:
    reply = execute(client, token, code)
    assert not reply.get("isError"), reply
    return reply["structuredContent"]["output"]


def test_assistant_requests_reuse_chat_and_continue_only_known_owned_conversations(
    mcp_client: TestClient,
) -> None:
    captured = install_fake_model(mcp_client, ["First answer", "Follow-up answer"])
    token = issue_agent_token(mcp_client, capabilities=("read", "search", "inference"))
    source = seed(mcp_client)
    key = "request/" + str(uuid4())
    code = (
        f"await assistant_submit(request_key='{key}', message='Explain this document', "
        f"document_id='{source['document_id']}', wait_seconds=2)"
    )
    result = output(mcp_client, token, code)
    assert result["status"] == "completed" and result["answer"] == "First answer"
    assert result["request_key"] == key and result["conversation_id"]
    assert result["run_id"] and result["resource_uri"]
    resource = mcp_client.post(
        "/mcp",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "resources/read",
            "params": {"uri": result["resource_uri"]},
        },
    ).json()
    assert "error" not in resource, resource
    assert json.loads(resource["result"]["contents"][0]["text"]) == result
    replay = output(mcp_client, token, code)
    assert replay == result
    assert len(captured) == 1
    reader = issue_agent_token(mcp_client, capabilities=("read",))
    assert output(mcp_client, reader, f"await assistant_get(request_key='{key}')") == result
    assert execute(mcp_client, reader, code.replace(key, str(uuid4()))).get("isError")
    conflict = execute(mcp_client, token, code.replace("Explain this document", "Other request"))
    assert conflict.get("isError") and "conflict" in json.dumps(conflict).lower()
    conversation = result["conversation_id"]
    continued = output(
        mcp_client,
        token,
        f"await assistant_submit(request_key='{uuid4()}', message='Explain further', "
        f"conversation_id='{conversation}', wait_seconds=2)",
    )
    assert continued["conversation_id"] == conversation
    assert continued["status"] == "completed" and continued["answer"] == "Follow-up answer"
    assert "First answer" in json.dumps(captured[-1])
    page = output(
        mcp_client, reader, f"await conversations_read(conversation_id='{conversation}', limit=2)"
    )
    assert len(page["items"]) == 2 and page["next_cursor"]
    messages = list(page["items"])
    while page["next_cursor"]:
        page = output(
            mcp_client,
            token,
            f"await conversations_read(conversation_id='{conversation}', "
            f"cursor='{page['next_cursor']}', limit=2)",
        )
        messages.extend(page["items"])
    assert len(messages) == 4
    assert messages[-1]["text"] == "Follow-up answer"
    other = issue_agent_token(
        mcp_client, actor_id="agent:other-assistant", capabilities=("read", "inference")
    )
    assert execute(mcp_client, other, f"await assistant_get(request_key='{key}')").get("isError")
    assert execute(
        mcp_client, other, f"await conversations_read(conversation_id='{conversation}')"
    ).get("isError")
    assert execute(
        mcp_client,
        other,
        f"await assistant_submit(request_key='{uuid4()}', message='Continue', "
        f"conversation_id='{conversation}')",
    ).get("isError")


def test_assistant_admission_rejects_missing_authority_and_disabled_inference(
    mcp_client: TestClient,
) -> None:
    install_fake_model(mcp_client, ["No inference expected"])
    token = issue_agent_token(mcp_client, capabilities=("read",))
    code = f"await assistant_submit(request_key='{uuid4()}', message='Hello')"
    assert execute(mcp_client, token, code).get("isError")
    token = issue_agent_token(mcp_client, capabilities=("read", "inference"))
    state = mcp_client.get("/api/v1/chat/models").json()
    mcp_client.put(
        "/api/v1/chat/models",
        json={
            "expected_version": state["version"],
            "workspace_enabled": False,
            "default_model": state["default_model"],
            "enabled_models": state["enabled_models"],
        },
    ).raise_for_status()
    assert execute(mcp_client, token, code).get("isError")
    with mcp_client.app.state.services.documents.database.connection() as connection:
        assert connection.execute("SELECT count(*) FROM assistant_requests").fetchone()[0] == 0


def test_pending_request_survives_discarded_output_and_cancelled_mcp_wait(
    mcp_client: TestClient,
) -> None:
    chat = mcp_client.app.state.services.chat
    install_fake_model(mcp_client, ["unused"])
    started = asyncio.Event()
    finish = asyncio.Event()
    captured = []

    class HeldModel(_RecordingResponsesModel):
        async def stream_response(self, *args, **kwargs):
            started.set()
            await finish.wait()
            async for event in super().stream_response(*args, **kwargs):
                yield event

    class Provider(ModelProvider):
        def get_model(self, model_name):
            return HeldModel("Finished after disconnect", captured)

    chat.provider_connections.model_provider = lambda _connection_id: Provider()
    token = issue_agent_token(mcp_client, capabilities=("read", "inference"))
    key = str(uuid4())
    reply = execute(
        mcp_client,
        token,
        f"await assistant_submit(request_key='{key}', message='Wait for work'); 'program done'",
    )
    assert reply["structuredContent"]["output"] == "program done"
    pending = reply["structuredContent"]["pending_jobs"][0]
    assert pending["request_key"] == key and pending["check_operation"] == "assistant.wait"
    mcp_client.portal.call(asyncio.wait_for, started.wait(), 2)
    duplicate = output(
        mcp_client, token, f"await assistant_submit(request_key='{key}', message='Wait for work')"
    )
    assert duplicate["status"] == "running"

    async def disconnect():
        runtime = mcp_client.app.state.mcp_runtime
        task = asyncio.create_task(
            runtime.execute(
                token, f"await assistant_wait(request_key='{key}', wait_seconds=2)", str(uuid4())
            )
        )
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        finish.set()

    mcp_client.portal.call(disconnect)
    result = output(mcp_client, token, f"await assistant_wait(request_key='{key}', wait_seconds=2)")
    assert result["status"] == "completed" and "disconnect" in result["answer"]
    assert len(captured) == 1
    mcp_client.portal.call(finish.clear)
    mcp_client.portal.call(started.clear)
    cancelled_key = str(uuid4())
    output(
        mcp_client,
        token,
        f"await assistant_submit(request_key='{cancelled_key}', message='Cancel this work')",
    )
    mcp_client.portal.call(asyncio.wait_for, started.wait(), 2)
    cancelled = output(mcp_client, token, f"await assistant_cancel(request_key='{cancelled_key}')")
    assert cancelled["status"] == "cancelled"
    assert len(captured) == 1

    async def shutdown_with_waiting_acceptance():
        service = mcp_client.app.state.services.assistant_requests
        principal = mcp_client.app.state.services.identity.authenticate(
            token, operation_id="shutdown"
        )
        started.clear()
        await service.submit(
            principal, SubmitAssistant(request_key=str(uuid4()), message="Hold the slot"), None
        )
        await asyncio.wait_for(started.wait(), 2)
        leases = [await chat.admission.acquire() for _ in range(3)]
        queued_key = str(uuid4())
        queued = asyncio.create_task(
            service.submit(
                principal, SubmitAssistant(request_key=queued_key, message="Queued work"), None
            )
        )
        await asyncio.sleep(0.05)
        closing = asyncio.create_task(service.close())
        try:
            done, _ = await asyncio.wait({closing}, timeout=2)
            assert closing in done, (
                "Shutdown waited behind admission instead of draining active work"
            )
            await closing
            with pytest.raises(ValidationError, match="shutting down"):
                await queued
            with service.database.connection() as connection:
                assert (
                    connection.execute(
                        "SELECT 1 FROM assistant_requests WHERE request_key=?", (queued_key,)
                    ).fetchone()
                    is None
                )
        finally:
            finish.set()
            for lease in leases:
                await lease.release()
            await asyncio.gather(queued, closing, return_exceptions=True)

    mcp_client.portal.call(shutdown_with_waiting_acceptance)


def test_assistant_results_and_execution_replay_recheck_current_source_grants(
    mcp_client: TestClient,
) -> None:
    install_fake_model(mcp_client, ["Private source answer"])
    source = seed(mcp_client, "private/research.md")
    token = issue_agent_token(mcp_client, capabilities=("read", "inference"))
    request_key, execution_key = str(uuid4()), str(uuid4())
    code = (
        f"await assistant_submit(request_key='{request_key}', message='Explain source', "
        f"document_id='{source['document_id']}', wait_seconds=2)"
    )
    assert not execute(mcp_client, token, code, execution_key).get("isError")
    narrow = mcp_client.post(
        "/api/v1/agent-tokens",
        json={
            "actor_id": "agent:cli",
            "display_name": "Sangam CLI",
            "label": "narrow assistant",
            "scopes": [
                {"capability": "inference"},
                {"capability": "read", "path_prefix": "public/"},
            ],
        },
    ).json()["token"]
    assert execute(mcp_client, narrow, f"await assistant_get(request_key='{request_key}')").get(
        "isError"
    )
    assert execute(mcp_client, narrow, code, execution_key).get("isError")
    assert execute(
        mcp_client, narrow, f"await executions_get(execution_key='{execution_key}')"
    ).get("isError")
    # A known conversation can also originate in REST rather than this request service.
    response = mcp_client.post(
        "/api/v1/chatkit",
        headers={"Authorization": f"Bearer {token}", "X-Sangam-Document-ID": source["document_id"]},
        json={
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": "Explain this source"}],
                    "attachments": [],
                    "inference_options": {},
                }
            },
        },
    )
    response.raise_for_status()
    events = [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]
    conversation_id = next(
        event["thread"]["id"] for event in events if event["type"] == "thread.created"
    )
    history_key = str(uuid4())
    history_code = f"await conversations_read(conversation_id='{conversation_id}')"
    assert not execute(mcp_client, token, history_code, history_key).get("isError")
    assert execute(mcp_client, narrow, history_code, history_key).get("isError")


def test_assistant_restart_preserves_identity_without_repeating_inference(
    settings: Settings,
) -> None:
    settings.mcp_enabled = True
    key = str(uuid4())
    code = (
        f"await assistant_submit(request_key='{key}', message='Remember request', wait_seconds=2)"
    )
    with TestClient(create_app(settings)) as client:
        install_fake_model(client, ["Saved result"])
        token = issue_agent_token(client, capabilities=("read", "inference"))
        result = output(client, token, code)
        assert result["status"] == "completed"
    database = Database(settings.database_path)
    with database.transaction() as connection:
        connection.execute(
            "UPDATE assistant_requests SET status='running' WHERE request_key=?", (key,)
        )
    with TestClient(create_app(settings)) as client:
        captured = install_fake_model(client, ["Must not run"])
        result = output(client, token, code)
        assert result["status"] == "interrupted" and captured == []
        assert result["conversation_id"]


def test_assistant_reports_reviewable_proposals_separately_from_saved_changes(
    mcp_client: TestClient,
) -> None:
    install_fake_model(mcp_client, ["Review the suggested change"])
    source = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read", "update", "inference"))
    key = str(uuid4())
    result = output(
        mcp_client,
        token,
        f"await assistant_submit(request_key='{key}', message='Suggest an edit', "
        f"document_id='{source['document_id']}', wait_seconds=2)",
    )
    services = mcp_client.app.state.services
    principal = services.identity.authenticate(token, operation_id="review-proof")
    proposal = services.chat.proposals.create(
        principal,
        thread_id=result["conversation_id"],
        document_id=source["document_id"],
        expected_revision_id=source["current_revision_id"],
        content="# Suggested change",
        summary="Review this change",
        run_id=result["run_id"],
    )
    status = output(mcp_client, token, f"await assistant_get(request_key='{key}')")
    assert status["status"] == "needs_review"
    assert status["proposals"][0]["proposal_id"] == proposal.proposal_id
    assert status["proposals"][0]["applied_revision_id"] is None
    assert (
        services.documents.get_document(source["document_id"]).current_revision_id
        == source["current_revision_id"]
    )


def test_assistant_provider_error_is_a_failed_job_and_does_not_leak_provider_details(
    mcp_client: TestClient,
) -> None:
    install_fake_model(mcp_client, ["unused"])

    class BrokenModel(_RecordingResponsesModel):
        async def stream_response(self, *args, **kwargs):
            raise RuntimeError("Provider failed with secret sk-do-not-expose")
            yield

    class Provider(ModelProvider):
        def get_model(self, model_name):
            return BrokenModel("unused", [])

    mcp_client.app.state.services.provider_connections.model_provider = lambda _id: Provider()
    token = issue_agent_token(mcp_client, capabilities=("read", "inference"))
    result = output(
        mcp_client,
        token,
        f"await assistant_submit(request_key='{uuid4()}', message='Fail safely', wait_seconds=2)",
    )
    assert result["status"] == "failed" and result["error"]
    assert "sk-do-not-expose" not in json.dumps(result)


@pytest.mark.parametrize("skill_path", ["public/skill.md", "private/skill.md"])
def test_conversation_access_rechecks_skill_catalog_and_supporting_documents(
    mcp_client: TestClient,
    skill_path: str,
) -> None:
    install_fake_model(mcp_client, ["A grounded answer"])
    source = seed(mcp_client, "public/source.md")
    helper = seed(mcp_client, "private/checklist.md")
    guide = mcp_client.post(
        "/api/v1/documents",
        headers={"Idempotency-Key": str(uuid4())},
        json={
            "title": "Review guide",
            "path": skill_path,
            "content": (
                "---\nname: review\ndescription: Review with a checklist\n---\n"
                f"Read [checklist](sangam://document/{helper['document_id']}).\n"
            ),
        },
    ).json()
    token = issue_agent_token(mcp_client, capabilities=("read", "inference"))
    skill = mcp_client.post(
        "/api/v1/chat/skills",
        headers={"Authorization": f"Bearer {token}"},
        json={"document_id": guide["document_id"]},
    ).json()
    key = str(uuid4())
    result = output(
        mcp_client,
        token,
        f"await assistant_submit(request_key='{key}', message='Read source', "
        f"document_id='{source['document_id']}', wait_seconds=2)",
    )
    narrow = mcp_client.post(
        "/api/v1/agent-tokens",
        json={
            "actor_id": "agent:cli",
            "display_name": "Sangam CLI",
            "label": "Public read",
            "scopes": [
                {"capability": "inference"},
                {"capability": "read", "path_prefix": "public/"},
            ],
        },
    ).json()["token"]
    before = execute(mcp_client, narrow, f"await assistant_get(request_key='{key}')")
    if skill_path.startswith("private/"):
        assert before.get("isError")
    else:
        assert not before.get("isError")
    chat = mcp_client.app.state.services.chat
    principal = mcp_client.app.state.services.identity.authenticate(
        token, operation_id="skill-proof"
    )
    with chat.evidence.database.connection() as connection:
        context_id = connection.execute(
            "SELECT context_id FROM chat_runs WHERE run_id=?", (result["run_id"],)
        ).fetchone()[0]
    activated = chat.skills.activate(
        principal,
        ChatRequestContext(principal=principal, context_snapshot_id=context_id),
        skill["skill_id"],
    )
    assert activated.resources[0].document_id == helper["document_id"]
    assert execute(mcp_client, narrow, f"await assistant_get(request_key='{key}')").get("isError")


def test_legacy_conversation_upgrade_marks_its_source_inventory_incomplete(
    settings: Settings,
) -> None:
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as client:
        install_fake_model(client, ["Legacy answer"])
        source = seed(client, "public/legacy.md")
        token = issue_agent_token(client, capabilities=("read", "inference"))
        result = output(
            client,
            token,
            f"await assistant_submit(request_key='{uuid4()}', message='Read source', "
            f"document_id='{source['document_id']}', wait_seconds=2)",
        )
        narrow = client.post(
            "/api/v1/agent-tokens",
            json={
                "actor_id": "agent:cli",
                "display_name": "Sangam CLI",
                "label": "Legacy public read",
                "scopes": [
                    {"capability": "inference"},
                    {"capability": "read", "path_prefix": "public/"},
                ],
            },
        ).json()["token"]
    # Restore the schema-042 shape while retaining canonical thread/run records.
    database = Database(settings.database_path)
    with database.transaction() as connection:
        connection.execute("DROP TABLE mcp_execution_chat_refs")
        connection.execute("DROP TABLE assistant_requests")
        connection.execute("DELETE FROM schema_migrations WHERE version IN ('043', '045')")
    with TestClient(create_app(settings)) as client:
        code = f"await conversations_read(conversation_id='{result['conversation_id']}')"
        assert not execute(client, token, code).get("isError")
        assert execute(client, narrow, code).get("isError")


def test_assistant_result_identifies_a_committed_effect_revision(mcp_client: TestClient) -> None:
    install_fake_model(mcp_client, ["Create the requested note"])
    token = issue_agent_token(mcp_client, capabilities=("read", "create", "inference"))
    key = str(uuid4())
    result = output(
        mcp_client,
        token,
        f"await assistant_submit(request_key='{key}', message='Create a note', wait_seconds=2)",
    )
    services = mcp_client.app.state.services
    principal = services.identity.authenticate(token, operation_id="effect-proof")
    capability = services.chat.capabilities.get("create_document")
    arguments = capability.input_schema.model_validate(
        {
            "title": "Confirmed note",
            "content": "# Confirmed",
            "path": "mcp/confirmed.md",
            "content_type": "text/markdown",
        }
    ).model_dump(mode="json")
    effect = services.chat.effects.propose(
        principal,
        run_id=result["run_id"],
        thread_id=result["conversation_id"],
        tool_call_id="create-proof",
        capability=capability,
        arguments=arguments,
        preview=arguments,
    )
    approved = mcp_client.post(
        f"/api/v1/chat/effects/{effect.effect_id}/decision",
        json={
            "verdict": "approve",
            "argument_digest": effect.argument_digest,
        },
    )
    approved.raise_for_status()
    status = output(mcp_client, token, f"await assistant_get(request_key='{key}')")
    assert status["status"] == "completed"
    proof = status["effects"][0]
    assert proof["status"] == "completed" and proof["resource_type"] == "document"
    saved = services.documents.get_document(proof["resource_id"])
    assert proof["revision_id"] == saved.current_revision_id
    assert saved.content == "# Confirmed"
