from __future__ import annotations

import json
import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from conftest import headers
from fastapi.testclient import TestClient


def test_folders_tags_categories_and_fts_search(client: TestClient, settings) -> None:
    research = client.post(
        "/api/v1/tags",
        json={"name": "Research", "color": "#327a62"},
        headers=headers("research-tag"),
    )
    urgent = client.post(
        "/api/v1/tags",
        json={"name": "Urgent", "color": "#b94b3d"},
        headers=headers("urgent-tag"),
    )
    assert research.status_code == urgent.status_code == 201
    research_tag = research.json()
    urgent_tag = urgent.json()

    folder_response = client.post(
        "/api/v1/folders",
        json={
            "path": "knowledge/research",
            "category": "Knowledge",
            "tag_ids": [research_tag["tag_id"]],
        },
        headers=headers("research-folder"),
    )
    assert folder_response.status_code == 201
    folder = folder_response.json()
    assert folder["path"] == "knowledge/research"
    assert folder["category"] == "Knowledge"
    assert [tag["name"] for tag in folder["tags"]] == ["Research"]
    assert (settings.workspace_root / "knowledge" / "research").is_dir()

    created = client.post(
        "/api/v1/documents",
        json={
            "title": "Concurrency field notes",
            "content": "Optimistic concurrency prevents silent overwrites.",
            "path": "knowledge/research/concurrency.md",
        },
        headers=headers("organized-create"),
    ).json()
    assert created["metadata_version"] == 0
    assert created["category"] is None
    assert created["tags"] == []

    organized_response = client.patch(
        f"/api/v1/documents/{created['document_id']}/metadata",
        json={
            "expected_metadata_version": 0,
            "category": "Engineering",
            "tag_ids": [urgent_tag["tag_id"], research_tag["tag_id"]],
        },
        headers=headers("organized-metadata"),
    )
    assert organized_response.status_code == 200
    organized = organized_response.json()
    assert organized["metadata_version"] == 1
    assert organized["category"] == "Engineering"
    assert [tag["name"] for tag in organized["tags"]] == ["Research", "Urgent"]

    for query in ("concurrency", "overwrites", "knowledge", "Research", "Engineering"):
        results = client.get("/api/v1/search", params={"q": query}).json()
        assert [result["document_id"] for result in results] == [created["document_id"]]
    tag_results = client.get("/api/v1/search", params={"tag_id": research_tag["tag_id"]}).json()
    assert [result["document_id"] for result in tag_results] == [created["document_id"]]
    category_results = client.get("/api/v1/search", params={"category": "engineering"}).json()
    assert [result["document_id"] for result in category_results] == [created["document_id"]]

    stale = client.patch(
        f"/api/v1/documents/{created['document_id']}/metadata",
        json={
            "expected_metadata_version": 0,
            "category": "Stale",
            "tag_ids": [],
        },
        headers=headers("stale-metadata"),
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["details"]["current_metadata_version"] == 1

    folders = client.get("/api/v1/folders").json()
    assert [folder["path"] for folder in folders] == ["knowledge", "knowledge/research"]
    assert folders[1]["document_count"] == 1


def test_folder_metadata_concurrency_and_path_validation(client: TestClient) -> None:
    folder = client.post(
        "/api/v1/folders",
        json={"path": "projects/active", "category": "Projects"},
        headers=headers("active-folder"),
    ).json()
    updated = client.patch(
        f"/api/v1/folders/{folder['folder_id']}",
        json={
            "expected_metadata_version": folder["metadata_version"],
            "category": "Active projects",
            "tag_ids": [],
        },
        headers=headers("active-folder-update"),
    )
    assert updated.status_code == 200
    assert updated.json()["category"] == "Active projects"
    stale = client.patch(
        f"/api/v1/folders/{folder['folder_id']}",
        json={
            "expected_metadata_version": folder["metadata_version"],
            "category": "Stale",
            "tag_ids": [],
        },
        headers=headers("active-folder-stale"),
    )
    assert stale.status_code == 409

    for index, invalid_path in enumerate(
        ("../outside", "/absolute", "projects/../outside", "bad\\path")
    ):
        response = client.post(
            "/api/v1/folders",
            json={"path": invalid_path},
            headers=headers(f"invalid-folder-{index}"),
        )
        assert response.status_code == 422


def test_tag_and_folder_mutation_retries_are_idempotent(client: TestClient) -> None:
    tag_headers = headers("retry-tag")
    first_tag = client.post(
        "/api/v1/tags",
        json={"name": "Reviewed", "color": "#327a62"},
        headers=tag_headers,
    )
    retried_tag = client.post(
        "/api/v1/tags",
        json={"name": "Reviewed", "color": "#327a62"},
        headers=tag_headers,
    )
    assert first_tag.status_code == retried_tag.status_code == 201
    assert retried_tag.json() == first_tag.json()
    conflicting_tag = client.post(
        "/api/v1/tags",
        json={"name": "Different", "color": "#327a62"},
        headers=tag_headers,
    )
    assert conflicting_tag.status_code == 409
    assert conflicting_tag.json()["error"]["code"] == "idempotency_conflict"
    cross_namespace = client.post(
        "/api/v1/documents",
        json={"title": "Must not reuse a tag key", "content": ""},
        headers=tag_headers,
    )
    assert cross_namespace.status_code == 409
    assert cross_namespace.json()["error"]["code"] == "idempotency_conflict"

    folder_headers = headers("retry-folder")
    payload = {
        "path": "review/follow-up",
        "category": "Review",
        "tag_ids": [first_tag.json()["tag_id"]],
    }
    first_folder = client.post("/api/v1/folders", json=payload, headers=folder_headers)
    retried_folder = client.post("/api/v1/folders", json=payload, headers=folder_headers)
    assert first_folder.status_code == retried_folder.status_code == 201
    assert retried_folder.json() == first_folder.json()

    folder = first_folder.json()
    update_headers = headers("retry-folder-update")
    update_payload = {
        "expected_metadata_version": folder["metadata_version"],
        "category": "Reviewed",
        "tag_ids": [],
    }
    first_update = client.patch(
        f"/api/v1/folders/{folder['folder_id']}",
        json=update_payload,
        headers=update_headers,
    )
    retried_update = client.patch(
        f"/api/v1/folders/{folder['folder_id']}",
        json=update_payload,
        headers=update_headers,
    )
    assert first_update.status_code == retried_update.status_code == 200
    assert retried_update.json() == first_update.json()


def test_create_or_organize_folder_records_prior_tags_and_ignores_exact_retry(
    client: TestClient,
) -> None:
    first_tag = client.post(
        "/api/v1/tags",
        json={"name": "First", "color": "#327a62"},
        headers=headers("audit-first-tag"),
    ).json()
    second_tag = client.post(
        "/api/v1/tags",
        json={"name": "Second", "color": "#b94b3d"},
        headers=headers("audit-second-tag"),
    ).json()

    created = client.post(
        "/api/v1/folders",
        json={
            "path": "projects",
            "category": "One",
            "tag_ids": [first_tag["tag_id"]],
        },
        headers=headers("audit-create-folder"),
    ).json()
    organized = client.post(
        "/api/v1/folders",
        json={
            "path": "projects",
            "category": "Two",
            "tag_ids": [second_tag["tag_id"]],
        },
        headers=headers("audit-organize-folder"),
    ).json()

    assert organized["folder_id"] == created["folder_id"]
    assert organized["metadata_version"] == created["metadata_version"] + 1

    database = client.app.state.services.documents.database
    with database.connection() as connection:
        events = connection.execute(
            """
            SELECT before_json, after_json
            FROM metadata_events
            WHERE entity_type = 'folder' AND entity_id = ?
            """,
            (created["folder_id"],),
        ).fetchall()
    events_by_version = {
        json.loads(event["after_json"])["metadata_version"]: event for event in events
    }
    second_event = events_by_version[organized["metadata_version"]]
    assert json.loads(second_event["before_json"]) == {
        "path": "projects",
        "category": "One",
        "tag_ids": [first_tag["tag_id"]],
        "metadata_version": created["metadata_version"],
    }

    retried = client.post(
        "/api/v1/folders",
        json={
            "path": "projects",
            "category": "Two",
            "tag_ids": [second_tag["tag_id"], second_tag["tag_id"]],
        },
        headers=headers("audit-exact-folder-retry"),
    ).json()
    assert retried == organized

    with database.connection() as connection:
        event_count = connection.execute(
            """
            SELECT count(*)
            FROM metadata_events
            WHERE entity_type = 'folder' AND entity_id = ?
            """,
            (created["folder_id"],),
        ).fetchone()[0]
    assert event_count == 2


def test_folder_rename_end_to_end(client: TestClient, settings) -> None:
    folder_res = client.post(
        "/api/v1/folders",
        json={"path": "reports/archive-2026"},
        headers=headers("folder-create-rename"),
    )
    assert folder_res.status_code == 201
    folder = folder_res.json()

    doc_res = client.post(
        "/api/v1/documents",
        json={
            "title": "Annual Summary",
            "content": "Summary content.",
            "path": "reports/archive-2026/summary.md",
        },
        headers=headers("doc-in-folder-rename"),
    )
    assert doc_res.status_code == 201
    doc = doc_res.json()

    # Move/rename folder
    rename_res = client.post(
        f"/api/v1/folders/{folder['folder_id']}/move",
        json={"path": "reports/archive-2027"},
        headers=headers("folder-rename-action"),
    )
    assert rename_res.status_code == 200
    renamed_folder = rename_res.json()
    assert renamed_folder["path"] == "reports/archive-2027"

    # Verify document updated in API and on disk
    doc_id = doc["document_id"]
    doc_after = client.get(
        f"/api/v1/documents/{doc_id}",
        headers=headers("get-doc-after-rename"),
    ).json()
    assert doc_after["path"] == "reports/archive-2027/summary.md"
    assert (settings.workspace_root / "reports" / "archive-2027" / "summary.md").is_file()
    assert not (settings.workspace_root / "reports" / "archive-2026").exists()

    history = client.get(f"/api/v1/documents/{doc_id}/history").json()
    assert history[0]["operation"] == "move"
    assert history[0]["actor_id"] == "human:jay"
    assert "archive-2026" in history[0]["summary"]
    assert [
        item["document_id"]
        for item in client.get("/api/v1/search", params={"q": "archive-2027"}).json()
    ] == [doc_id]
    database = client.app.state.services.documents.database
    with database.connection() as connection:
        indexed_path = connection.execute(
            "SELECT path FROM document_search WHERE document_id = ?", (doc_id,)
        ).fetchone()[0]
    assert indexed_path == "reports/archive-2027/summary.md"


def _create_movable_folder(client: TestClient, *, path: str = "source") -> tuple[dict, dict]:
    folder = client.post(
        "/api/v1/folders", json={"path": path}, headers=headers(f"create-{path}")
    ).json()
    document = client.post(
        "/api/v1/documents",
        json={"title": "Move me", "content": "folder move", "path": f"{path}/note.md"},
        headers=headers(f"create-{path}-document"),
    ).json()
    return folder, document


def test_folder_move_rejects_descendant_and_literal_wildcard_collisions(
    client: TestClient, settings
) -> None:
    folder, document = _create_movable_folder(client, path="percent%_folder")
    other = client.post(
        "/api/v1/folders", json={"path": "percentXXfolder"}, headers=headers("other-folder")
    ).json()

    descendant = client.post(
        f"/api/v1/folders/{folder['folder_id']}/move",
        json={"path": "percent%_folder/nested/moved"},
        headers=headers("descendant-folder-move"),
    )
    assert descendant.status_code == 422
    assert descendant.json()["error"]["message"] == "A folder cannot be moved inside itself"

    moved = client.post(
        f"/api/v1/folders/{folder['folder_id']}/move",
        json={"path": "renamed"},
        headers=headers("wildcard-folder-move"),
    )
    assert moved.status_code == 200
    folders = {item["folder_id"]: item["path"] for item in client.get("/api/v1/folders").json()}
    assert folders[folder["folder_id"]] == "renamed"
    assert folders[other["folder_id"]] == "percentXXfolder"
    assert client.get(f"/api/v1/documents/{document['document_id']}").json()["path"] == (
        "renamed/note.md"
    )
    assert (settings.workspace_root / "percentXXfolder").is_dir()


def test_folder_move_filesystem_failure_leaves_database_unchanged(
    client: TestClient, settings
) -> None:
    folder, document = _create_movable_folder(client)
    (settings.workspace_root / "occupied").mkdir()

    response = client.post(
        f"/api/v1/folders/{folder['folder_id']}/move",
        json={"path": "occupied"},
        headers=headers("occupied-folder-move"),
    )
    assert response.status_code == 422
    assert client.get(f"/api/v1/documents/{document['document_id']}").json()["path"] == (
        "source/note.md"
    )
    assert (settings.workspace_root / "source" / "note.md").is_file()


def test_folder_move_rolls_back_filesystem_when_database_commit_fails(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder, document = _create_movable_folder(client)
    organization = client.app.state.services.organization
    original_commit = organization._commit_folder_move

    def fail_after_updates(*args, **kwargs):
        original_commit(*args, **kwargs)
        raise sqlite3.OperationalError("forced commit failure")

    monkeypatch.setattr(organization, "_commit_folder_move", fail_after_updates)
    with pytest.raises(sqlite3.OperationalError, match="forced commit failure"):
        organization.rename_folder(
            folder_id=folder["folder_id"],
            destination_path="moved",
            actor_id="human:jay",
            idempotency_key="failed-database-folder-move",
        )

    assert client.get(f"/api/v1/documents/{document['document_id']}").json()["path"] == (
        "source/note.md"
    )
    assert (settings.workspace_root / "source" / "note.md").is_file()
    assert not (settings.workspace_root / "moved").exists()


def test_folder_move_excludes_backup_generation(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder, document = _create_movable_folder(client)
    organization = client.app.state.services.organization
    manager = client.app.state.services.backups.manager
    original_rename = organization.workspace.rename_folder
    rename_started = threading.Event()
    release_rename = threading.Event()
    archive_started = threading.Event()

    def paused_rename(source: str, destination: str) -> None:
        original_rename(source, destination)
        if source == "source":
            rename_started.set()
            assert release_rename.wait(timeout=5)

    original_archive = manager._archive_workspace

    def observed_archive(destination: Path) -> None:
        archive_started.set()
        original_archive(destination)

    monkeypatch.setattr(organization.workspace, "rename_folder", paused_rename)
    monkeypatch.setattr(manager, "_archive_workspace", observed_archive)
    with ThreadPoolExecutor(max_workers=2) as executor:
        move_future = executor.submit(
            organization.rename_folder,
            folder_id=folder["folder_id"],
            destination_path="moved",
            actor_id="human:jay",
            idempotency_key="coordinated-folder-move",
        )
        assert rename_started.wait(timeout=5)
        backup_future = executor.submit(manager.create)
        assert not archive_started.wait(timeout=0.2)
        release_rename.set()
        assert move_future.result(timeout=5).path == "moved"
        backup = backup_future.result(timeout=5)

    assert manager.verify(backup.backup_id).valid is True
    with sqlite3.connect(manager.backup_root / backup.backup_id / "database.sqlite3") as snapshot:
        path = snapshot.execute(
            "SELECT path FROM documents WHERE document_id = ?", (document["document_id"],)
        ).fetchone()[0]
    assert path == "moved/note.md"
