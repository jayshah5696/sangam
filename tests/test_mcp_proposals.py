"""Real proposal mutations must survive retries without chat or authority escalation.

Failure cases: stale bases, changed keys/payloads, wrong owners, revoked grants,
an interrupted apply after its revision commits, and unrelated local drafts.
"""

import json
from collections.abc import Iterator
from uuid import uuid4

import pytest
from conftest import issue_agent_token
from fastapi.testclient import TestClient
from test_mcp_assistant import output
from test_mcp_slice import execute, rpc, seed
from test_phase_seven_chat import create_thread

from sangam.api import create_app
from sangam.chat_actions import ActionDigest
from sangam.config import Settings
from sangam.db import Database, utc_now
from sangam.schemas import UpdateDocument


@pytest.fixture
def mcp_client(settings: Settings) -> Iterator[TestClient]:
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as client:
        yield client


def prepare(client: TestClient, token: str, document: dict, key: str | None = None) -> dict:
    return output(
        client,
        token,
        f"await proposals_create(document_id='{document['document_id']}', "
        f"expected_revision_id='{document['current_revision_id']}', "
        f"content='# Proposed', summary='Clarify the title', operation_key='{key or uuid4()}')",
    )


def test_external_creation_has_explicit_owner_no_chat_or_auto_apply_and_atomic_receipt(mcp_client):
    document = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read", "update"))
    services = mcp_client.app.state.services
    with services.documents.database.transaction() as connection:
        connection.execute("UPDATE chat_model_settings SET autonomy_mode='workspace' WHERE id=1")
    workspace = rpc(mcp_client, token, "present", {"document_id": document["document_id"]})[
        "structuredContent"
    ]
    key = str(uuid4())
    proposed = prepare(mcp_client, token, document, key)
    assert proposed["status"] == "pending" and proposed["conversation_id"] is None
    assert proposed["applied_revision_id"] is None
    assert prepare(mcp_client, token, document, key)["proposal_id"] == proposed["proposal_id"]
    refreshed = rpc(
        mcp_client,
        token,
        "mcp_app",
        {"action": {"type": "refresh", "workspace_id": workspace["workspace_id"]}},
    )["structuredContent"]
    assert refreshed["proposal_version"] != workspace["proposal_version"]
    with services.documents.database.connection() as connection:
        assert connection.execute("SELECT count(*) FROM chat_threads").fetchone()[0] == 0
        assert connection.execute("SELECT count(*) FROM chat_runs").fetchone()[0] == 0
        row = connection.execute("SELECT * FROM chat_proposals").fetchone()
        assert row["owner_actor_id"] == "agent:cli" and row["execution_key"]
        assert connection.execute("SELECT count(*) FROM chat_proposals").fetchone()[0] == 1
    assert (
        mcp_client.get(f"/api/v1/documents/{document['document_id']}").json()["content"]
        == document["content"]
    )
    changed = execute(
        mcp_client,
        token,
        f"await proposals_create(document_id='{document['document_id']}', "
        f"expected_revision_id='{document['current_revision_id']}', content='Different', "
        f"summary='Clarify the title', operation_key='{key}')",
    )
    assert changed.get("isError")


def test_apply_commits_reviewed_wording_once_and_recovers_after_lost_completion(
    mcp_client, monkeypatch
):
    document = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read", "update"))
    proposed = prepare(mcp_client, token, document)
    service = mcp_client.app.state.services.chat.proposals
    mark_applied = service.repository.mark_applied

    def interrupted(*args, **kwargs):
        raise RuntimeError("Lost completion after canonical document commit")

    monkeypatch.setattr(service.repository, "mark_applied", interrupted)
    operation_key, execution_key = str(uuid4()), str(uuid4())
    code = (
        f"await proposals_apply(proposal_id='{proposed['proposal_id']}', "
        f"expected_revision_id='{document['current_revision_id']}', "
        f"content='# Reviewed wording', operation_key='{operation_key}')"
    )
    failed = execute(mcp_client, token, code, execution_key)
    assert failed.get("isError")
    saved = mcp_client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert saved["content"] == "# Reviewed wording"
    receipt = output(mcp_client, token, f"await executions_get(execution_key='{execution_key}')")
    assert receipt["writes"][0]["outcome"] == "committed"
    assert receipt["writes"][0]["revision_id"] == saved["current_revision_id"]
    monkeypatch.setattr(service.repository, "mark_applied", mark_applied)
    applied = output(mcp_client, token, code)
    assert applied["applied_revision_id"] == saved["current_revision_id"]
    assert output(mcp_client, token, code)["applied_revision_id"] == saved["current_revision_id"]
    assert execute(mcp_client, token, code.replace("# Reviewed wording", "Wrong retry")).get(
        "isError"
    )
    history = mcp_client.get(f"/api/v1/documents/{document['document_id']}/history").json()
    assert len(history) == 2
    assert prepare(mcp_client, token, document, proposed["operation_key"])["status"] == "applied"


