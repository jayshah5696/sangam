from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from types import SimpleNamespace
from typing import Any, cast

import pytest
from agents.models.interface import Model, ModelProvider
from agents.tool_context import ToolContext as AgentsToolContext
from chatkit.agents import AgentContext
from chatkit.types import CustomTask
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseContentPartAddedEvent,
    ResponseContentPartDoneEvent,
    ResponseCreatedEvent,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseTextDeltaEvent,
    ResponseTextDoneEvent,
)
from pydantic import ValidationError as PydanticValidationError

from sangam.chat_capabilities import ProposeUpdateInput, WorkspaceSearchInput
from sangam.chat_context import ChatRequestContext
from sangam.config import Settings
from sangam.errors import ValidationError
from sangam.security import Principal


def chatkit_request(client: TestClient, body: dict, **request_headers: str):
    return client.post("/api/v1/chatkit", json=body, headers=request_headers)


def create_thread(
    client: TestClient,
    *,
    document_id: str | None = None,
    model: str = "openai/gpt-5.4-nano",
    **extra_headers: str,
) -> str:
    request_headers = {"X-Sangam-Document-ID": document_id} if document_id else {}
    request_headers.update(extra_headers)
    response = chatkit_request(
        client,
        {
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": "Review this document"}],
                    "attachments": [],
                    "inference_options": {"model": model},
                }
            },
        },
        **request_headers,
    )
    assert response.status_code == 200
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert [event["type"] for event in events[:4]] == [
        "thread.created",
        "thread.item.done",
        "stream_options",
        "error",
    ]
    assert events[2]["stream_options"] == {"allow_cancel": True}
    assert events[3]["code"] == "custom"
    return events[0]["thread"]["id"]


def test_workspace_chat_accepts_a_thread_without_document_context(client: TestClient) -> None:
    thread_id = create_thread(client, **{"X-Sangam-Workspace-Context": "1"})
    assert thread_id
    proposals = client.get("/api/v1/chat/proposals", params={"thread_id": thread_id})
    assert proposals.status_code == 200
    assert proposals.json() == []


def test_workspace_chat_does_not_inherit_a_thread_document_context(client: TestClient) -> None:
    chat = client.app.state.services.chat
    thread = SimpleNamespace(metadata={"document_id": "doc-from-thread"}, title="Existing")
    context = ChatRequestContext(
        principal=Principal.trusted_human(
            actor_id="human:jay", display_name="Jay", operation_id="workspace-chat"
        ),
        workspace_context=True,
    )
    assert context.document_id is None
    document_id = (
        context.document_id
        if context.document_id is not None or context.workspace_context
        else thread.metadata.get("document_id")
    )
    assert document_id is None
    assert asyncio.run(chat._app_context(context)) == (
        "<SANGAM_CONTEXT>\nNo current document is open.\n</SANGAM_CONTEXT>"
    )


def test_document_chat_persists_the_requested_pinned_revision(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Pinned context", "content": "Version one", "path": "pinned.md"},
        headers=headers("pinned-context"),
    ).json()
    pinned_revision = document["current_revision_id"]

    install_fake_model(client, ["Pinned answer"])
    response = chatkit_request(
        client,
        {
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": "Review this document"}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                }
            },
        },
        **{
            "X-Sangam-Document-ID": document["document_id"],
            "X-Sangam-Revision-ID": pinned_revision,
        },
    )
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert "error" not in {event["type"] for event in events}
    thread_id = next(event["thread"]["id"] for event in events if event["type"] == "thread.created")
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="pinned-context-test"
    )
    request_context = ChatRequestContext(principal=principal, document_id=document["document_id"])
    user_item_id = next(
        event["item"]["id"] for event in events if event["type"] == "thread.item.done"
    )
    turn_context = client.app.state.services.chat.evidence.context_for_item(
        request_context.principal, user_item_id
    )
    assert turn_context is not None
    assert turn_context.thread_id == thread_id
    assert turn_context.revision_id == pinned_revision


def test_document_chat_rejects_an_unknown_requested_revision(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Missing revision", "content": "Current", "path": "missing-revision.md"},
        headers=headers("missing-revision"),
    ).json()

    install_fake_model(client, ["This response must not run"])
    response = chatkit_request(
        client,
        {
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": "Review this document"}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                }
            },
        },
        **{
            "X-Sangam-Document-ID": document["document_id"],
            "X-Sangam-Revision-ID": "missing-revision-id",
        },
    )

    assert response.status_code == 200
    assert "The attached document revision no longer exists" in response.text


