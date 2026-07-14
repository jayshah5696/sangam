from __future__ import annotations

import json

from conftest import headers
from fastapi.testclient import TestClient


def test_folders_tags_categories_and_fts_search(client: TestClient, settings) -> None:
    research = client.post(
        "/api/v1/tags",
        json={"name": "Research", "color": "#327a62"},
        headers={"X-Actor": "human:jay"},
    )
    urgent = client.post(
        "/api/v1/tags",
        json={"name": "Urgent", "color": "#b94b3d"},
        headers={"X-Actor": "human:jay"},
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
        headers={"X-Actor": "human:jay"},
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
    ).json()
    updated = client.patch(
        f"/api/v1/folders/{folder['folder_id']}",
        json={
            "expected_metadata_version": folder["metadata_version"],
            "category": "Active projects",
            "tag_ids": [],
        },
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
    )
    assert stale.status_code == 409

    for invalid_path in ("../outside", "/absolute", "projects/../outside", "bad\\path"):
        response = client.post("/api/v1/folders", json={"path": invalid_path})
        assert response.status_code == 422


def test_create_or_organize_folder_records_prior_tags_and_ignores_exact_retry(
    client: TestClient,
) -> None:
    first_tag = client.post(
        "/api/v1/tags",
        json={"name": "First", "color": "#327a62"},
    ).json()
    second_tag = client.post(
        "/api/v1/tags",
        json={"name": "Second", "color": "#b94b3d"},
    ).json()

    created = client.post(
        "/api/v1/folders",
        json={
            "path": "projects",
            "category": "One",
            "tag_ids": [first_tag["tag_id"]],
        },
    ).json()
    organized = client.post(
        "/api/v1/folders",
        json={
            "path": "projects",
            "category": "Two",
            "tag_ids": [second_tag["tag_id"]],
        },
    ).json()

    assert organized["folder_id"] == created["folder_id"]
    assert organized["metadata_version"] == created["metadata_version"] + 1

    database = client.app.state.service.database
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
