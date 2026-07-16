from __future__ import annotations

from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient


def test_markdown_lifecycle_materialize_conflict_and_restore(client: TestClient, settings) -> None:
    created_response = client.post(
        "/api/v1/documents",
        json={"title": "First document", "content": "# Original\n"},
        headers=headers("create-first"),
    )
    assert created_response.status_code == 201
    created = created_response.json()
    document_id = created["document_id"]
    original_revision = created["current_revision_id"]
    assert created["path"] is None
    assert created["materialization_state"] == "none"

    materialized_response = client.post(
        f"/api/v1/documents/{document_id}/materialize",
        json={
            "expected_revision_id": original_revision,
            "path": "projects/first-document.md",
        },
        headers=headers("materialize-first"),
    )
    assert materialized_response.status_code == 200
    materialized = materialized_response.json()
    materialize_revision = materialized["current_revision_id"]
    assert materialized["document_id"] == document_id
    assert materialize_revision != original_revision
    assert materialized["materialization_state"] == "clean"
    workspace_file = settings.workspace_root / "projects" / "first-document.md"
    assert workspace_file.read_text(encoding="utf-8") == "# Original\n"

    updated_response = client.patch(
        f"/api/v1/documents/{document_id}",
        json={
            "expected_revision_id": materialize_revision,
            "content": "# Edited\n\nRead through the API and CLI.\n",
            "summary": "First edit",
        },
        headers=headers("update-first"),
    )
    assert updated_response.status_code == 200
    updated = updated_response.json()
    updated_revision = updated["current_revision_id"]
    assert workspace_file.read_text(encoding="utf-8") == updated["content"]

    stale_response = client.patch(
        f"/api/v1/documents/{document_id}",
        json={"expected_revision_id": materialize_revision, "content": "stale overwrite"},
        headers=headers("stale-update"),
    )
    assert stale_response.status_code == 409
    assert stale_response.json()["error"] == {
        "code": "revision_conflict",
        "message": "The document changed since it was read",
        "details": {
            "document_id": document_id,
            "expected_revision_id": materialize_revision,
            "current_revision_id": updated_revision,
        },
    }
    assert client.get(f"/api/v1/documents/{document_id}").json()["content"] == updated["content"]

    agent_token = issue_agent_token(client)
    restore_response = client.post(
        f"/api/v1/documents/{document_id}/restore",
        json={
            "expected_revision_id": updated_revision,
            "revision_id": original_revision,
        },
        headers={
            "Authorization": f"Bearer {agent_token}",
            "Idempotency-Key": "restore-original",
        },
    )
    assert restore_response.status_code == 200
    restored = restore_response.json()
    assert restored["document_id"] == document_id
    assert restored["current_revision_id"] not in {original_revision, updated_revision}
    assert restored["content"] == "# Original\n"
    assert workspace_file.read_text(encoding="utf-8") == "# Original\n"

    history = client.get(f"/api/v1/documents/{document_id}/history").json()
    assert [revision["operation"] for revision in history] == [
        "restore",
        "update",
        "materialize",
        "create",
    ]
    assert history[0]["actor_id"] == "agent:cli"
    assert history[-1]["content"] == "# Original\n"
    assert history[1]["content"] == updated["content"]


def test_move_delete_and_recover_tombstoned_document(client: TestClient, settings) -> None:
    created = client.post(
        "/api/v1/documents",
        json={"title": "Movable", "content": "Keep me", "path": "drafts/move.md"},
        headers=headers("create-movable"),
    ).json()
    first_revision = created["current_revision_id"]
    old_file = settings.workspace_root / "drafts" / "move.md"
    assert old_file.exists()

    moved = client.post(
        f"/api/v1/documents/{created['document_id']}/move",
        json={"expected_revision_id": first_revision, "path": "projects/moved.md"},
        headers=headers("move-document"),
    ).json()
    new_file = settings.workspace_root / "projects" / "moved.md"
    assert not old_file.exists()
    assert new_file.read_text(encoding="utf-8") == "Keep me"

    deleted = client.request(
        "DELETE",
        f"/api/v1/documents/{created['document_id']}",
        json={"expected_revision_id": moved["current_revision_id"]},
        headers=headers("delete-document"),
    ).json()
    assert deleted["deleted"] is True
    assert not new_file.exists()
    assert client.get(f"/api/v1/documents/{created['document_id']}").status_code == 404
    assert client.get("/api/v1/documents").json() == []

    restored = client.post(
        f"/api/v1/documents/{created['document_id']}/restore",
        json={
            "expected_revision_id": deleted["current_revision_id"],
            "revision_id": first_revision,
        },
        headers=headers("undelete-document"),
    ).json()
    assert restored["deleted"] is False
    assert restored["document_id"] == created["document_id"]
    assert new_file.read_text(encoding="utf-8") == "Keep me"


def test_list_and_read_share_stable_document_identity(client: TestClient) -> None:
    created = client.post(
        "/api/v1/documents",
        json={"title": "Listed", "content": "Visible"},
        headers=headers("create-listed"),
    ).json()
    listed = client.get("/api/v1/documents").json()
    assert [item["document_id"] for item in listed] == [created["document_id"]]
    assert client.get(f"/api/v1/documents/{created['document_id']}").json() == created