def test_external_agent_requires_inference_scope_to_spend_provider_budget(
    client: TestClient,
) -> None:
    created = client.post(
        "/api/v1/chat/connections",
        json={
            "connection_id": "local",
            "name": "Local",
            "protocol": "openai_chat_completions",
            "base_url": "http://127.0.0.1:9000/v1",
            "credential_env": None,
            "enabled": True,
        },
    )
    assert created.status_code == 201
    current = client.get("/api/v1/chat/models").json()
    model = "local::demo/tool-model"
    selected = client.put(
        "/api/v1/chat/models",
        json={
            "expected_version": current["version"],
            "workspace_enabled": True,
            "default_model": model,
            "enabled_models": [model],
            "unknown_model_overrides": [model],
        },
    )
    assert selected.status_code == 200
    entry = next(item for item in selected.json()["catalog"] if item["id"] == model)
    assert entry["protocol"] == "openai_chat_completions"

    token = issue_agent_token(client, capabilities=("read",))
    response = chatkit_request(
        client,
        {
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": "Read this"}],
                    "attachments": [],
                    "inference_options": {"model": model},
                }
            },
        },
        Authorization=f"Bearer {token}",
    )

    assert response.status_code == 200
    assert "does not include the inference capability" in response.text


def test_chatkit_runtime_config_and_supported_abstractions(client: TestClient) -> None:
    response = client.get("/api/v1/chat/config", headers={"Origin": "https://sangam.example.test"})

    assert response.status_code == 200
    config = response.json()
    assert config["status"] == "missing_credential"
    assert config["inference_enabled"] is False
    assert config["transport"] == "chatkit"
    assert config["transport_status"] == "misconfigured"
    assert config["chat_enabled"] is False
    assert config["domain_key"] == "local-dev"
    assert config["default_model"] == "openrouter::openai/gpt-5.6-sol"
    assert config["autonomy_mode"] == "review"
    assert {item["id"] for item in config["available_models"]} == {
        "openrouter::openai/gpt-5.6-sol",
        "openrouter::openai/gpt-5.6-luna",
        "openrouter::openai/gpt-5.4-mini",
        "openrouter::openai/gpt-5.4-nano",
        "openrouter::openai/gpt-5.6-terra",
    }
    assert config["reasoning_effort"] == "medium"
    assert "api_key" not in response.text

    local_config = client.get(
        "/api/v1/chat/config", headers={"Origin": "http://127.0.0.1:8000"}
    ).json()
    assert local_config["transport_status"] == "ready"
    assert local_config["transport_message"] == "ChatKit browser transport is ready."

    assert {tool.name for tool in client.app.state.services.chat.tools} == {
        "get_editor_selection",
        "search_workspace",
        "read_document",
        "read_pdf_page",
        "propose_update",
        "create_document",
        "publish_document",
        "inspect_workspace_organization",
        "apply_workspace_organization_plan",
    }
    create_thread(client)


def test_chatkit_threads_are_durable_and_owner_scoped(client: TestClient) -> None:
    thread_id = create_thread(client)
    loaded = chatkit_request(
        client,
        {"type": "threads.get_by_id", "params": {"thread_id": thread_id}},
    )
    assert loaded.status_code == 200
    assert loaded.json()["id"] == thread_id
    assert loaded.json()["items"]["data"][0]["content"][0]["text"] == "Review this document"

    token = issue_agent_token(client, capabilities=("read", "search"))
    hidden = chatkit_request(
        client,
        {"type": "threads.get_by_id", "params": {"thread_id": thread_id}},
        Authorization=f"Bearer {token}",
    )
    assert hidden.status_code == 404


def test_reviewed_chat_proposal_uses_the_normal_document_update_path(
    client: TestClient,
) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Research", "content": "Original evidence", "path": "research.md"},
        headers=headers("phase-seven-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="proposal-test"
    )
    proposal = client.app.state.services.chat.proposals.create(
        principal,
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="Original evidence\n\nGrounded conclusion.",
        summary="Add grounded conclusion from workspace chat",
    )

    current = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert current["content"] == "Original evidence"
    listed = client.get(
        f"/api/v1/chat/proposals?document_id={document['document_id']}&thread_id={thread_id}"
    )
    assert listed.status_code == 200
    assert listed.json()[0]["proposal_id"] == proposal.proposal_id

    applied = client.post(
        f"/api/v1/chat/proposals/{proposal.proposal_id}/apply",
        json={"expected_revision_id": proposal.expected_revision_id},
        headers=headers("apply-chat-proposal"),
    )
    assert applied.status_code == 200
    assert applied.json()["status"] == "applied"
    updated = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert updated["content"].endswith("Grounded conclusion.")
    history = client.get(f"/api/v1/documents/{document['document_id']}/history").json()
    assert history[0]["actor_id"] == "human:jay"
    assert history[0]["summary"] == "Add grounded conclusion from workspace chat"


def test_chat_proposal_detects_a_concurrent_edit(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Concurrent", "content": "one"},
        headers=headers("phase-seven-concurrent"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="proposal-conflict"
    )
    proposal = client.app.state.services.chat.proposals.create(
        principal,
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="chat version",
        summary="Chat proposal",
    )
    changed = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={"expected_revision_id": document["current_revision_id"], "content": "human version"},
        headers=headers("phase-seven-human-edit"),
    )
    assert changed.status_code == 200

    conflict = client.post(
        f"/api/v1/chat/proposals/{proposal.proposal_id}/apply",
        json={"expected_revision_id": proposal.expected_revision_id},
        headers=headers("phase-seven-stale-apply"),
    )
    assert conflict.status_code == 409
    listed = client.get(
        f"/api/v1/chat/proposals?document_id={document['document_id']}&thread_id={thread_id}"
    ).json()
    assert listed[0]["status"] == "stale"
    current = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert current["content"] == "human version"


