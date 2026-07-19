from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from sangam.errors import IntegrationError


class FakeKarakeep:
    def __init__(self) -> None:
        self.version = 1
        self.available = True

    def health(self) -> None:
        if not self.available:
            raise IntegrationError("Karakeep is offline")

    def search(self, *, query: str, limit: int, cursor: str | None) -> dict[str, Any]:
        del query, limit, cursor
        return {"bookmarks": [self.bookmark("bookmark-1")], "nextCursor": None}

    def bookmark(self, bookmark_id: str) -> dict[str, Any]:
        if not self.available:
            raise IntegrationError("Karakeep is offline")
        body = (
            "<article><h2>Archived article</h2><p>Original research evidence.</p></article>"
            if self.version == 1
            else "<article><h2>Archived article</h2><p>Refreshed research evidence.</p></article>"
        )
        return {
            "id": bookmark_id,
            "createdAt": "2026-07-01T10:00:00Z",
            "modifiedAt": f"2026-07-0{self.version}T10:00:00Z",
            "title": "A useful archive",
            "archived": True,
            "favourited": False,
            "taggingStatus": "success",
            "summarizationStatus": "success",
            "note": None,
            "summary": "Research source",
            "source": "web",
            "userId": "user-1",
            "tags": [
                {"id": "tag-1", "name": "Research", "attachedBy": "human"},
                {"id": "tag-2", "name": "Evidence", "attachedBy": "ai"},
            ],
            "content": {
                "type": "link",
                "url": "https://example.com/research",
                "title": "A useful archive",
                "description": "Research source",
                "htmlContent": body,
                "author": "Example Author",
                "crawledAt": "2026-07-01T10:01:00Z",
                "crawlStatus": "success",
            },
            "assets": [
                {"id": "asset-1", "assetType": "fullPageArchive", "fileName": "archive.html"}
            ],
        }


def configure_fake(client: TestClient) -> FakeKarakeep:
    fake = FakeKarakeep()
    client.app.state.services.karakeep.client = fake
    return fake


def test_selective_import_is_attributed_searchable_and_idempotent(client: TestClient) -> None:
    configure_fake(client)

    health = client.get("/api/v1/karakeep/health")
    assert health.status_code == 200
    assert health.json()["connected"] is True

    bookmarks = client.get("/api/v1/karakeep/bookmarks", params={"q": "research"})
    assert bookmarks.status_code == 200
    assert bookmarks.json()["bookmarks"][0]["bookmark_id"] == "bookmark-1"

    imported = client.post(
        "/api/v1/karakeep/imports",
        json={"bookmark_id": "bookmark-1"},
        headers={"Idempotency-Key": "karakeep-import-1"},
    )
    assert imported.status_code == 201
    detail = imported.json()
    assert detail["status"] == "current"
    assert detail["source_url"] == "https://example.com/research"
    assert detail["author"] == "Example Author"
    assert detail["tags"] == ["Research", "Evidence"]
    assert detail["assets"] == [
        {"asset_id": "asset-1", "asset_type": "fullPageArchive", "file_name": "archive.html"}
    ]
    assert "Original research evidence" in detail["working_copy"]

    repeated = client.post(
        "/api/v1/karakeep/imports",
        json={"bookmark_id": "bookmark-1"},
        headers={"Idempotency-Key": "karakeep-import-2"},
    )
    assert repeated.status_code == 201
    assert repeated.json()["document_id"] == detail["document_id"]
    assert len(client.get("/api/v1/karakeep/imports").json()) == 1

    history = client.get(f"/api/v1/documents/{detail['document_id']}/history").json()
    assert history[0]["actor_id"] == "integration:karakeep"
    search = client.get("/api/v1/search", params={"q": "Original research evidence"})
    assert [item["document_id"] for item in search.json()] == [detail["document_id"]]
    document = client.get(f"/api/v1/documents/{detail['document_id']}").json()
    assert [tag["name"] for tag in document["tags"]] == ["Evidence", "Research"]


