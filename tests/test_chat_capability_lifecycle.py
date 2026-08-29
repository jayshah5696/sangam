from __future__ import annotations

import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from conftest import headers
from fastapi.testclient import TestClient
from pydantic import ValidationError as PydanticValidationError
from pypdf import PdfWriter
from test_phase_seven_chat import install_fake_model

from sangam.capabilities import Capability
from sangam.chat_capabilities import CreateDocumentInput, WorkspaceSearchInput
from sangam.errors import AuthorizationError, ValidationError
from sangam.security import Principal, ScopeGrant


def create_chat_thread(client: TestClient, *, document_id: str | None = None) -> str:
    request_headers = {"X-Sangam-Document-ID": document_id} if document_id else {}
    response = client.post(
        "/api/v1/chatkit",
        json={
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": "Prepare the effect"}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                }
            },
        },
        headers=request_headers,
    )
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    return next(event["thread"]["id"] for event in events if event["type"] == "thread.created")


def prepare_effect(
    client: TestClient,
    *,
    capability_id: str,
    arguments: dict[str, object],
    preview: dict[str, object] | None = None,
    tool_call_id: str = "call_effect",
):
    chat = client.app.state.services.chat
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="effect-lifecycle"
    )
    document_id = arguments.get("document_id")
    thread_id = create_chat_thread(
        client, document_id=document_id if isinstance(document_id, str) else None
    )
    turn = chat.evidence.create_turn_context(
        principal,
        entry_point="document" if document_id else "workspace",
        document_id=document_id if isinstance(document_id, str) else None,
        revision_id=None,
        selected_text="",
    )
    capability = chat.capabilities.get(capability_id)
    manifest = (capability.manifest_item(),)
    turn = chat.evidence.attach_turn_context(
        principal,
        context_id=turn.context_id,
        thread_id=thread_id,
        user_item_id=f"item_{tool_call_id}",
        model_ref="openrouter::openai/gpt-5.4-nano",
        capability_manifest=manifest,
    )
    run_id = chat.evidence.begin_run(
        principal,
        thread_id=thread_id,
        user_item_id=turn.user_item_id,
        context_id=turn.context_id,
        connection_id="openrouter",
        model_ref="openrouter::openai/gpt-5.4-nano",
        capability_manifest=manifest,
    )
    effect = chat.effects.propose(
        principal,
        run_id=run_id,
        thread_id=thread_id,
        tool_call_id=tool_call_id,
        capability=capability,
        arguments=arguments,
        preview=preview or arguments,
    )
    return SimpleNamespace(
        chat=chat,
        principal=principal,
        thread_id=thread_id,
        run_id=run_id,
        effect=effect,
        capability=capability,
    )


def set_chat_autonomy(client: TestClient, mode: str) -> None:
    current = client.get("/api/v1/chat/models").json()
    response = client.put(
        "/api/v1/chat/models",
        json={
            "expected_version": current["version"],
            "workspace_enabled": current["workspace_enabled"],
            "default_model": current["default_model"],
            "enabled_models": current["enabled_models"],
            "unknown_model_overrides": [],
            "autonomy_mode": mode,
        },
    )
    assert response.status_code == 200, response.text


def test_turn_context_captures_selection_and_run_manifest(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Context", "content": "Alpha selected evidence", "path": "context.md"},
        headers=headers("context-document"),
    ).json()
    context_response = client.post(
        "/api/v1/chat/contexts",
        json={
            "entry_point": "document",
            "document_id": document["document_id"],
            "revision_id": document["current_revision_id"],
            "selected_text": "selected evidence",
        },
    )
    assert context_response.status_code == 201
    context_id = context_response.json()["context_id"]
    install_fake_model(client, ["Selection reviewed"])

    response = client.post(
        "/api/v1/chatkit",
        json={
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": "Review the selection"}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                }
            },
        },
        headers={"X-Sangam-Context-ID": context_id, "X-Sangam-Chat-Entry": "document"},
    )
    assert response.status_code == 200
    chat = client.app.state.services.chat
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="context-assertion"
    )
    context = chat.evidence.get_turn_context(principal, context_id)
    assert context.selection_text == "selected evidence"
    assert context.document_id == document["document_id"]
    assert context.revision_id == document["current_revision_id"]
    assert context.model_ref == "openrouter::openai/gpt-5.4-nano"
    assert {item["id"] for item in context.capability_manifest} >= {
        "get_editor_selection",
        "read_document",
        "propose_update",
    }
    with chat.evidence.database.connection() as connection:
        run = connection.execute(
            "SELECT status, capability_manifest_json FROM chat_runs WHERE context_id = ?",
            (context_id,),
        ).fetchone()
    assert run is not None
    assert run["status"] == "completed"
    assert "publish_document" in run["capability_manifest_json"]