def test_stale_chat_proposal_can_be_dismissed_with_a_reason(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Dismiss stale", "content": "one"},
        headers=headers("phase-seven-stale-dismiss-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="stale-dismiss"
    )
    proposal = client.app.state.services.chat.proposals.create(
        principal,
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="chat version",
        summary="Chat proposal",
    )
    client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={"expected_revision_id": document["current_revision_id"], "content": "human version"},
        headers=headers("phase-seven-stale-dismiss-edit"),
    )
    conflict = client.post(
        f"/api/v1/chat/proposals/{proposal.proposal_id}/apply",
        json={"expected_revision_id": proposal.expected_revision_id},
        headers=headers("phase-seven-stale-dismiss-apply"),
    )
    assert conflict.status_code == 409

    # A stale proposal offers a Dismiss button in the review UI, so dismissing it
    # must succeed and clear it from the reviewable list rather than deadlocking on
    # the spent apply reservation.
    dismissed = client.post(
        f"/api/v1/chat/proposals/{proposal.proposal_id}/dismiss",
        json={"reason": "Wrong section for this edit"},
    )
    assert dismissed.status_code == 200
    assert dismissed.json()["status"] == "dismissed"
    assert dismissed.json()["summary"].endswith("Wrong section for this edit")

    listed = client.get(
        f"/api/v1/chat/proposals?document_id={document['document_id']}&thread_id={thread_id}"
    ).json()
    assert [proposal_row["status"] for proposal_row in listed] == ["dismissed"]


def test_chat_proposal_apply_recovers_after_status_write_failure(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Recoverable", "content": "before"},
        headers=headers("phase-seven-recovery-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="proposal-recovery"
    )
    proposals = client.app.state.services.chat.proposals
    proposal = proposals.create(
        principal,
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="after",
        summary="Recover interrupted apply",
    )
    original_mark_applied = proposals.repository.mark_applied
    calls = 0

    def fail_once(apply_principal: Principal, proposal_id: str, applied_revision_id: str):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("simulated interruption after document commit")
        return original_mark_applied(apply_principal, proposal_id, applied_revision_id)

    monkeypatch.setattr(proposals.repository, "mark_applied", fail_once)
    with pytest.raises(RuntimeError, match="simulated interruption"):
        proposals.apply(
            principal,
            proposal_id=proposal.proposal_id,
            expected_revision_id=proposal.expected_revision_id,
            idempotency_key="first-apply-key",
        )

    pending = proposals.repository.get_owned(principal, proposal.proposal_id)
    assert pending.status == "pending"
    retry_principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="proposal-recovery-retry"
    )
    recovered = proposals.apply(
        retry_principal,
        proposal_id=proposal.proposal_id,
        expected_revision_id=proposal.expected_revision_id,
        idempotency_key="different-retry-key",
    )

    assert recovered.status == "applied"
    assert recovered.applied_revision_id is not None
    history = client.get(f"/api/v1/documents/{document['document_id']}/history").json()
    assert [revision["content"] for revision in history] == ["after", "before"]


def test_chat_proposal_validation_failure_releases_apply_reservation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Invalid proposal", "content": "before"},
        headers=headers("phase-seven-invalid-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="proposal-invalid"
    )
    proposals = client.app.state.services.chat.proposals
    proposal = proposals.create(
        principal,
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="after",
        summary="Invalid after review",
    )
    monkeypatch.setattr(
        proposals.workspace,
        "update_document",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ValidationError("invalid content")),
    )

    with pytest.raises(ValidationError, match="invalid content"):
        proposals.apply(
            principal,
            proposal_id=proposal.proposal_id,
            expected_revision_id=proposal.expected_revision_id,
            idempotency_key="invalid-apply-key",
        )

    dismissed = proposals.dismiss(principal, proposal.proposal_id, "Cannot apply safely")
    assert dismissed.status == "dismissed"


def test_chat_tool_wrapper_tracks_task_identity_and_serializes_failures(client: TestClient) -> None:
    toolset = client.app.state.services.chat.toolset

    class FakeAgentContext:
        def __init__(self) -> None:
            existing = CustomTask(title="Earlier task", content="done", status_indicator="complete")
            workflow = SimpleNamespace(tasks=[existing])
            self.workflow_item = SimpleNamespace(workflow=workflow)
            self.updated_index: int | None = None

        async def add_workflow_task(self, task: CustomTask) -> None:
            self.workflow_item.workflow.tasks.append(task)

        async def update_workflow_task(self, task: CustomTask, task_index: int) -> None:
            self.updated_index = task_index
            self.workflow_item.workflow.tasks[task_index] = task

    agent_context = FakeAgentContext()
    ctx = cast(Any, SimpleNamespace(context=agent_context))

    result = asyncio.run(
        toolset._run_tool(
            ctx,
            toolset.policies["read_document"],
            "missing",
            lambda: (_ for _ in ()).throw(ValidationError("cannot read document")),
        )
    )

    assert agent_context.updated_index == 1
    payload = json.loads(result)
    assert payload["error"]["code"] == "validation_error"
    assert payload["_trace"]["effect"] == "read"
    assert payload["_trace"]["outcome"] == "failed"
    assert agent_context.workflow_item.workflow.tasks[1].content.startswith("Failed · read ·")


