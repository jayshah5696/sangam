"""The activity ledger contract: reads never write it, and every write reaches it."""

from __future__ import annotations

from conftest import headers
from fastapi.testclient import TestClient
from test_phase_five_pdf_research import import_pdf, text_pdf
from test_phase_six_karakeep import configure_fake


def human_events(client: TestClient, **filters: str) -> list[dict]:
    response = client.get(
        "/api/v1/activity", params={"actor_kind": "human", "limit": 200, **filters}
    )
    assert response.status_code == 200
    return response.json()


def test_human_reads_never_write_ledger_rows(client: TestClient) -> None:
    created = client.post(
        "/api/v1/documents",
        json={"title": "Notes", "content": "one\n", "path": "notes.md"},
        headers=headers("ledger-read-create"),
    ).json()
    document_id = created["document_id"]
    revision_id = created["current_revision_id"]
    pdf = import_pdf(client, content=text_pdf(), key="ledger-read-pdf").json()
    annotation = client.post(
        f"/api/v1/pdfs/{pdf['document_id']}/annotations",
        json={
            "page_number": 1,
            "annotation_type": "text_highlight",
            "selected_text": "Sangam",
            "geometry": [{"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.05}],
            "color": "#f5d76e",
        },
        headers=headers("ledger-read-annotation"),
    ).json()
    before = len(human_events(client))

    reads = [
        f"/api/v1/documents/{document_id}",
        f"/api/v1/documents/{document_id}/history",
        f"/api/v1/documents/{document_id}/revisions",
        f"/api/v1/documents/{document_id}/revisions/{revision_id}",
        f"/api/v1/documents/{document_id}/diff?from_revision_id={revision_id}",
        f"/api/v1/documents/{document_id}/backlinks",
        f"/api/v1/pdfs/{pdf['document_id']}/content",
        f"/api/v1/pdfs/{pdf['document_id']}/pages",
        f"/api/v1/pdfs/{pdf['document_id']}/search?q=Sangam",
        f"/api/v1/pdfs/{pdf['document_id']}/annotations",
        f"/api/v1/annotations/{annotation['annotation_id']}/history",
    ]
    for path in reads:
        assert client.get(path).status_code == 200, path

    after = human_events(client)
    assert len(after) == before, [event["action"] for event in after[: len(after) - before]]


def test_backup_and_reindex_writes_reach_the_ledger(client: TestClient) -> None:
    backup = client.post("/api/v1/backups", headers=headers("ledger-backup")).json()
    assert client.delete(f"/api/v1/backups/{backup['backup_id']}").status_code == 204
    assert client.post("/api/v1/search/reindex").status_code == 200

    actions = {(event["action"], event["resource_type"]) for event in human_events(client)}
    assert ("create", "backup") in actions
    assert ("delete", "backup") in actions
    assert ("reindex", "search_index") in actions


def test_karakeep_import_is_attributed_to_the_requesting_administrator(
    client: TestClient,
) -> None:
    configure_fake(client)
    imported = client.post(
        "/api/v1/karakeep/imports",
        json={"bookmark_id": "bookmark-1"},
        headers=headers("ledger-karakeep"),
    )
    assert imported.status_code == 201

    events = human_events(client, resource_type="karakeep_import")
    assert [event["action"] for event in events] == ["import"]
    assert events[0]["resource_id"] == imported.json()["import_id"]


def test_project_brief_creation_is_recorded_as_a_document_create(client: TestClient) -> None:
    project = client.post(
        "/api/v1/projects",
        json={"name": "Ledger project", "create_brief": True},
        headers=headers("ledger-project"),
    )
    assert project.status_code == 201
    brief_id = project.json()["brief_document_id"]

    events = human_events(client, resource_id=brief_id)
    assert [(event["action"], event["resource_type"]) for event in events] == [
        ("create", "document")
    ]
    assert events[0]["revision_id"] is not None


def test_project_and_saved_view_writes_follow_the_same_contract(client: TestClient) -> None:
    project = client.post(
        "/api/v1/projects",
        json={"name": "Ledger contract", "create_brief": False},
        headers=headers("contract-project"),
    ).json()
    stale = client.patch(
        f"/api/v1/projects/{project['project_id']}",
        json={"expected_version": 99, "name": "Never applied"},
        headers=headers("contract-stale"),
    )
    assert stale.status_code == 409
    saved = client.post(
        "/api/v1/saved-views",
        json={"name": "Contract view", "filters": {"query": "contract"}},
        headers=headers("contract-view"),
    )
    assert saved.status_code in {200, 201}

    project_events = human_events(client, resource_id=project["project_id"])
    assert [(e["action"], e["outcome"]) for e in project_events] == [
        ("update", "conflict"),
        ("create", "accepted"),
    ]
    [view_event] = human_events(client, resource_type="saved_view")
    assert (view_event["action"], view_event["outcome"]) == ("save_view", "accepted")