def test_turn_context_captures_pdf_page_and_annotation(client: TestClient) -> None:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    writer.write(output)
    imported = client.post(
        "/api/v1/pdfs",
        params={"title": "Pinned PDF", "path": "research/pinned.pdf"},
        content=output.getvalue(),
        headers={**headers("context-pdf"), "Content-Type": "application/pdf"},
    )
    assert imported.status_code == 201, imported.text
    document = imported.json()
    annotation = client.post(
        f"/api/v1/pdfs/{document['document_id']}/annotations",
        json={
            "page_number": 1,
            "annotation_type": "page_note",
            "selected_text": "",
            "note": "Pinned note",
            "geometry": [],
            "tags": [],
            "color": "#F0C75E",
        },
        headers=headers("context-annotation"),
    )
    assert annotation.status_code == 201, annotation.text

    response = client.post(
        "/api/v1/chat/contexts",
        json={
            "entry_point": "document",
            "document_id": document["document_id"],
            "revision_id": document["current_revision_id"],
            "pdf_page_number": 1,
            "annotation_id": annotation.json()["annotation_id"],
            "selected_text": "",
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["pdf_page_number"] == 1
    assert response.json()["annotation_id"] == annotation.json()["annotation_id"]


def test_registry_filters_authority_and_rejects_extra_tool_arguments(client: TestClient) -> None:
    chat = client.app.state.services.chat
    principal = Principal(
        actor_id="agent:reader",
        display_name="Reader",
        identity_kind="agent",
        operation_id="capability-filter",
        scopes=(
            ScopeGrant(Capability.READ, "research"),
            ScopeGrant(Capability.SEARCH, "research"),
        ),
    )
    document = SimpleNamespace(path="research/note.md", content_type="text/markdown")
    resolved = chat.capabilities.resolve(
        principal=principal,
        policy=chat.workspace.policy,
        entry_point="document",
        document=document,
        model_supports_tools=True,
    )
    assert {capability.capability_id for capability in resolved} == {
        "get_editor_selection",
        "search_workspace",
        "inspect_workspace_organization",
        "read_document",
    }
    with pytest.raises(PydanticValidationError):
        WorkspaceSearchInput.model_validate({"query": "evidence", "unexpected": True})


def test_adversarial_corpus_has_deterministic_policy_outcomes(client: TestClient) -> None:
    cases = json.loads(
        (Path(__file__).parent / "fixtures" / "chat_adversarial_cases.json").read_text()
    )
    assert {case["source"] for case in cases} == {
        "document",
        "pdf",
        "annotation",
        "karakeep",
        "tool_result",
        "approval",
    }
    assert {case["expected"] for case in cases} <= {
        "bounded_data",
        "unavailable_capability",
        "exact_approval",
        "reviewable_proposal",
        "deterministic_denial",
    }
    capability_ids = set(client.app.state.services.chat.capabilities.by_id)
    assert capability_ids.isdisjoint(
        {"shell", "execute_command", "http", "fetch_url", "filesystem", "sql", "credentials"}
    )


def test_effect_preview_cannot_hide_or_change_material_arguments(client: TestClient) -> None:
    prepared = prepare_effect(
        client,
        capability_id="create_document",
        arguments={"title": "Visible", "content": "Exact", "content_type": "text/markdown"},
        tool_call_id="call_visible",
    )
    with pytest.raises(ValidationError, match="every material argument"):
        prepared.chat.effects.propose(
            prepared.principal,
            run_id=prepared.run_id,
            thread_id=prepared.thread_id,
            tool_call_id="call_hidden",
            capability=prepared.capability,
            arguments={"title": "Hidden", "content": "Exact", "content_type": "text/markdown"},
            preview={"title": "Visible", "content": "Exact", "content_type": "text/markdown"},
        )
    changed_arguments = {
        "title": "Changed",
        "content": "Exact",
        "content_type": "text/markdown",
    }
    changed = prepared.chat.effects.propose(
        prepared.principal,
        run_id=prepared.run_id,
        thread_id=prepared.thread_id,
        tool_call_id="call_visible",
        capability=prepared.capability,
        arguments=changed_arguments,
        preview=changed_arguments,
    )
    assert changed.effect_id != prepared.effect.effect_id
    assert changed.argument_digest != prepared.effect.argument_digest


def test_effect_approval_is_digest_bound_idempotent_and_reloadable(client: TestClient) -> None:
    prepared = prepare_effect(
        client,
        capability_id="create_document",
        arguments={
            "title": "Approved note",
            "content": "# Durable",
            "content_type": "text/markdown",
        },
    )
    duplicate = prepared.chat.effects.propose(
        prepared.principal,
        run_id=prepared.run_id,
        thread_id=prepared.thread_id,
        tool_call_id="call_effect",
        capability=prepared.capability,
        arguments={
            "title": "Approved note",
            "content": "# Durable",
            "content_type": "text/markdown",
        },
        preview={"title": "Approved note", "content": "# Durable", "content_type": "text/markdown"},
    )
    assert duplicate.effect_id == prepared.effect.effect_id

    pending = client.get(
        "/api/v1/chat/effects",
        params={"thread_id": prepared.thread_id, "status": "pending_approval"},
    ).json()
    assert [effect["effect_id"] for effect in pending] == [prepared.effect.effect_id]
    mismatch = client.post(
        f"/api/v1/chat/effects/{prepared.effect.effect_id}/decision",
        json={"verdict": "approve", "argument_digest": "0" * 64, "reason": None},
    )
    assert mismatch.status_code == 409
    assert client.get("/api/v1/documents").json() == []

    decision = client.post(
        f"/api/v1/chat/effects/{prepared.effect.effect_id}/decision",
        json={
            "verdict": "approve",
            "argument_digest": prepared.effect.argument_digest,
            "reason": None,
        },
    )
    assert decision.status_code == 200
    assert decision.json()["effect"]["status"] == "completed"
    document_id = decision.json()["client_result"]["document_id"]
    repeated = client.post(
        f"/api/v1/chat/effects/{prepared.effect.effect_id}/decision",
        json={
            "verdict": "approve",
            "argument_digest": prepared.effect.argument_digest,
            "reason": None,
        },
    )
    assert repeated.status_code == 200
    assert repeated.json()["client_result"]["document_id"] == document_id
    assert len(client.get("/api/v1/documents").json()) == 1


def test_denied_effect_has_no_side_effect(client: TestClient) -> None:
    prepared = prepare_effect(
        client,
        capability_id="create_document",
        arguments={"title": "Denied", "content": "No", "content_type": "text/markdown"},
        tool_call_id="call_denied",
    )
    response = client.post(
        f"/api/v1/chat/effects/{prepared.effect.effect_id}/decision",
        json={
            "verdict": "deny",
            "argument_digest": prepared.effect.argument_digest,
            "reason": "Not wanted",
        },
    )
    assert response.status_code == 200
    assert response.json()["effect"]["status"] == "denied"
    assert client.get("/api/v1/documents").json() == []


def test_workspace_autonomy_is_bounded_to_private_effects(client: TestClient) -> None:
    set_chat_autonomy(client, "workspace")
    created = prepare_effect(
        client,
        capability_id="create_document",
        arguments={
            "title": "Autonomous private note",
            "content": "# Private",
            "content_type": "text/markdown",
        },
        tool_call_id="call_yolo_create",
    )
    assert created.effect.status == "completed"
    assert len(client.get("/api/v1/documents").json()) == 1

    document = client.post(
        "/api/v1/documents",
        headers=headers("publish-source"),
        json={"title": "Publish source", "path": "publish-source.md", "content": "# Source"},
    ).json()
    publication = prepare_effect(
        client,
        capability_id="publish_document",
        arguments={
            "document_id": document["document_id"],
            "revision_id": document["current_revision_id"],
            "slug": "publish-source",
            "access_policy": "public",
        },
        tool_call_id="call_yolo_publish",
    )
    assert publication.effect.status == "pending_approval"

    oversized = prepare_effect(
        client,
        capability_id="apply_workspace_organization_plan",
        arguments={
            "operations": [
                {
                    "kind": "create_folder",
                    "path": f"batch/folder-{index}",
                    "category": None,
                    "tag_ids": [],
                }
                for index in range(26)
            ]
        },
        tool_call_id="call_yolo_oversized",
    )
    assert oversized.effect.status == "pending_approval"


def test_cancelling_a_run_cancels_pending_effects_and_blocks_approval(
    client: TestClient,
) -> None:
    prepared = prepare_effect(
        client,
        capability_id="create_document",
        arguments={"title": "Cancelled", "content": "No", "content_type": "text/markdown"},
        tool_call_id="call_cancelled",
    )

    cancelled = client.post(f"/api/v1/chat/threads/{prepared.thread_id}/cancel")
    approval = client.post(
        f"/api/v1/chat/effects/{prepared.effect.effect_id}/decision",
        json={
            "verdict": "approve",
            "argument_digest": prepared.effect.argument_digest,
            "reason": None,
        },
    )

    assert cancelled.status_code == 200
    assert cancelled.json() == {"cancelled": True, "run_id": prepared.run_id}
    assert prepared.chat.evidence.cancel_requested(prepared.run_id) is True
    assert (
        prepared.chat.effects.get(prepared.principal, prepared.effect.effect_id).status
        == "cancelled"
    )
    assert approval.status_code == 409
    assert client.get("/api/v1/documents").json() == []


def test_expired_and_cross_actor_decisions_execute_nothing(client: TestClient) -> None:
    prepared = prepare_effect(
        client,
        capability_id="create_document",
        arguments={"title": "Guarded", "content": "No", "content_type": "text/markdown"},
        tool_call_id="call_guarded",
    )
    another_principal = Principal.trusted_human(
        actor_id="system", display_name="System", operation_id="cross-actor-decision"
    )
    with pytest.raises(AuthorizationError):
        prepared.chat.effects.decide(
            another_principal,
            effect_id=prepared.effect.effect_id,
            verdict="approve",
            argument_digest=prepared.effect.argument_digest,
            reason=None,
        )
    with prepared.chat.effects.database.transaction() as connection:
        connection.execute(
            "UPDATE chat_effects SET expires_at = '2000-01-01T00:00:00+00:00' WHERE effect_id = ?",
            (prepared.effect.effect_id,),
        )
    expired = client.post(
        f"/api/v1/chat/effects/{prepared.effect.effect_id}/decision",
        json={
            "verdict": "approve",
            "argument_digest": prepared.effect.argument_digest,
            "reason": None,
        },
    )
    assert expired.status_code == 409
    stored = client.get(f"/api/v1/chat/effects/{prepared.effect.effect_id}").json()
    assert stored["status"] == "expired"
    assert client.get("/api/v1/documents").json() == []


def test_publish_effect_rechecks_revision_after_approval(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Publish", "content": "Version one", "path": "publish.md"},
        headers=headers("publish-source"),
    ).json()
    prepared = prepare_effect(
        client,
        capability_id="publish_document",
        arguments={
            "document_id": document["document_id"],
            "revision_id": document["current_revision_id"],
            "slug": "publish",
            "access_policy": "public",
        },
        preview={
            "document_id": document["document_id"],
            "revision_id": document["current_revision_id"],
            "document_title": document["title"],
            "slug": "publish",
            "access_policy": "public",
        },
    )
    changed = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={
            "expected_revision_id": document["current_revision_id"],
            "content": "Version two",
        },
        headers=headers("publish-concurrent-edit"),
    )
    assert changed.status_code == 200
    response = client.post(
        f"/api/v1/chat/effects/{prepared.effect.effect_id}/decision",
        json={
            "verdict": "approve",
            "argument_digest": prepared.effect.argument_digest,
            "reason": None,
        },
    )
    assert response.status_code == 409
    effect = client.get(f"/api/v1/chat/effects/{prepared.effect.effect_id}").json()
    assert effect["status"] == "failed"
    assert effect["failure"]["retry_safe"] is False
    assert client.get(f"/api/v1/publications/by-document/{document['document_id']}").json() is None


def test_executing_effect_recovers_with_the_same_operation_key(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    prepared = prepare_effect(
        client,
        capability_id="create_document",
        arguments={"title": "Recovered", "content": "Once", "content_type": "text/markdown"},
        tool_call_id="call_recovery",
    )
    original_complete = prepared.chat.effects._complete
    calls = 0

    def fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("simulated completion write failure")
        return original_complete(*args, **kwargs)

    monkeypatch.setattr(prepared.chat.effects, "_complete", fail_once)
    with pytest.raises(RuntimeError, match="completion write failure"):
        prepared.chat.effects.decide(
            prepared.principal,
            effect_id=prepared.effect.effect_id,
            verdict="approve",
            argument_digest=prepared.effect.argument_digest,
            reason=None,
        )
    interrupted = prepared.chat.effects.get(prepared.principal, prepared.effect.effect_id)
    assert interrupted.status == "executing"
    recovered = prepared.chat.effects.decide(
        prepared.principal,
        effect_id=prepared.effect.effect_id,
        verdict="approve",
        argument_digest=prepared.effect.argument_digest,
        reason=None,
    )
    assert recovered.effect.status == "completed"
    assert len(client.get("/api/v1/documents").json()) == 1


def test_interrupted_publication_recovers_after_document_changes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Recover publication", "content": "Version one", "path": "recover.md"},
        headers=headers("recover-publication-source"),
    ).json()
    prepared = prepare_effect(
        client,
        capability_id="publish_document",
        arguments={
            "document_id": document["document_id"],
            "revision_id": document["current_revision_id"],
            "slug": "recover-publication",
            "access_policy": "public",
        },
        preview={
            "document_id": document["document_id"],
            "revision_id": document["current_revision_id"],
            "document_title": document["title"],
            "slug": "recover-publication",
            "access_policy": "public",
        },
        tool_call_id="call_publication_recovery",
    )
    original_complete = prepared.chat.effects._complete
    calls = 0

    def fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("simulated publication completion write failure")
        return original_complete(*args, **kwargs)

    monkeypatch.setattr(prepared.chat.effects, "_complete", fail_once)
    with pytest.raises(RuntimeError, match="publication completion write failure"):
        prepared.chat.effects.decide(
            prepared.principal,
            effect_id=prepared.effect.effect_id,
            verdict="approve",
            argument_digest=prepared.effect.argument_digest,
            reason=None,
        )
    changed = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={
            "expected_revision_id": document["current_revision_id"],
            "content": "Version two",
        },
        headers=headers("recover-publication-edit"),
    )
    assert changed.status_code == 200
    recovered = prepared.chat.effects.decide(
        prepared.principal,
        effect_id=prepared.effect.effect_id,
        verdict="approve",
        argument_digest=prepared.effect.argument_digest,
        reason=None,
    )
    assert recovered.effect.status == "completed"
    publication = client.get(f"/api/v1/publications/by-document/{document['document_id']}").json()
    assert publication["publication_id"] == recovered.effect.resource_id


def test_html_document_creation_lifecycle(client: TestClient) -> None:
    prepared = prepare_effect(
        client,
        capability_id="create_document",
        arguments={
            "title": "HTML page",
            "content": "<h1>Hello</h1>",
            "content_type": "text/html",
        },
    )
    assert prepared.effect.capability_version == 2

    decision = client.post(
        f"/api/v1/chat/effects/{prepared.effect.effect_id}/decision",
        json={
            "verdict": "approve",
            "argument_digest": prepared.effect.argument_digest,
            "reason": None,
        },
    )
    assert decision.status_code == 200
    assert decision.json()["effect"]["status"] == "completed"
    document_id = decision.json()["client_result"]["document_id"]
    document = client.get(f"/api/v1/documents/{document_id}").json()
    assert document["content_type"] == "text/html"
    assert document["content"] == "<h1>Hello</h1>"


def test_create_document_rejects_missing_and_unsupported_content_type(
    client: TestClient,
) -> None:
    with pytest.raises(PydanticValidationError):
        CreateDocumentInput.model_validate({"title": "Bad", "content": "x"})
    with pytest.raises(PydanticValidationError):
        CreateDocumentInput.model_validate(
            {"title": "Bad", "content": "x", "content_type": "text/plain"}
        )
