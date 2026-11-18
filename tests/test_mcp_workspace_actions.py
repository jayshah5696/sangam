"""Creation and App assistant failure cases, specified before implementation.

Real broker/services must reject denied destinations and changed keys, preserve
creation evidence after commit, pin selection/tab sources, retain accepted work
after a lost response, and deny results after any included source loses access.
"""

import asyncio
import json
from collections.abc import Iterator
from uuid import uuid4

import pytest
from agents.models.interface import ModelProvider
from conftest import issue_agent_token
from fastapi.testclient import TestClient
from test_mcp_assistant import output
from test_mcp_slice import app_action, execute, rpc, seed
from test_phase_five_pdf_research import import_pdf, text_pdf
from test_phase_seven_chat import _RecordingResponsesModel, create_thread, install_fake_model

from sangam.api import create_app
from sangam.config import Settings
from sangam.db import Database, utc_now
from sangam.idempotency import request_hash


@pytest.fixture
def mcp_client(settings: Settings) -> Iterator[TestClient]:
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as client:
        yield client


def create_code(key: str, path: str = "mcp/created.md") -> str:
    return (
        "await documents_create(title='Created through MCP', content='# New document', "
        f"path='{path}', operation_key='{key}')"
    )


def test_creation_replay_reports_original_revision_after_later_edits(mcp_client):
    token = issue_agent_token(
        mcp_client, capabilities=("read", "create", "update"), path_prefix="mcp/"
    )
    key = str(uuid4())
    created = output(mcp_client, token, create_code(key))
    assert created["created_revision_id"] == created["current_revision_id"]
    edited = mcp_client.patch(
        f"/api/v1/documents/{created['document_id']}",
        headers={"Idempotency-Key": str(uuid4())},
        json={"expected_revision_id": created["created_revision_id"], "content": "Later edit"},
    )
    edited.raise_for_status()
    replay = output(mcp_client, token, create_code(key))
    assert replay["document_id"] == created["document_id"]
    assert replay["created_revision_id"] == created["created_revision_id"]
    assert replay["current_revision_id"] == edited.json()["current_revision_id"]
    assert execute(mcp_client, token, create_code(key).replace("# New document", "Changed")).get(
        "isError"
    )
    denied = issue_agent_token(mcp_client, capabilities=("read", "update"))
    assert execute(mcp_client, denied, create_code(str(uuid4()), "mcp/denied.md")).get("isError")
    assert execute(mcp_client, token, create_code(str(uuid4()), "private/denied.md")).get("isError")
    creator = issue_agent_token(mcp_client, capabilities=("create",))
    assert output(mcp_client, creator, create_code(str(uuid4()), "mcp/create-only.md"))[
        "created_revision_id"
    ]