def test_agents_sdk_function_tool_invokes_authorized_workspace_read(
    client: TestClient,
) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Tool invocation", "content": "orchid-compass-93"},
        headers=headers("phase-seven-tool-invocation"),
    ).json()
    token = issue_agent_token(client, capabilities=("read",))
    thread_id = create_thread(
        client,
        document_id=document["document_id"],
        Authorization=f"Bearer {token}",
    )
    principal = client.app.state.services.identity.authenticate(
        token, operation_id="tool-invocation"
    )
    request_context = ChatRequestContext(principal=principal, document_id=document["document_id"])
    chat = client.app.state.services.chat
    thread = asyncio.run(chat.store_adapter.load_thread(thread_id, request_context))
    agent_context = AgentContext(
        thread=thread,
        store=chat.store_adapter,
        request_context=request_context,
    )
    read_tool = next(tool for tool in chat.tools if tool.name == "read_document")
    arguments = json.dumps({"document_id": document["document_id"]})
    run_context = AgentsToolContext(
        context=agent_context,
        tool_name=read_tool.name,
        tool_call_id="call-read-document",
        tool_arguments=arguments,
    )

    result = asyncio.run(
        read_tool.on_invoke_tool(
            run_context,
            arguments,
        )
    )
    second_result = asyncio.run(
        read_tool.on_invoke_tool(
            run_context,
            arguments,
        )
    )

    payload = json.loads(result)
    assert payload["content"] == "orchid-compass-93"
    assert json.loads(second_result)["content"] == "orchid-compass-93"
    assert payload["source"]["revision_id"] == document["current_revision_id"]
    assert agent_context.workflow_item is not None
    assert agent_context.workflow_item.workflow.tasks[0].status_indicator == "complete"
    events = client.get("/api/v1/activity", params={"actor_id": principal.actor_id}).json()
    tool_events = [event for event in events if event["operation_id"] == "tool-invocation"]
    assert len(tool_events) == 2
    assert len({event["event_id"] for event in tool_events}) == 2
    assert {event["outcome"] for event in tool_events} == {"accepted"}


def durable_effect_context(
    client: TestClient,
    principal: Principal,
    *,
    document_id: str | None = None,
) -> tuple[Any, str]:
    thread_id = create_thread(client, document_id=document_id)
    chat = client.app.state.services.chat
    entry_point = "document" if document_id else "workspace"
    turn = chat.evidence.create_turn_context(
        principal,
        entry_point=entry_point,
        document_id=document_id,
        revision_id=None,
        selected_text="",
    )
    capability = chat.capabilities.get("publish_document" if document_id else "create_document")
    manifest = (capability.manifest_item(),)
    item_id = f"manual_{thread_id}"
    turn = chat.evidence.attach_turn_context(
        principal,
        context_id=turn.context_id,
        thread_id=thread_id,
        user_item_id=item_id,
        model_ref="openrouter::openai/gpt-5.4-nano",
        capability_manifest=manifest,
    )
    run_id = chat.evidence.begin_run(
        principal,
        thread_id=thread_id,
        user_item_id=item_id,
        context_id=turn.context_id,
        connection_id="openrouter",
        model_ref="openrouter::openai/gpt-5.4-nano",
        capability_manifest=manifest,
    )
    agent_context = SimpleNamespace(
        request_context=ChatRequestContext(
            principal=principal,
            document_id=document_id,
            run_id=run_id,
        ),
        thread=SimpleNamespace(id=thread_id),
        client_tool_call=None,
    )
    ctx = cast(Any, SimpleNamespace(context=agent_context, tool_call_id=f"call_{thread_id}"))
    return ctx, thread_id


def test_publish_tool_requires_client_confirmation_before_any_side_effect(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Release notes", "content": "Not public yet"},
        headers=headers("chat-publish-confirm-source"),
    ).json()
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="chat-publish-confirm"
    )
    toolset = client.app.state.services.chat.toolset
    ctx, _thread_id = durable_effect_context(client, principal, document_id=document["document_id"])
    agent_context = ctx.context
    monkeypatch.setattr(
        toolset.workspace,
        "create_publication",
        lambda *_args, **_kwargs: pytest.fail("publish must not run before browser approval"),
    )

    result = asyncio.run(
        toolset.publish_document(
            ctx,
            document_id=document["document_id"],
            slug="release-notes",
            access_policy="public",
        )
    )

    assert result is None
    assert agent_context.client_tool_call.name == "review_chat_effect"
    effect = client.get(
        f"/api/v1/chat/effects/{agent_context.client_tool_call.arguments['effect_id']}"
    ).json()
    assert effect["argument_digest"] == agent_context.client_tool_call.arguments["argument_digest"]
    assert effect["preview"] == {
        "document_id": document["document_id"],
        "revision_id": document["current_revision_id"],
        "document_title": "Release notes",
        "slug": "release-notes",
        "access_policy": "public",
    }
    assert "token" not in json.dumps(agent_context.client_tool_call.arguments)
    assert client.get(f"/api/v1/publications/by-document/{document['document_id']}").json() is None


