from __future__ import annotations

import pytest
from conftest import headers
from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings
from sangam.search import SearchIndex


def test_healthy_restart_does_not_rebuild_search(settings: Settings, monkeypatch) -> None:
    with TestClient(create_app(settings)) as client:
        created = client.post(
            "/api/v1/documents",
            json={"title": "Healthy", "content": "retainedsearchtoken"},
            headers=headers("healthy"),
        ).json()

    def forbid_rebuild(*args):
        pytest.fail("A healthy restart must not rebuild the corpus")

    monkeypatch.setattr(SearchIndex, "rebuild", forbid_rebuild)
    with TestClient(create_app(settings)) as restarted:
        result = restarted.get("/api/v1/search", params={"q": "retainedsearchtoken"})
        assert [doc["document_id"] for doc in result.json()] == [created["document_id"]]


def test_restart_repairs_committed_content_after_interrupted_indexing(settings, monkeypatch):
    with TestClient(create_app(settings)) as client:
        created = client.post(
            "/api/v1/documents",
            json={"title": "Repair", "content": "oldsearchtoken"},
            headers=headers("repair-create"),
        ).json()
        with monkeypatch.context() as patch:
            patch.setattr(SearchIndex, "sync", lambda *args: None)
            response = client.patch(
                f"/api/v1/documents/{created['document_id']}",
                json={
                    "expected_revision_id": created["current_revision_id"],
                    "content": "newsearchtoken",
                },
                headers=headers("repair-update"),
            )
            assert response.status_code == 200
        assert client.get("/api/v1/search", params={"q": "newsearchtoken"}).json() == []

    with TestClient(create_app(settings)) as restarted:
        assert restarted.get("/api/v1/search", params={"q": "oldsearchtoken"}).json() == []
        result = restarted.get("/api/v1/search", params={"q": "newsearchtoken"}).json()
        assert [doc["document_id"] for doc in result] == [created["document_id"]]


@pytest.mark.parametrize(
    ("sql", "term", "visible"),
    [
        ("UPDATE documents SET title = 'changedtitle' WHERE document_id = ?", "changedtitle", True),
        (
            "UPDATE documents SET category = 'changedcategory' WHERE document_id = ?",
            "changedcategory",
            True,
        ),
        ("UPDATE documents SET deleted = 1 WHERE document_id = ?", "originaltoken", False),
        (
            "UPDATE revisions SET summary = 'changedsummary' WHERE document_id = ?",
            "changedsummary",
            True,
        ),
    ],
)
def test_committed_search_fields_are_repaired(client, sql, term, visible):
    document = client.post(
        "/api/v1/documents",
        json={"title": "Original", "content": "originaltoken"},
        headers=headers("dirty-fields"),
    ).json()
    services = client.app.state.services
    database = services.documents.database
    with database.transaction() as connection:
        connection.execute(sql, (document["document_id"],))
    assert services.documents.search_index.repair_pending() == 1
    result = client.get("/api/v1/search", params={"q": term}).json()
    assert bool(result) is visible
    assert services.documents.search_index.repair_pending() == 0


def test_tag_author_pdf_and_annotation_changes_mark_search_dirty(client):
    from test_phase_five_pdf_research import import_pdf, text_pdf

    response = import_pdf(client, content=text_pdf("originalpage"), key="dirty-pdf")
    assert response.status_code == 201
    document = response.json()
    document_id = document["document_id"]
    services = client.app.state.services
    database = services.documents.database
    index = services.documents.search_index
    statements = [
        (
            "UPDATE pdf_pages SET text = 'changedpage' WHERE document_id = ?",
            (document_id,),
            "changedpage",
        ),
        (
            "UPDATE actors SET display_name = 'changedauthor' WHERE actor_id = ?",
            ("human:jay",),
            "changedauthor",
        ),
        ("INSERT INTO tags VALUES ('dirtytag', 'tagbefore', '#ffffff', 'now')", (), None),
        ("INSERT INTO document_tags VALUES (?, 'dirtytag')", (document_id,), "tagbefore"),
        ("UPDATE tags SET name = 'tagafter' WHERE tag_id = 'dirtytag'", (), "tagafter"),
    ]
    for sql, params, term in statements:
        with database.transaction() as connection:
            connection.execute(sql, params)
        if term:
            assert index.repair_pending() == 1
            assert client.get("/api/v1/search", params={"q": term}).json()

    response = client.post(
        f"/api/v1/pdfs/{document_id}/annotations",
        json={"page_number": 1, "annotation_type": "page_note", "note": "oldannotation"},
        headers=headers("dirty-annotation"),
    )
    assert response.status_code == 201
    with database.transaction() as connection:
        connection.execute(
            "UPDATE annotations SET note = 'changedannotation' WHERE document_id = ?",
            (document_id,),
        )
    assert index.repair_pending() == 1
    assert client.get("/api/v1/search", params={"q": "changedannotation"}).json()
    with database.transaction() as connection:
        connection.execute("DELETE FROM annotations WHERE document_id = ?", (document_id,))
        connection.execute("DELETE FROM document_tags WHERE document_id = ?", (document_id,))
    assert index.repair_pending() == 1
    assert client.get("/api/v1/search", params={"q": "changedannotation"}).json() == []
    assert client.get("/api/v1/search", params={"q": "tagafter"}).json() == []


def test_failed_repair_preserves_dirty_marker_and_previous_index(client, monkeypatch):
    doc = client.post(
        "/api/v1/documents",
        json={"title": "Before", "content": "originaltoken"},
        headers=headers("failed-repair"),
    ).json()
    index = client.app.state.services.documents.search_index
    with index.database.transaction() as connection:
        connection.execute(
            "UPDATE documents SET title = 'aftertoken' WHERE document_id = ?", (doc["document_id"],)
        )

    def fail(*args):
        raise RuntimeError("interrupted indexing")

    with monkeypatch.context() as patch:
        patch.setattr(index, "replace", fail)
        with pytest.raises(RuntimeError, match="interrupted indexing"):
            index.repair_pending()
    assert client.get("/api/v1/search", params={"q": "originaltoken"}).json()
    assert index.repair_pending() == 1
    assert client.get("/api/v1/search", params={"q": "aftertoken"}).json()


def test_stale_document_snapshot_cannot_clear_newer_search_change(client):
    doc = client.post(
        "/api/v1/documents",
        json={"title": "Before", "content": "originaltoken"},
        headers=headers("stale-index"),
    ).json()
    service = client.app.state.services.documents
    stale = service.get_document(doc["document_id"])
    with service.database.transaction() as connection:
        connection.execute(
            "UPDATE documents SET title = 'newertitle' WHERE document_id = ?", (doc["document_id"],)
        )
    service.search_index.sync(stale)
    assert client.get("/api/v1/search", params={"q": "newertitle"}).json()
    assert service.search_index.repair_pending() == 0


def test_rolled_back_change_does_not_require_repair(client):
    doc = client.post(
        "/api/v1/documents",
        json={"title": "Before", "content": "originaltoken"},
        headers=headers("rollback-index"),
    ).json()
    index = client.app.state.services.documents.search_index
    with pytest.raises(RuntimeError), index.database.transaction() as connection:
        connection.execute(
            "UPDATE documents SET title = 'rolledback' WHERE document_id = ?",
            (doc["document_id"],),
        )
        raise RuntimeError("rollback")
    assert index.repair_pending() == 0
    assert client.get("/api/v1/search", params={"q": "rolledback"}).json() == []