def test_creation_commit_is_recoverable_when_service_response_is_lost(mcp_client, monkeypatch):
    token = issue_agent_token(mcp_client, capabilities=("read", "create"))
    access = mcp_client.app.state.services.workspace_access
    original = access.create_document

    def lose_response(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("Lost result after canonical creation")

    monkeypatch.setattr(access, "create_document", lose_response)
    key, execution_key = str(uuid4()), str(uuid4())
    failed = execute(mcp_client, token, create_code(key), execution_key)
    assert failed.get("isError")
    receipt = output(mcp_client, token, f"await executions_get(execution_key='{execution_key}')")
    write = receipt["writes"][0]
    assert write["outcome"] == "committed"
    assert write["document_id"] and write["revision_id"]
    monkeypatch.setattr(access, "create_document", original)
    recovered = output(mcp_client, token, create_code(key))
    assert recovered["document_id"] == write["document_id"]
    assert recovered["created_revision_id"] == write["revision_id"]
    history = mcp_client.get(f"/api/v1/documents/{write['document_id']}/history")
    assert len(history.json()) == 1


def test_app_creation_uses_current_permissions_and_preserves_outgoing_draft(mcp_client):
    source = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read", "create", "update"))
    workspace = rpc(mcp_client, token, "present", {"document_id": source["document_id"]})[
        "structuredContent"
    ]
    checkpoint = app_action(
        mcp_client,
        token,
        {
            "type": "checkpoint",
            "workspace_id": workspace["workspace_id"],
            "expected_version": workspace["version"],
            "content": "Recover this draft",
        },
    )["structuredContent"]
    action = {
        "type": "document_create",
        "workspace_id": workspace["workspace_id"],
        "title": "App created",
        "content": "Created in the App",
        "path": "mcp/app.md",
        "operation_key": str(uuid4()),
    }
    result = app_action(mcp_client, token, action)
    assert not result.get("isError"), result
    created = result["structuredContent"]
    assert app_action(mcp_client, token, action)["structuredContent"] == created
    opened = app_action(
        mcp_client,
        token,
        {
            "type": "open",
            "workspace_id": workspace["workspace_id"],
            "expected_layout_version": checkpoint["layout"]["version"],
            "document_id": created["document_id"],
        },
    )["structuredContent"]
    assert len(opened["layout"]["tabs"]) == 2
    restored = app_action(
        mcp_client, token, {"type": "refresh", "workspace_id": workspace["workspace_id"]}
    )["structuredContent"]
    assert restored["draft"] == "Recover this draft"
    assert (
        mcp_client.get(f"/api/v1/documents/{source['document_id']}").json()["content"]
        == source["content"]
    )
    other = issue_agent_token(mcp_client, actor_id="agent:other", capabilities=("read", "create"))
    assert app_action(mcp_client, other, {**action, "operation_key": str(uuid4())}).get("isError")


def test_app_assistant_pins_context_replays_acceptance_and_recovers_owned_thread(mcp_client):
    captured = install_fake_model(mcp_client, ["First App answer", "Follow-up App answer"])
    source, companion = seed(mcp_client), seed(mcp_client, "mcp/companion.md")
    token = issue_agent_token(mcp_client, capabilities=("read", "update", "inference"))
    workspace = rpc(
        mcp_client,
        token,
        "present",
        {
            "document_id": source["document_id"],
            "additional_document_ids": [companion["document_id"]],
        },
    )["structuredContent"]
    action = {
        "type": "assistant_submit",
        "workspace_id": workspace["workspace_id"],
        "request_key": str(uuid4()),
        "message": "Explain these sources",
        "wait_seconds": 2,
        "document_id": source["document_id"],
        "revision_id": source["current_revision_id"],
        "selection_text": "Findable sangamneedle.",
        "context_documents": [
            {
                "document_id": companion["document_id"],
                "revision_id": companion["current_revision_id"],
            }
        ],
    }
    reply = app_action(mcp_client, token, action)
    assert not reply.get("isError"), reply
    first = reply["structuredContent"]
    assert first["status"] == "completed" and first["answer"] == "First App answer"
    assert app_action(mcp_client, token, action)["structuredContent"] == first
    checkpoint_reply = app_action(
        mcp_client,
        token,
        {
            "type": "checkpoint",
            "workspace_id": workspace["workspace_id"],
            "expected_version": workspace["version"],
            "content": "New unsaved draft after acceptance",
        },
    )
    assert not checkpoint_reply.get("isError"), checkpoint_reply
    checkpoint = checkpoint_reply["structuredContent"]
    assert app_action(mcp_client, token, action)["structuredContent"] == first
    app_action(
        mcp_client,
        token,
        {
            "type": "discard",
            "workspace_id": workspace["workspace_id"],
            "expected_version": checkpoint["version"],
        },
    )
    assert len(captured) == 1
    assert companion["current_revision_id"] in json.dumps(captured)
    with mcp_client.app.state.services.documents.database.connection() as connection:
        row = connection.execute(
            "SELECT * FROM assistant_requests WHERE request_key=?", (action["request_key"],)
        ).fetchone()
        assert row["workspace_id"] == workspace["workspace_id"]
        assert companion["document_id"] in row["context_json"]
        context = connection.execute(
            "SELECT * FROM chat_turn_contexts WHERE thread_id=?", (first["conversation_id"],)
        ).fetchone()
        assert context["selection_text"] == action["selection_text"]
        assert context["revision_id"] == source["current_revision_id"]
    restored = app_action(
        mcp_client, token, {"type": "refresh", "workspace_id": workspace["workspace_id"]}
    )["structuredContent"]
    assert restored["assistant_request_key"] == action["request_key"]
    follow = {
        **action,
        "request_key": str(uuid4()),
        "message": "Continue",
        "conversation_id": first["conversation_id"],
    }
    second = app_action(mcp_client, token, follow)["structuredContent"]
    assert second["answer"] == "Follow-up App answer"
    assert second["conversation_id"] == first["conversation_id"]
    reader = issue_agent_token(mcp_client, capabilities=("read",))
    query = {
        "type": "assistant_get",
        "workspace_id": workspace["workspace_id"],
        "request_key": follow["request_key"],
    }
    assert (
        app_action(mcp_client, reader, query)["structuredContent"]["answer"]
        == "Follow-up App answer"
    )
    assert app_action(mcp_client, reader, {**follow, "request_key": str(uuid4())}).get("isError")
    messages = app_action(
        mcp_client,
        reader,
        {
            "type": "assistant_messages",
            "workspace_id": workspace["workspace_id"],
            "conversation_id": first["conversation_id"],
        },
    )["structuredContent"]
    assert len(messages["items"]) == 4
    assert "First App answer" in json.dumps(captured[-1])
    stranger = issue_agent_token(mcp_client, actor_id="agent:stranger", capabilities=("read",))
    assert app_action(mcp_client, stranger, query).get("isError")


def test_unread_tab_context_is_still_an_authorization_dependency(mcp_client):
    install_fake_model(mcp_client, ["An answer without tool reads"])
    source, hidden = seed(mcp_client, "mcp/a/doc.md"), seed(mcp_client, "mcp/b/doc.md")
    token = issue_agent_token(mcp_client, capabilities=("read", "inference"))
    workspace = rpc(
        mcp_client,
        token,
        "present",
        {"document_id": source["document_id"], "additional_document_ids": [hidden["document_id"]]},
    )["structuredContent"]
    action = {
        "type": "assistant_submit",
        "workspace_id": workspace["workspace_id"],
        "request_key": str(uuid4()),
        "message": "Consider both references",
        "document_id": source["document_id"],
        "revision_id": source["current_revision_id"],
        "context_documents": [
            {"document_id": hidden["document_id"], "revision_id": hidden["current_revision_id"]}
        ],
        "wait_seconds": 2,
    }
    result = app_action(mcp_client, token, action)["structuredContent"]
    assert result["answer"] == "An answer without tool reads"
    narrower = issue_agent_token(mcp_client, capabilities=("read",), path_prefix="mcp/a/")
    assert app_action(
        mcp_client,
        narrower,
        {
            "type": "assistant_get",
            "workspace_id": workspace["workspace_id"],
            "request_key": action["request_key"],
        },
    ).get("isError")
    refreshed = app_action(
        mcp_client, narrower, {"type": "refresh", "workspace_id": workspace["workspace_id"]}
    )["structuredContent"]
    assert refreshed["assistant_request_key"] is None
    assert refreshed["assistant_unavailable"] is True
    assert execute(
        mcp_client,
        narrower,
        f"await conversations_read(conversation_id='{result['conversation_id']}')",
    ).get("isError")


def test_app_assistant_rejects_draft_selection_and_outside_layout_context(mcp_client):
    captured = install_fake_model(mcp_client, ["Must not run"])
    source, outside = seed(mcp_client), seed(mcp_client, "mcp/outside.md")
    token = issue_agent_token(mcp_client, capabilities=("read", "update", "inference"))
    workspace = rpc(mcp_client, token, "present", {"document_id": source["document_id"]})[
        "structuredContent"
    ]
    action = {
        "type": "assistant_submit",
        "workspace_id": workspace["workspace_id"],
        "request_key": str(uuid4()),
        "message": "Explain",
        "document_id": source["document_id"],
        "revision_id": source["current_revision_id"],
        "context_documents": [
            {"document_id": outside["document_id"], "revision_id": outside["current_revision_id"]}
        ],
    }
    denied = app_action(mcp_client, token, action)
    assert denied["isError"] and denied["structuredContent"]["mutation"]["outcome"] == "rejected"
    app_action(
        mcp_client,
        token,
        {
            "type": "checkpoint",
            "workspace_id": workspace["workspace_id"],
            "expected_version": workspace["version"],
            "content": "Unsaved selection",
        },
    )
    denied = app_action(
        mcp_client,
        token,
        {**action, "context_documents": [], "selection_text": "Unsaved selection"},
    )
    assert denied["isError"] and denied["structuredContent"]["mutation"]["outcome"] == "rejected"
    assert captured == []
    assert (
        mcp_client.get(f"/api/v1/documents/{source['document_id']}").json()["content"]
        == source["content"]
    )
    invalid_path = app_action(
        mcp_client,
        token,
        {
            "type": "document_create",
            "workspace_id": workspace["workspace_id"],
            "title": "Invalid",
            "content": "",
            "path": "../outside.md",
            "operation_key": str(uuid4()),
        },
    )
    assert (
        invalid_path["isError"]
        and invalid_path["structuredContent"]["mutation"]["outcome"] == "rejected"
    )


def test_app_can_cancel_a_real_accepted_inference_without_replaying_it(mcp_client):
    install_fake_model(mcp_client, ["unused"])
    started, finish = asyncio.Event(), asyncio.Event()
    captured = []

    class HeldModel(_RecordingResponsesModel):
        async def stream_response(self, *args, **kwargs):
            started.set()
            await finish.wait()
            async for event in super().stream_response(*args, **kwargs):
                yield event

    class Provider(ModelProvider):
        def get_model(self, model_name):
            return HeldModel("No completion expected", captured)

    mcp_client.app.state.services.provider_connections.model_provider = lambda _connection_id: (
        Provider()
    )
    source = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read", "inference"))
    workspace = rpc(mcp_client, token, "present", {"document_id": source["document_id"]})[
        "structuredContent"
    ]
    action = {
        "type": "assistant_submit",
        "workspace_id": workspace["workspace_id"],
        "request_key": str(uuid4()),
        "message": "Wait",
        "document_id": source["document_id"],
        "revision_id": source["current_revision_id"],
    }
    accepted = app_action(mcp_client, token, action)["structuredContent"]
    assert accepted["status"] == "running"
    mcp_client.portal.call(asyncio.wait_for, started.wait(), 2)
    reader = issue_agent_token(mcp_client, capabilities=("read",))
    cancelled = app_action(
        mcp_client,
        reader,
        {
            "type": "assistant_cancel",
            "workspace_id": workspace["workspace_id"],
            "request_key": action["request_key"],
        },
    )["structuredContent"]
    assert cancelled["status"] == "cancelled"
    assert app_action(mcp_client, token, action)["structuredContent"]["status"] == "cancelled"
    with mcp_client.app.state.services.documents.database.connection() as connection:
        assert connection.execute("SELECT count(*) FROM assistant_requests").fetchone()[0] == 1


def test_app_pdf_assistant_context_records_page_without_changing_source_bytes(mcp_client):
    install_fake_model(mcp_client, ["PDF context answer"])
    original = text_pdf("A selected PDF passage")
    imported = import_pdf(mcp_client, content=original, key=str(uuid4()), path="mcp/context.pdf")
    imported.raise_for_status()
    source = imported.json()
    token = issue_agent_token(mcp_client, capabilities=("read", "inference"))
    workspace = rpc(mcp_client, token, "present", {"document_id": source["document_id"]})[
        "structuredContent"
    ]
    reply = app_action(
        mcp_client,
        token,
        {
            "type": "assistant_submit",
            "workspace_id": workspace["workspace_id"],
            "request_key": str(uuid4()),
            "message": "Explain this passage",
            "document_id": source["document_id"],
            "revision_id": source["current_revision_id"],
            "pdf_page_number": 1,
            "selection_text": "A selected PDF passage",
            "wait_seconds": 2,
        },
    )
    assert not reply.get("isError"), reply
    assert reply["structuredContent"]["answer"] == "PDF context answer"
    with mcp_client.app.state.services.documents.database.connection() as connection:
        context = connection.execute(
            "SELECT pdf_page_number,selection_text,revision_id "
            "FROM chat_turn_contexts WHERE thread_id=?",
            (reply["structuredContent"]["conversation_id"],),
        ).fetchone()
        assert tuple(context) == (1, "A selected PDF passage", source["current_revision_id"])
    assert mcp_client.get(f"/api/v1/pdfs/{source['document_id']}/content").content == original
    assert (
        mcp_client.get(f"/api/v1/documents/{source['document_id']}").json()["current_revision_id"]
        == source["current_revision_id"]
    )


def test_schema_044_upgrade_preserves_old_acceptance_hash_and_write_evidence(settings, monkeypatch):
    settings.mcp_enabled = True
    inventory = Database._migration_inventory()
    key = str(uuid4())
    with monkeypatch.context() as legacy:
        legacy.setattr(
            Database,
            "_migration_inventory",
            staticmethod(
                lambda: [migration for migration in inventory if migration.version < "045"]
            ),
        )
        with TestClient(create_app(settings)) as client:
            source = seed(client)
            token = issue_agent_token(client, capabilities=("read", "update", "inference"))
            thread_id = create_thread(client, Authorization=f"Bearer {token}")
            old_arguments = {
                "message": "Legacy request",
                "conversation_id": thread_id,
                "document_id": source["document_id"],
                "revision_id": source["current_revision_id"],
            }
            output(
                client,
                token,
                f"await documents_update(document_id='{source['document_id']}', "
                f"expected_revision_id='{source['current_revision_id']}', "
                "content='Legacy edit', operation_key='legacy-write')",
            )
            with client.app.state.services.documents.database.transaction() as connection:
                connection.execute(
                    "INSERT INTO assistant_requests(actor_id,request_key,request_hash,"
                    "conversation_id,document_id,status,answer,created_at,finished_at) "
                    "VALUES(?,?,?,?,?,'completed',?,?,?)",
                    (
                        "agent:cli",
                        key,
                        request_hash(old_arguments),
                        thread_id,
                        source["document_id"],
                        "Legacy answer",
                        utc_now(),
                        utc_now(),
                    ),
                )
                write = dict(
                    connection.execute(
                        "SELECT * FROM mcp_execution_writes WHERE operation_key='legacy-write'"
                    ).fetchone()
                )
    with TestClient(create_app(settings)) as client:
        captured = install_fake_model(client, ["No inference replay"])
        result = output(
            client,
            token,
            f"await assistant_submit(request_key='{key}', message='Legacy request', "
            f"conversation_id='{thread_id}', document_id='{source['document_id']}', "
            f"revision_id='{source['current_revision_id']}')",
        )
        assert result["answer"] == "Legacy answer" and captured == []
        with client.app.state.services.documents.database.connection() as connection:
            current = dict(
                connection.execute(
                    "SELECT * FROM mcp_execution_writes WHERE operation_key='legacy-write'"
                ).fetchone()
            )
            assert current == write
            row = connection.execute(
                "SELECT workspace_id,context_json FROM assistant_requests WHERE request_key=?",
                (key,),
            ).fetchone()
            assert row["workspace_id"] is None and row["context_json"] == "[]"
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