def test_create_document_tool_requires_client_confirmation_before_any_side_effect(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="chat-create-confirm"
    )
    toolset = client.app.state.services.chat.toolset
    ctx, _thread_id = durable_effect_context(client, principal)
    agent_context = ctx.context
    monkeypatch.setattr(
        toolset.workspace,
        "create_document",
        lambda *_args, **_kwargs: pytest.fail("create must not run before browser approval"),
    )

    result = asyncio.run(
        toolset.create_document(
            ctx, title="  Research   note  ", content="# Evidence", content_type="text/markdown"
        )
    )

    assert result is None
    assert agent_context.client_tool_call.name == "review_chat_effect"
    effect = client.get(
        f"/api/v1/chat/effects/{agent_context.client_tool_call.arguments['effect_id']}"
    ).json()
    assert effect["argument_digest"] == agent_context.client_tool_call.arguments["argument_digest"]
    assert effect["preview"] == {
        "title": "Research note",
        "content": "# Evidence",
        "content_type": "text/markdown",
    }
    assert client.get("/api/v1/documents").json() == []
    create_tool = next(
        tool for tool in client.app.state.services.chat.tools if tool.name == "create_document"
    )
    assert "never ask for confirmation in prose" in create_tool.description.lower()


def test_chat_store_loads_legacy_payloads_and_rejects_unknown_versions(
    client: TestClient,
) -> None:
    thread_id = create_thread(client)
    chat = client.app.state.services.chat
    database = chat.store_adapter.database
    with database.transaction() as connection:
        row = connection.execute(
            "SELECT data_json FROM chat_threads WHERE thread_id = ?", (thread_id,)
        ).fetchone()
        envelope = json.loads(row["data_json"])
        connection.execute(
            "UPDATE chat_threads SET data_json = ? WHERE thread_id = ?",
            (json.dumps(envelope["payload"]), thread_id),
        )

    legacy = chatkit_request(
        client,
        {"type": "threads.get_by_id", "params": {"thread_id": thread_id}},
    )
    assert legacy.status_code == 200

    with database.transaction() as connection:
        connection.execute(
            "UPDATE chat_threads SET data_json = ? WHERE thread_id = ?",
            (json.dumps({"schema_version": 99, "payload": {}}), thread_id),
        )
    unsupported = chatkit_request(
        client,
        {"type": "threads.get_by_id", "params": {"thread_id": thread_id}},
    )
    assert unsupported.status_code == 502
    assert "unsupported schema version" in unsupported.json()["error"]["message"]


def _make_response(text: str, *, status: str = "completed", with_output: bool = True) -> Response:
    message = ResponseOutputMessage(
        id="msg_1",
        type="message",
        role="assistant",
        status="completed",
        content=[ResponseOutputText(type="output_text", text=text, annotations=[])],
    )
    return Response(
        id="resp_1",
        object="response",
        created_at=0,
        model="fake",
        output=[message] if with_output else [],
        parallel_tool_calls=False,
        tool_choice="auto",
        tools=[],
        instructions=None,
        status=cast(Any, status),
    )


class _RecordingResponsesModel(Model):
    """Minimal streaming Responses model that records the input it is handed.

    It emits the same event sequence OpenAI's Responses streaming API produces so
    ChatKit builds and persists a real assistant message, and it rejects any
    replayed assistant content that carries output-only fields (e.g. ``logprobs``)
    the way OpenRouter's stateless Responses API does.
    """

    def __init__(self, text: str, captured: list[Any]) -> None:
        self.text = text
        self.captured = captured

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def stream_response(  # type: ignore[override]
        self,
        system_instructions: str | None,
        input: str | list[Any],
        *args: Any,
        **kwargs: Any,
    ) -> AsyncIterator[Any]:
        self.captured.append(input)
        if isinstance(input, list):
            for item in input:
                if not isinstance(item, dict) or item.get("role") != "assistant":
                    continue
                for part in item.get("content") or []:
                    if isinstance(part, dict) and "logprobs" in part:
                        raise RuntimeError(
                            "400 invalid_prompt: Unknown parameter: input[].content[].logprobs"
                        )
        text = self.text
        counter = 0

        def seq() -> int:
            nonlocal counter
            counter += 1
            return counter

        yield ResponseCreatedEvent(
            type="response.created",
            response=_make_response("", status="in_progress", with_output=False),
            sequence_number=seq(),
        )
        yield ResponseOutputItemAddedEvent(
            type="response.output_item.added",
            output_index=0,
            item=ResponseOutputMessage(
                id="msg_1", type="message", role="assistant", status="in_progress", content=[]
            ),
            sequence_number=seq(),
        )
        yield ResponseContentPartAddedEvent(
            type="response.content_part.added",
            item_id="msg_1",
            output_index=0,
            content_index=0,
            part=ResponseOutputText(type="output_text", text="", annotations=[]),
            sequence_number=seq(),
        )
        yield ResponseTextDeltaEvent(
            type="response.output_text.delta",
            item_id="msg_1",
            output_index=0,
            content_index=0,
            delta=text,
            sequence_number=seq(),
            logprobs=[],
        )
        done_part = ResponseOutputText(type="output_text", text=text, annotations=[])
        yield ResponseTextDoneEvent(
            type="response.output_text.done",
            item_id="msg_1",
            output_index=0,
            content_index=0,
            text=text,
            sequence_number=seq(),
            logprobs=[],
        )
        yield ResponseContentPartDoneEvent(
            type="response.content_part.done",
            item_id="msg_1",
            output_index=0,
            content_index=0,
            part=done_part,
            sequence_number=seq(),
        )
        yield ResponseOutputItemDoneEvent(
            type="response.output_item.done",
            output_index=0,
            item=ResponseOutputMessage(
                id="msg_1",
                type="message",
                role="assistant",
                status="completed",
                content=[done_part],
            ),
            sequence_number=seq(),
        )
        yield ResponseCompletedEvent(
            type="response.completed",
            response=_make_response(text),
            sequence_number=seq(),
        )


