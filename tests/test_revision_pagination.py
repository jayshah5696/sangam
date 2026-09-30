from __future__ import annotations

from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient


def create_document(client: TestClient, path: str, content: str = "first") -> dict[str, object]:
    response = client.post(
        "/api/v1/documents",
        headers=headers("create-" + path),
        json={"title": "History", "path": path, "content": content},
    )
    assert response.status_code == 201
    return response.json()


def revise_document(
    client: TestClient, document: dict[str, object], content: str
) -> dict[str, object]:
    response = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        headers=headers("revise-" + content[:20]),
        json={"expected_revision_id": document["current_revision_id"], "content": content},
    )
    assert response.status_code == 200
    return response.json()


def test_revision_pages_are_bounded_stable_and_fetch_exact_content(client: TestClient) -> None:
    document = create_document(client, "history/pages.md")
    document_ids = [document["current_revision_id"]]
    for index in range(1, 5):
        document = revise_document(client, document, f"revision {index}")
        document_ids.append(document["current_revision_id"])

    first = client.get(
        f"/api/v1/documents/{document['document_id']}/revisions", params={"limit": 2}
    )
    assert first.status_code == 200
    first_page = first.json()
    assert [item["revision_id"] for item in first_page["items"]] == list(
        reversed(document_ids[-2:])
    )
    assert all("content" not in item for item in first_page["items"])
    assert first_page["next_cursor"]

    # A revision added between page requests must not shift the older page boundary.
    document = revise_document(client, document, "concurrent newest revision")
    second = client.get(
        f"/api/v1/documents/{document['document_id']}/revisions",
        params={"limit": 2, "cursor": first_page["next_cursor"]},
    )
    assert second.status_code == 200
    second_page = second.json()
    assert [item["revision_id"] for item in second_page["items"]] == list(
        reversed(document_ids[-4:-2])
    )
    assert set(item["revision_id"] for item in first_page["items"]).isdisjoint(
        item["revision_id"] for item in second_page["items"]
    )

    exact_id = document_ids[1]
    exact = client.get(f"/api/v1/documents/{document['document_id']}/revisions/{exact_id}")
    assert exact.status_code == 200
    assert exact.json()["content"] == "revision 1"


def test_revision_page_rejects_invalid_limits_and_cursors(client: TestClient) -> None:
    document = create_document(client, "history/invalid.md")
    url = f"/api/v1/documents/{document['document_id']}/revisions"

    assert client.get(url, params={"limit": 101}).status_code == 422
    assert client.get(url, params={"limit": 0}).status_code == 422
    assert client.get(url, params={"cursor": "not-a-cursor"}).status_code == 422


def test_exact_revision_read_keeps_history_authorization_and_deleted_access(
    client: TestClient,
) -> None:
    document = create_document(client, "history/deleted.md", "deleted content")
    revision_id = document["current_revision_id"]
    deleted = client.request(
        "DELETE",
        f"/api/v1/documents/{document['document_id']}",
        headers=headers("delete-history"),
        json={"expected_revision_id": revision_id},
    )
    assert deleted.status_code == 200

    response = client.get(f"/api/v1/documents/{document['document_id']}/revisions/{revision_id}")
    assert response.status_code == 200
    assert response.json()["content"] == "deleted content"


def test_revision_reads_deny_out_of_scope_agent(client: TestClient) -> None:
    document = create_document(client, "private/history.md")
    token = issue_agent_token(client, path_prefix="agents")
    response = client.get(
        f"/api/v1/documents/{document['document_id']}/revisions",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 403


def test_large_revision_history_page_omits_content_and_stays_small(client: TestClient) -> None:
    large_content = "x" * 120_000
    document = create_document(client, "history/large.md", large_content)
    for index in range(8):
        document = revise_document(client, document, f"revision {index}" + large_content)

    response = client.get(
        f"/api/v1/documents/{document['document_id']}/revisions", params={"limit": 4}
    )

    assert response.status_code == 200
    assert len(response.content) < 12_000
    assert all("content" not in item for item in response.json()["items"])
