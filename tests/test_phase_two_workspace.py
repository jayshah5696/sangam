from __future__ import annotations

from pathlib import Path

from conftest import headers
from fastapi.testclient import TestClient

from sangam.config import Settings
from sangam.service import DocumentService


def create_document(
    client: TestClient,
    *,
    title: str = "Phase two note",
    content: str = "first line\nsecond line\n",
    path: str | None = "projects/phase-two.md",
    key: str = "phase-two-create",
) -> dict:
    response = client.post(
        "/api/v1/documents",
        json={"title": title, "content": content, "path": path},
        headers=headers(key),
    )
    assert response.status_code == 201
    return response.json()


def test_duplicate_diff_and_recoverable_delete_workflows(client: TestClient) -> None:
    created = create_document(client)
    updated = client.patch(
        f"/api/v1/documents/{created['document_id']}",
        json={
            "expected_revision_id": created["current_revision_id"],
            "content": "first line\nchanged line\nthird line\n",
            "title": "Renamed phase two note",
            "summary": "Expanded the daily note",
        },
        headers=headers("phase-two-update", actor="client:cli"),
    ).json()
    assert updated["title"] == "Renamed phase two note"

    diff = client.get(
        f"/api/v1/documents/{created['document_id']}/diff",
        params={"from_revision_id": created["current_revision_id"]},
    )
    assert diff.status_code == 200
    assert diff.json()["to_revision_id"] == updated["current_revision_id"]
    assert diff.json()["additions"] == 2
    assert diff.json()["deletions"] == 1
    assert "+changed line" in diff.json()["unified_diff"]

    duplicate = client.post(
        f"/api/v1/documents/{created['document_id']}/duplicate",
        json={
            "expected_revision_id": updated["current_revision_id"],
            "title": "Copied note",
        },
        headers=headers("phase-two-duplicate"),
    )
    assert duplicate.status_code == 201
    assert duplicate.json()["document_id"] != created["document_id"]
    assert duplicate.json()["content"] == updated["content"]
    assert duplicate.json()["path"] is None

    deleted = client.request(
        "DELETE",
        f"/api/v1/documents/{created['document_id']}",
        json={"expected_revision_id": updated["current_revision_id"]},
        headers=headers("phase-two-delete"),
    ).json()
    assert deleted["deleted"] is True
    assert client.get(f"/api/v1/documents/{created['document_id']}").status_code == 404
    restored = client.post(
        f"/api/v1/documents/{created['document_id']}/restore",
        json={
            "expected_revision_id": deleted["current_revision_id"],
            "revision_id": deleted["current_revision_id"],
        },
        headers=headers("phase-two-undelete"),
    ).json()
    assert restored["deleted"] is False
    assert restored["document_id"] == created["document_id"]


def test_search_includes_history_actor_summary_snippets_filters_and_rebuild(
    client: TestClient,
) -> None:
    created = create_document(client, content="Optimistic concurrency prevents overwrites.")
    updated = client.patch(
        f"/api/v1/documents/{created['document_id']}",
        json={
            "expected_revision_id": created["current_revision_id"],
            "content": "Optimistic concurrency prevents silent overwrites.",
            "summary": "Documented the compare and swap contract",
        },
        headers=headers("search-update", actor="client:cli"),
    ).json()
    assert updated["updated_by"] == "client:cli"
    assert updated["updated_by_name"] == "Sangam CLI"

    for query in ("silent", "compare swap", "Sangam CLI"):
        response = client.get("/api/v1/search", params={"q": query})
        assert response.status_code == 200
        assert [result["document_id"] for result in response.json()] == [created["document_id"]]
        assert response.json()[0]["search_snippet"]

    by_actor = client.get(
        "/api/v1/search", params={"actor_id": "client:cli", "sort": "title"}
    ).json()
    assert [result["document_id"] for result in by_actor] == [created["document_id"]]
    assert client.get("/api/v1/search", params={"actor_id": "system"}).json() == []

    rebuilt = client.post("/api/v1/search/reindex")
    assert rebuilt.status_code == 200
    assert rebuilt.json() == {"indexed_documents": 1}
    assert (
        client.get("/api/v1/search", params={"q": "concurrency"}).json()[0]["document_id"]
        == created["document_id"]
    )