def install_fake_model(client: TestClient, replies: Sequence[str]) -> list[Any]:
    """Point the chat server at a scripted fake model. Returns captured inputs."""
    captured: list[Any] = []
    replies = list(replies)
    index = {"value": 0}

    class Provider(ModelProvider):
        def get_model(self, model_name: str | None) -> Model:
            reply = replies[min(index["value"], len(replies) - 1)]
            index["value"] += 1
            return _RecordingResponsesModel(reply, captured)

    connections = client.app.state.services.provider_connections
    connections._credential_overrides["openrouter"] = "sk-test"
    connections.model_provider = lambda _connection_id: Provider()
    return captured


def send_user_message(client: TestClient, thread_id: str, text: str) -> list[dict[str, Any]]:
    response = chatkit_request(
        client,
        {
            "type": "threads.add_user_message",
            "params": {
                "thread_id": thread_id,
                "input": {
                    "content": [{"type": "input_text", "text": text}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                },
            },
        },
    )
    assert response.status_code == 200
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def create_thread_with_model(client: TestClient, text: str) -> tuple[str, list[dict[str, Any]]]:
    response = chatkit_request(
        client,
        {
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": text}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                }
            },
        },
    )
    assert response.status_code == 200
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    thread_id = next(event["thread"]["id"] for event in events if event["type"] == "thread.created")
    return thread_id, events


def test_follow_on_request_replays_assistant_history_as_plain_text(client: TestClient) -> None:
    captured = install_fake_model(client, ["First answer", "Second answer"])

    thread_id, first_events = create_thread_with_model(client, "hi")
    assert "error" not in {event["type"] for event in first_events}

    follow_on = send_user_message(client, thread_id, "what can you do")

    # The follow-on turn must succeed — this is the regression the user reported.
    assert "error" not in {event["type"] for event in follow_on}

    # The prior assistant turn is replayed to the model as provider-safe input_text
    # (no fabricated output-only fields such as ``logprobs``) so OpenRouter accepts it.
    follow_on_input = captured[1]
    assistant_items = [item for item in follow_on_input if item.get("role") == "assistant"]
    assert assistant_items, "prior assistant turn should be replayed as context"
    for item in assistant_items:
        for part in item["content"]:
            assert part["type"] == "input_text"
            assert "logprobs" not in part
            assert "annotations" not in part
    assert [item["content"][0]["text"] for item in assistant_items] == ["First answer"]


def test_thread_title_is_derived_from_the_first_user_message(client: TestClient) -> None:
    install_fake_model(client, ["Answer"])

    thread_id, events = create_thread_with_model(
        client, "Explain how the authentication module handles refresh tokens"
    )

    assert "thread.updated" in {event["type"] for event in events}
    loaded = chatkit_request(
        client,
        {"type": "threads.get_by_id", "params": {"thread_id": thread_id}},
    )
    title = loaded.json()["title"]
    assert title is not None
    assert title != "New thread"
    assert title.startswith("Explain how the authentication")
    assert len(title) <= 48


def test_long_first_message_title_is_truncated_with_ellipsis(client: TestClient) -> None:
    install_fake_model(client, ["Answer"])
    long_prompt = "Summarize " + "the quarterly revenue analysis " * 5
    thread_id, _ = create_thread_with_model(client, long_prompt)

    loaded = chatkit_request(
        client,
        {"type": "threads.get_by_id", "params": {"thread_id": thread_id}},
    )
    title = loaded.json()["title"]
    assert len(title) <= 48
    assert title.endswith("\u2026")


def _proposal_principal(operation_id: str) -> Principal:
    return Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id=operation_id
    )


