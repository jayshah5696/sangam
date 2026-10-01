from conftest import headers
from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings


def test_document_backlinks_discovery_and_snippets(settings: Settings) -> None:
    app = create_app(settings)

    with TestClient(app) as client:
        # Create target document A
        res_a = client.post(
            "/api/v1/documents",
            headers=headers("doc-a"),
            json={
                "title": "Target Document",
                "path": "notes/target.md",
                "content": "# Target Doc\nCore concept.",
            },
        )
        assert res_a.status_code == 201
        doc_a = res_a.json()
        doc_a_id = doc_a["document_id"]

        # Create linking document B (sangam:// scheme)
        res_b = client.post(
            "/api/v1/documents",
            headers=headers("doc-b"),
            json={
                "title": "Referencing Doc B",
                "path": "notes/referencing_b.md",
                "content": (
                    f"# Document B\nSee [Target Doc](sangam://document/{doc_a_id}) for details."
                ),
            },
        )
        assert res_b.status_code == 201
        doc_b = res_b.json()

        # Create linking document C (/documents/ relative href)
        res_c = client.post(
            "/api/v1/documents",
            headers=headers("doc-c"),
            json={
                "title": "Referencing Doc C",
                "path": "notes/referencing_c.md",
                "content": f"# Document C\nRelated to [Target](/documents/{doc_a_id}) here.",
            },
        )
        assert res_c.status_code == 201
        doc_c = res_c.json()

        # Create unrelated document D
        res_d = client.post(
            "/api/v1/documents",
            headers=headers("doc-d"),
            json={
                "title": "Unrelated Doc D",
                "path": "notes/unrelated.md",
                "content": "# Unrelated",
            },
        )
        assert res_d.status_code == 201

        # Query backlinks for target doc A
        res_backlinks = client.get(f"/api/v1/documents/{doc_a_id}/backlinks")
        assert res_backlinks.status_code == 200
        backlinks = res_backlinks.json()
        backlink_ids = {b["document_id"] for b in backlinks}

        assert doc_b["document_id"] in backlink_ids
        assert doc_c["document_id"] in backlink_ids
        assert res_d.json()["document_id"] not in backlink_ids

        # Check search_snippet
        b_summary = next(b for b in backlinks if b["document_id"] == doc_b["document_id"])
        assert "Target Doc" in b_summary["search_snippet"]
        assert doc_a_id in b_summary["search_snippet"]

        # Rename / Move target document A: verify backlinks persist across rename
        res_move = client.post(
            f"/api/v1/documents/{doc_a_id}/move",
            headers={**headers("move-target"), "If-Match": res_a.headers["ETag"]},
            json={"path": "archive/target-renamed.md"},
        )
        assert res_move.status_code == 200

        res_backlinks_after_move = client.get(f"/api/v1/documents/{doc_a_id}/backlinks")
        assert res_backlinks_after_move.status_code == 200
        backlink_ids_after_move = {b["document_id"] for b in res_backlinks_after_move.json()}
        assert backlink_ids_after_move == backlink_ids

        # Update doc A to link to itself: ensure document does not include itself as a backlink
        res_self = client.patch(
            f"/api/v1/documents/{doc_a_id}",
            headers={**headers("self-link"), "If-Match": res_move.headers["ETag"]},
            json={
                "content": f"# Target Doc\nSelf reference [Self](sangam://document/{doc_a_id})",
                "expected_revision_id": res_move.json()["current_revision_id"],
            },
        )
        assert res_self.status_code == 200

        res_backlinks_self = client.get(f"/api/v1/documents/{doc_a_id}/backlinks")
        assert res_backlinks_self.status_code == 200
        assert doc_a_id not in {b["document_id"] for b in res_backlinks_self.json()}

        # Soft delete referencing doc C: ensure deleted documents do not appear in backlinks
        res_delete_c = client.request(
            "DELETE",
            f"/api/v1/documents/{doc_c['document_id']}",
            headers={**headers("delete-c"), "If-Match": res_c.headers["ETag"]},
            json={"expected_revision_id": doc_c["current_revision_id"]},
        )
        assert res_delete_c.status_code == 200

        res_backlinks_after_delete = client.get(f"/api/v1/documents/{doc_a_id}/backlinks")
        assert res_backlinks_after_delete.status_code == 200
        ids_after_delete = {b["document_id"] for b in res_backlinks_after_delete.json()}
        assert doc_c["document_id"] not in ids_after_delete
        assert doc_b["document_id"] in ids_after_delete