def test_every_reconciliation_choice_is_explicit_and_repeatable(
    client: TestClient, settings: Settings
) -> None:
    external = create_document(client, path="external.md", key="external-choice")
    external_path = settings.workspace_root / "external.md"
    external_path.write_text("changed outside", encoding="utf-8")
    conflict = client.post("/api/v1/reconciliation/scan").json()["conflicts"][0]
    restored = client.post(f"/api/v1/reconciliation/{conflict['conflict_id']}/restore-database")
    assert restored.status_code == 200
    assert external_path.read_text(encoding="utf-8") == external["content"]

    moved = create_document(client, path="old.md", key="move-choice")
    (settings.workspace_root / "old.md").rename(settings.workspace_root / "new.md")
    move_conflict = next(
        item
        for item in client.post("/api/v1/reconciliation/scan").json()["conflicts"]
        if item["conflict_type"] == "possible_move"
    )
    recognized = client.post(
        f"/api/v1/reconciliation/{move_conflict['conflict_id']}/recognize-move"
    ).json()
    assert recognized["document_id"] == moved["document_id"]
    assert recognized["path"] == "new.md"

    ignored_path = settings.workspace_root / "ignored.md"
    ignored_path.write_text("ignore this exact version", encoding="utf-8")
    unknown = next(
        item
        for item in client.post("/api/v1/reconciliation/scan").json()["conflicts"]
        if item["path"] == "ignored.md"
    )
    ignored = client.post(f"/api/v1/reconciliation/{unknown['conflict_id']}/ignore")
    assert ignored.status_code == 200
    assert client.post("/api/v1/reconciliation/scan").json()["conflicts"] == []
    ignored_path.write_text("changed after ignore", encoding="utf-8")
    rescanned = client.post("/api/v1/reconciliation/scan").json()
    assert [(item["conflict_type"], item["path"]) for item in rescanned["conflicts"]] == [
        ("unknown_file", "ignored.md")
    ]


def test_backup_set_is_verified_and_restores_a_bootable_workspace(
    client: TestClient, settings: Settings, tmp_path: Path
) -> None:
    created = create_document(client, path="recovery/kept.md", key="backup-document")
    backup = client.post("/api/v1/backups")
    assert backup.status_code == 201
    manifest = backup.json()
    assert manifest["document_count"] == 1
    assert manifest["revision_count"] == 1
    assert manifest["verified_at"] is not None
    assert {artifact["name"] for artifact in manifest["artifacts"]} == {
        "database.sqlite3",
        "workspace.tar.gz",
    }

    verification = client.post(f"/api/v1/backups/{manifest['backup_id']}/verify")
    assert verification.status_code == 200
    assert verification.json()["database_integrity"] == "ok"
    assert verification.json()["valid"] is True

    service: DocumentService = client.app.state.service
    restored_database = tmp_path / "restored" / "database.sqlite3"
    restored_workspace = tmp_path / "restored-workspace"
    service.backups.restore_to(
        manifest["backup_id"],
        database_path=restored_database,
        workspace_root=restored_workspace,
    )
    restored_service = DocumentService(
        Settings(
            database_path=restored_database,
            workspace_root=restored_workspace,
            backup_root=tmp_path / "restored-backups",
            backups_enabled=False,
        )
    )
    restored = restored_service.get_document(created["document_id"])
    assert restored.content == created["content"]
    assert (restored_workspace / "recovery" / "kept.md").read_text() == created["content"]

    service.backups.retention_count = 2
    service.backups.create()
    service.backups.create()
    assert len(service.backups.list()) == 2
    assert service.backups.create_if_due() is None