def test_propose_update_input_enforces_patch_mode_shape() -> None:
    base = {"document_id": "doc-1", "expected_revision_id": "rev-1", "summary": "Edit"}

    full = ProposeUpdateInput.model_validate({**base, "content": "Full text"})
    assert full.mode == "full"
    assert full.anchor is None

    deletion = ProposeUpdateInput.model_validate(
        {**base, "mode": "replace", "anchor": "gone", "content": ""}
    )
    assert deletion.content == ""

    with pytest.raises(PydanticValidationError):
        ProposeUpdateInput.model_validate({**base, "content": ""})
    with pytest.raises(PydanticValidationError):
        ProposeUpdateInput.model_validate({**base, "content": "text", "anchor": "x"})
    with pytest.raises(PydanticValidationError):
        ProposeUpdateInput.model_validate(
            {**base, "mode": "append", "anchor": "x", "content": "text"}
        )
    with pytest.raises(PydanticValidationError):
        ProposeUpdateInput.model_validate({**base, "mode": "append", "content": ""})
    with pytest.raises(PydanticValidationError):
        ProposeUpdateInput.model_validate(
            {**base, "mode": "insert_before", "anchor": "", "content": "t"}
        )
    with pytest.raises(PydanticValidationError):
        ProposeUpdateInput.model_validate(
            {**base, "mode": "insert_before", "anchor": "a", "content": "t", "replace_all": True}
        )


