"""Tests for anchored comments on Markdown and HTML document passages."""

from __future__ import annotations

from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient


def create_doc(client: TestClient, title: str, content: str, path: str = "notes.md") -> dict:
    res = client.post(
        "/api/v1/documents",
        json={"title": title, "content": content, "path": path, "content_type": "text/markdown"},
        headers=headers("create-doc-" + title),
    )
    assert res.status_code == 201, res.text
    return res.json()


def test_comment_lifecycle_create_list_resolve(client: TestClient) -> None:
    content = "Hello world! This is a test document with interesting content."
    doc = create_doc(client, "Doc 1", content)
    doc_id = doc["document_id"]
    rev_id = doc["current_revision_id"]

    exact = "interesting content"
    start = content.index(exact)
    end = start + len(exact)

    # 1. Create a comment
    create_res = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": exact,
            "prefix": "document with ",
            "suffix": ".",
            "start": start,
            "end": end,
            "body": "Could we elaborate on what makes it interesting?",
        },
        headers=headers("comment-1"),
    )
    assert create_res.status_code == 201, create_res.text
    comment = create_res.json()
    assert comment["comment_id"].startswith("cmt_")
    assert comment["exact"] == exact
    assert comment["body"] == "Could we elaborate on what makes it interesting?"
    assert comment["resolved_at"] is None
    assert comment["version"] == 1

    # 2. List comments
    list_res = client.get(f"/api/v1/documents/{doc_id}/comments")
    assert list_res.status_code == 200
    comments = list_res.json()
    assert len(comments) == 1
    assert comments[0]["comment_id"] == comment["comment_id"]

    # 3. Resolve the comment
    resolve_res = client.post(
        f"/api/v1/documents/{doc_id}/comments/{comment['comment_id']}/resolve",
        json={"resolved": True, "expected_version": 1},
    )
    assert resolve_res.status_code == 200, resolve_res.text
    resolved_comment = resolve_res.json()
    assert resolved_comment["resolved_at"] is not None
    assert resolved_comment["version"] == 2

    # 4. List open only vs all
    open_res = client.get(f"/api/v1/documents/{doc_id}/comments?include_resolved=false")
    assert open_res.status_code == 200
    assert len(open_res.json()) == 0

    all_res = client.get(f"/api/v1/documents/{doc_id}/comments?include_resolved=true")
    assert all_res.status_code == 200
    assert len(all_res.json()) == 1

    # 5. Reopen the comment
    reopen_res = client.post(
        f"/api/v1/documents/{doc_id}/comments/{comment['comment_id']}/resolve",
        json={"resolved": False, "expected_version": 2},
    )
    assert reopen_res.status_code == 200
    reopened = reopen_res.json()
    assert reopened["resolved_at"] is None
    assert reopened["version"] == 3


def test_comment_idempotency_and_version_conflict(client: TestClient) -> None:
    doc = create_doc(client, "Doc 2", "Sample text here.")
    doc_id = doc["document_id"]
    rev_id = doc["current_revision_id"]

    # Post comment with idempotency key
    res1 = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Sample",
            "start": 0,
            "end": 6,
            "body": "First comment",
        },
        headers=headers("idemp-cmt"),
    )
    assert res1.status_code == 201

    # Replay with same key
    res2 = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Sample",
            "start": 0,
            "end": 6,
            "body": "First comment",
        },
        headers=headers("idemp-cmt"),
    )
    assert res2.status_code == 201
    assert res1.json()["comment_id"] == res2.json()["comment_id"]

    # Version conflict on resolve
    conflict_res = client.post(
        f"/api/v1/documents/{doc_id}/comments/{res1.json()['comment_id']}/resolve",
        json={"resolved": True, "expected_version": 99},
    )
    assert conflict_res.status_code == 409


def test_comment_authorization(client: TestClient) -> None:
    doc = create_doc(client, "Doc 3", "Security text.")
    doc_id = doc["document_id"]
    rev_id = doc["current_revision_id"]

    # Issue token with read only
    read_token = issue_agent_token(client, capabilities=("read",))
    read_headers = {"Authorization": f"Bearer {read_token}"}

    # Reading comments succeeds
    get_res = client.get(f"/api/v1/documents/{doc_id}/comments", headers=read_headers)
    assert get_res.status_code == 200

    # Creating comment fails (needs update capability)
    create_res = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Security",
            "start": 0,
            "end": 8,
            "body": "Unauthorized comment attempt",
        },
        headers={**read_headers, **headers("fail-cmt")},
    )
    assert create_res.status_code == 403

    # Issue token with update capability
    update_token = issue_agent_token(client, capabilities=("read", "update"))
    update_headers = {"Authorization": f"Bearer {update_token}"}

    create_ok = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Security",
            "start": 0,
            "end": 8,
            "body": "Authorized comment",
        },
        headers={**update_headers, **headers("ok-cmt")},
    )
    assert create_ok.status_code == 201