def test_refresh_requires_review_and_preserves_human_corrections(client: TestClient) -> None:
    fake = configure_fake(client)
    imported = client.post(
        "/api/v1/karakeep/imports",
        json={"bookmark_id": "bookmark-1"},
        headers={"Idempotency-Key": "initial-import"},
    ).json()
    document = client.get(f"/api/v1/documents/{imported['document_id']}").json()
    corrected_content = document["content"].replace(
        "Original research evidence.", "Human correction."
    )
    corrected = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={
            "expected_revision_id": document["current_revision_id"],
            "content": corrected_content,
            "summary": "Corrected imported article",
        },
        headers={"Idempotency-Key": "human-correction"},
    ).json()

    fake.version = 2
    refreshed = client.post(
        f"/api/v1/karakeep/imports/{imported['import_id']}/refresh",
        headers={"Idempotency-Key": "refresh-1"},
    )
    assert refreshed.status_code == 200
    review = refreshed.json()
    assert review["status"] == "review_required"
    assert "Original research evidence" in review["accepted_markdown"]
    assert "Refreshed research evidence" in review["pending_markdown"]
    assert "Human correction" in review["working_copy"]
    unchanged = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert unchanged["current_revision_id"] == corrected["current_revision_id"]
    assert "Human correction" in unchanged["content"]

    applied = client.post(
        f"/api/v1/karakeep/imports/{imported['import_id']}/apply",
        json={"expected_revision_id": corrected["current_revision_id"]},
        headers={"Idempotency-Key": "apply-reviewed-refresh"},
    )
    assert applied.status_code == 200
    assert applied.json()["status"] == "current"
    repeated_apply = client.post(
        f"/api/v1/karakeep/imports/{imported['import_id']}/apply",
        json={"expected_revision_id": corrected["current_revision_id"]},
        headers={"Idempotency-Key": "apply-reviewed-refresh"},
    )
    assert repeated_apply.status_code == 200
    assert repeated_apply.json()["status"] == "current"
    updated = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert "Refreshed research evidence" in updated["content"]
    history = client.get(f"/api/v1/documents/{document['document_id']}/history").json()
    assert history[0]["actor_id"] == "human:jay"
    assert history[0]["summary"] == "Applied reviewed Karakeep source refresh"


def test_failure_state_is_durable_and_retryable(client: TestClient) -> None:
    fake = configure_fake(client)
    fake.available = False
    failed = client.post(
        "/api/v1/karakeep/imports",
        json={"bookmark_id": "bookmark-1"},
        headers={"Idempotency-Key": "failed-import"},
    )
    assert failed.status_code == 502
    imports = client.get("/api/v1/karakeep/imports").json()
    assert imports[0]["status"] == "failed"
    assert imports[0]["last_error"] == "Karakeep is offline"

    fake.available = True
    retried = client.post(
        "/api/v1/karakeep/imports",
        json={"bookmark_id": "bookmark-1"},
        headers={"Idempotency-Key": "retry-import"},
    )
    assert retried.status_code == 201
    assert retried.json()["status"] == "current"

    service = client.app.state.services.karakeep
    with service.database.transaction() as connection:
        connection.execute(
            "UPDATE karakeep_imports SET status = 'importing' WHERE import_id = ?",
            (retried.json()["import_id"],),
        )
    service.recover_interrupted_imports()
    interrupted = client.get("/api/v1/karakeep/imports").json()[0]
    assert interrupted["status"] == "failed"
    assert "process restart" in interrupted["last_error"]

    resumed = client.post(
        f"/api/v1/karakeep/imports/{interrupted['import_id']}/refresh",
        headers={"Idempotency-Key": "resume-interrupted-refresh"},
    )
    assert resumed.status_code == 200
    assert resumed.json()["status"] == "current"