def test_patch_mode_replace_proposal_resolves_to_full_content(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Patch replace", "content": "alpha beta gamma"},
        headers=headers("patch-replace-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = _proposal_principal("patch-replace")
    proposals = client.app.state.services.chat.proposals

    proposal = proposals.create(
        principal,
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="delta",
        summary="Replace beta",
        mode="replace",
        anchor="beta",
    )

    assert proposal.content == "alpha delta gamma"


def test_patch_mode_replace_all_replaces_every_occurrence(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Patch replace all", "content": "one two one"},
        headers=headers("patch-replace-all-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = _proposal_principal("patch-replace-all")
    proposals = client.app.state.services.chat.proposals
    arguments: dict[str, object] = {
        "thread_id": thread_id,
        "document_id": document["document_id"],
        "expected_revision_id": document["current_revision_id"],
        "summary": "Replace every one",
        "mode": "replace",
        "anchor": "one",
        "content": "X",
    }

    with pytest.raises(ValidationError) as unique_error:
        proposals.create(principal, **arguments)
    assert unique_error.value.code == "anchor_not_unique"

    arguments["replace_all"] = True
    proposal = proposals.create(principal, **arguments)
    assert proposal.content == "X two X"


def test_patch_mode_replace_supports_pure_deletion(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Patch delete", "content": "keep cut keep"},
        headers=headers("patch-delete-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    proposal = client.app.state.services.chat.proposals.create(
        _proposal_principal("patch-delete"),
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="",
        summary="Remove the filler",
        mode="replace",
        anchor="cut ",
    )
    assert proposal.content == "keep keep"


def test_patch_mode_anchor_errors_include_hint_and_preview(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Patch missing", "content": "actual content"},
        headers=headers("patch-missing-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    proposals = client.app.state.services.chat.proposals
    principal = _proposal_principal("patch-missing")

    with pytest.raises(ValidationError) as missing_error:
        proposals.create(
            principal,
            thread_id=thread_id,
            document_id=document["document_id"],
            expected_revision_id=document["current_revision_id"],
            content="new",
            summary="Missing anchor",
            mode="replace",
            anchor="z" * 120,
        )
    assert missing_error.value.code == "anchor_not_found"
    assert "z" * 80 in missing_error.value.message
    assert "exactly" in missing_error.value.message


def test_patch_mode_insert_before_and_after_preserve_the_anchor(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Patch insert", "content": "start middle end"},
        headers=headers("patch-insert-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    proposals = client.app.state.services.chat.proposals
    principal = _proposal_principal("patch-insert")
    common = {
        "thread_id": thread_id,
        "document_id": document["document_id"],
        "expected_revision_id": document["current_revision_id"],
        "anchor": "middle",
    }

    before = proposals.create(
        principal, content="[before] ", summary="Insert before", mode="insert_before", **common
    )
    after = proposals.create(
        principal, content=" [after]", summary="Insert after", mode="insert_after", **common
    )

    assert before.content == "start [before] middle end"
    assert after.content == "start middle [after] end"


def test_append_mode_joins_with_a_single_newline_boundary(client: TestClient) -> None:
    without_newline = client.post(
        "/api/v1/documents",
        json={"title": "Append plain", "content": "first line"},
        headers=headers("append-plain-source"),
    ).json()
    with_newline = client.post(
        "/api/v1/documents",
        json={"title": "Append newline", "content": "ends with newline\n"},
        headers=headers("append-newline-source"),
    ).json()
    proposals = client.app.state.services.chat.proposals
    principal = _proposal_principal("append-mode")

    plain = proposals.create(
        principal,
        thread_id=create_thread(client, document_id=without_newline["document_id"]),
        document_id=without_newline["document_id"],
        expected_revision_id=without_newline["current_revision_id"],
        content="second line",
        summary="Append a line",
        mode="append",
    )
    joined = proposals.create(
        principal,
        thread_id=create_thread(client, document_id=with_newline["document_id"]),
        document_id=with_newline["document_id"],
        expected_revision_id=with_newline["current_revision_id"],
        content="another line",
        summary="Append another line",
        mode="append",
    )

    assert plain.content == "first line\nsecond line"
    assert joined.content == "ends with newline\nanother line"


def test_resolve_content_uses_the_pinned_historical_revision(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Pinned patch", "content": "old anchor old"},
        headers=headers("pinned-patch-source"),
    ).json()
    original_revision = document["current_revision_id"]
    client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={
            "expected_revision_id": original_revision,
            "content": "entirely different content now",
        },
        headers=headers("pinned-patch-edit"),
    )
    service = client.app.state.services.chat.proposals

    resolved = service.resolve_content(
        _proposal_principal("pinned-patch"),
        document_id=document["document_id"],
        expected_revision_id=original_revision,
        mode="replace",
        content="new",
        anchor="old",
        replace_all=True,
    )

    assert resolved == "new anchor new"


def test_full_mode_proposal_behavior_is_unchanged(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Full mode", "content": "Original evidence"},
        headers=headers("full-mode-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    proposal = client.app.state.services.chat.proposals.create(
        _proposal_principal("full-mode"),
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="Original evidence\n\nGrounded conclusion.",
        summary="Add grounded conclusion from workspace chat",
    )

    assert proposal.content == "Original evidence\n\nGrounded conclusion."


def test_read_document_paginates_by_character_offset_and_limit(
    client: TestClient,
) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Paginated read", "content": "0123456789" * 10},
        headers=headers("paginated-read-source"),
    ).json()
    token = issue_agent_token(client, capabilities=("read",))
    thread_id = create_thread(
        client,
        document_id=document["document_id"],
        Authorization=f"Bearer {token}",
    )
    principal = client.app.state.services.identity.authenticate(token, operation_id="paged-read")
    request_context = ChatRequestContext(principal=principal, document_id=document["document_id"])
    chat = client.app.state.services.chat
    thread = asyncio.run(chat.store_adapter.load_thread(thread_id, request_context))
    agent_context = AgentContext(
        thread=thread, store=chat.store_adapter, request_context=request_context
    )
    read_tool = next(tool for tool in chat.tools if tool.name == "read_document")

    def invoke(arguments: dict[str, object]) -> dict[str, object]:
        run_context = AgentsToolContext(
            context=agent_context,
            tool_name=read_tool.name,
            tool_call_id=f"call-{json.dumps(arguments, sort_keys=True)}",
            tool_arguments=json.dumps(arguments),
        )
        result = asyncio.run(read_tool.on_invoke_tool(run_context, json.dumps(arguments)))
        return json.loads(result)

    first_page = invoke(
        {
            "document_id": document["document_id"],
            "offset": 10,
            "limit": 20,
        }
    )
    last_page = invoke({"document_id": document["document_id"], "offset": 90})

    assert first_page["content"] == "01234567890123456789"
    assert first_page["offset"] == 10
    assert first_page["limit"] == 20
    assert first_page["total_chars"] == 100
    assert first_page["truncated"] is True
    assert last_page["content"] == "0123456789"
    assert last_page["offset"] == 90
    assert last_page["total_chars"] == 100
    assert last_page["truncated"] is False


def test_search_workspace_passes_pagination_and_caps_limit(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    captured: dict[str, object] = {}

    def spy(_principal: Principal, **kwargs: object) -> list[object]:
        captured.update(kwargs)
        return []

    chat = client.app.state.services.chat
    monkeypatch.setattr(chat.toolset.workspace, "search_documents", spy)
    with pytest.raises(PydanticValidationError):
        WorkspaceSearchInput.model_validate({"query": "evidence", "limit": 26})
    with pytest.raises(PydanticValidationError):
        WorkspaceSearchInput.model_validate({"query": "evidence", "offset": -1})

    token = issue_agent_token(client, capabilities=("read", "search"))
    thread_id = create_thread(client, Authorization=f"Bearer {token}")
    principal = client.app.state.services.identity.authenticate(token, operation_id="paged-search")
    request_context = ChatRequestContext(principal=principal)
    thread = asyncio.run(chat.store_adapter.load_thread(thread_id, request_context))
    agent_context = AgentContext(
        thread=thread, store=chat.store_adapter, request_context=request_context
    )
    search_tool = next(tool for tool in chat.tools if tool.name == "search_workspace")
    run_context = AgentsToolContext(
        context=agent_context,
        tool_name=search_tool.name,
        tool_call_id="call-paged-search",
        tool_arguments=json.dumps({"query": "evidence", "limit": 25, "offset": 30}),
    )
    asyncio.run(search_tool.on_invoke_tool(run_context, run_context.tool_arguments))

    assert captured["limit"] == 25
    assert captured["offset"] == 30


def test_execution_budget_defaults_support_longer_runs() -> None:
    defaults = Settings.model_fields

    assert defaults["chat_max_output_tokens"].default == 16_384
    assert defaults["chat_max_tool_rounds"].default == 24
    with pytest.raises(PydanticValidationError):
        Settings(chat_max_tool_rounds=49, chat_max_output_tokens=32_769)