def test_dismissal_and_apply_enforce_ownership_current_grants_and_stale_base(mcp_client):
    document = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read", "update"))
    proposed = prepare(mcp_client, token, document)
    other = issue_agent_token(
        mcp_client, actor_id="agent:stranger", capabilities=("read", "update")
    )
    read_only = issue_agent_token(mcp_client, capabilities=("read",))
    apply = (
        f"await proposals_apply(proposal_id='{proposed['proposal_id']}', "
        f"expected_revision_id='{document['current_revision_id']}', "
        f"content='# Reviewed', operation_key='{uuid4()}')"
    )
    dismiss = (
        f"await proposals_dismiss(proposal_id='{proposed['proposal_id']}', "
        f"reason='No longer needed', operation_key='{uuid4()}')"
    )
    assert execute(mcp_client, other, apply).get("isError")
    assert execute(mcp_client, other, dismiss).get("isError")
    assert execute(mcp_client, read_only, apply).get("isError")
    mcp_client.patch(
        f"/api/v1/documents/{document['document_id']}",
        headers={"Idempotency-Key": str(uuid4())},
        json={
            "expected_revision_id": document["current_revision_id"],
            "content": "New human revision",
        },
    ).raise_for_status()
    assert execute(mcp_client, token, apply).get("isError")
    assert output(mcp_client, read_only, dismiss)["status"] == "dismissed"
    assert output(mcp_client, read_only, dismiss)["status"] == "dismissed"
    assert execute(
        mcp_client, read_only, dismiss.replace("No longer needed", "Changed reason")
    ).get("isError")
    assert (
        mcp_client.get(f"/api/v1/documents/{document['document_id']}").json()["content"]
        == "New human revision"
    )


def test_app_cannot_apply_around_an_existing_workspace_draft(mcp_client):
    document = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read", "update"))
    proposed = prepare(mcp_client, token, document)
    workspace = rpc(mcp_client, token, "present", {"document_id": document["document_id"]})[
        "structuredContent"
    ]
    rpc(
        mcp_client,
        token,
        "mcp_app",
        {
            "action": {
                "type": "checkpoint",
                "workspace_id": workspace["workspace_id"],
                "expected_version": workspace["version"],
                "content": "Unsaved human draft",
            }
        },
    )
    response = rpc(
        mcp_client,
        token,
        "mcp_app",
        {
            "action": {
                "type": "proposal_apply",
                "workspace_id": workspace["workspace_id"],
                "proposal_id": proposed["proposal_id"],
                "expected_revision_id": document["current_revision_id"],
                "content": "# Reviewed",
                "operation_key": str(uuid4()),
            }
        },
    )
    assert response.get("isError")
    assert (
        mcp_client.get(f"/api/v1/documents/{document['document_id']}").json()["content"]
        == document["content"]
    )


def test_schema_043_upgrade_preserves_proposals_and_reserved_apply_recovery(settings, monkeypatch):
    inventory = Database._migration_inventory()
    settings.mcp_enabled = True
    with monkeypatch.context() as legacy:
        legacy.setattr(
            Database,
            "_migration_inventory",
            staticmethod(lambda: [m for m in inventory if m.version < "044"]),
        )
        with TestClient(create_app(settings)) as client:
            document = seed(client)
            token = issue_agent_token(client, capabilities=("read", "update"))
            services = client.app.state.services
            principal = services.identity.authenticate(token, operation_id="legacy-apply")
            thread_id = create_thread(client, Authorization=f"Bearer {token}")
            proposal_id = str(uuid4())
            context = services.chat.proposals.evidence.create_turn_context(
                principal,
                entry_point="document",
                document_id=document["document_id"],
                revision_id=document["current_revision_id"],
                selected_text="Original",
            )
            # Seed the actual old-schema reservation and its canonical committed revision.
            services.workspace_access.write_document(
                principal,
                document_id=document["document_id"],
                action="update",
                body=UpdateDocument(
                    expected_revision_id=document["current_revision_id"],
                    content="Legacy reviewed wording",
                    summary="Legacy proposal",
                ),
                idempotency_key="legacy-apply",
            )
            with services.documents.database.connection() as connection:
                connection.execute(
                    "INSERT INTO chat_proposals (proposal_id, thread_id, document_id, "
                    "expected_revision_id, content, summary, status, created_at, "
                    "apply_idempotency_key, apply_payload_digest, apply_actor_id, "
                    "reviewed_content, context_id, citations_json, rationale) "
                    "VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        proposal_id,
                        thread_id,
                        document["document_id"],
                        document["current_revision_id"],
                        "Legacy suggested wording",
                        "Legacy proposal",
                        utc_now(),
                        "legacy-apply",
                        ActionDigest.compute("Legacy reviewed wording"),
                        principal.actor_id,
                        "Legacy reviewed wording",
                        context.context_id,
                        json.dumps(
                            [
                                {
                                    "document_id": document["document_id"],
                                    "revision_id": document["current_revision_id"],
                                    "snippet": "Original",
                                    "available": True,
                                }
                            ]
                        ),
                        "Preserved legacy rationale",
                    ),
                )
                connection.commit()
                before = dict(
                    connection.execute(
                        "SELECT * FROM chat_proposals WHERE proposal_id=?", (proposal_id,)
                    ).fetchone()
                )
    with TestClient(create_app(settings)) as client:
        with client.app.state.services.documents.database.connection() as connection:
            after = dict(
                connection.execute(
                    "SELECT * FROM chat_proposals WHERE proposal_id=?", (proposal_id,)
                ).fetchone()
            )
            assert all(after[key] == value for key, value in before.items())
            assert after["owner_actor_id"] == principal.actor_id
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
        recovered = output(
            client,
            token,
            f"await proposals_apply(proposal_id='{proposal_id}', "
            f"expected_revision_id='{document['current_revision_id']}', "
            "content='Legacy reviewed wording', operation_key='legacy-apply')",
        )
        assert recovered["status"] == "applied"
        assert recovered["applied_revision_id"]
        inspected = output(
            client,
            token,
            f"await proposals_get(proposal_id='{proposal_id}', include_evidence=True)",
        )
        assert inspected["evidence"]["context_id"] == context.context_id
        assert inspected["evidence"]["selected_text"] == "Original"
        assert inspected["citations"][0]["snippet"] == "Original"
        assert inspected["citations"][0]["available"] is True
