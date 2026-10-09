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

    # Issue token with update capability on wrong path prefix -> 403
    wrong_path_token = issue_agent_token(
        client, capabilities=("read", "update"), path_prefix="other"
    )
    wrong_path_headers = {"Authorization": f"Bearer {wrong_path_token}"}
    create_wrong_path = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Security",
            "start": 0,
            "end": 8,
            "body": "Comment attempt on wrong path",
        },
        headers={**wrong_path_headers, **headers("wrong-path-cmt")},
    )
    assert create_wrong_path.status_code == 403

    # Issue token with update capability on matching path prefix
    update_token = issue_agent_token(
        client, capabilities=("read", "update"), path_prefix="notes.md"
    )
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
    cmt_id = create_ok.json()["comment_id"]

    # Resolving comment on wrong path prefix -> 403
    resolve_wrong_path = client.post(
        f"/api/v1/documents/{doc_id}/comments/{cmt_id}/resolve",
        json={"resolved": True, "expected_version": 1},
        headers={**wrong_path_headers, **headers("wrong-path-resolve")},
    )
    assert resolve_wrong_path.status_code == 403

    # Resolving comment with matching path prefix -> 200
    resolve_ok = client.post(
        f"/api/v1/documents/{doc_id}/comments/{cmt_id}/resolve",
        json={"resolved": True, "expected_version": 1},
        headers={**update_headers, **headers("ok-resolve")},
    )
    assert resolve_ok.status_code == 200


def test_comment_input_sanitization(client: TestClient) -> None:
    doc = create_doc(client, "Doc 4", "Sanitization test document.")
    doc_id = doc["document_id"]
    rev_id = doc["current_revision_id"]

    # Null byte in body
    res_null_body = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Sanitization",
            "start": 0,
            "end": 12,
            "body": "Comment with null \x00 byte",
        },
        headers=headers("null-body-cmt"),
    )
    assert res_null_body.status_code == 422 or res_null_body.status_code == 400

    # Control char in exact
    res_ctrl_exact = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Sanitization\x07text",
            "start": 0,
            "end": 12,
            "body": "Valid body",
        },
        headers=headers("ctrl-exact-cmt"),
    )
    assert res_ctrl_exact.status_code == 422 or res_ctrl_exact.status_code == 400

    # Null byte in prefix
    res_null_prefix = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Sanitization",
            "prefix": "test\x00prefix",
            "start": 0,
            "end": 12,
            "body": "Valid body",
        },
        headers=headers("null-prefix-cmt"),
    )
    assert res_null_prefix.status_code == 422 or res_null_prefix.status_code == 400

    # Control char in suffix
    res_ctrl_suffix = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Sanitization",
            "suffix": "suffix\x1f",
            "start": 0,
            "end": 12,
            "body": "Valid body",
        },
        headers=headers("ctrl-suffix-cmt"),
    )
    assert res_ctrl_suffix.status_code == 422 or res_ctrl_suffix.status_code == 400

    # Start greater than end offset
    res_invalid_offsets = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Sanitization",
            "start": 12,
            "end": 5,
            "body": "Valid body",
        },
        headers=headers("invalid-offsets-cmt"),
    )
    assert res_invalid_offsets.status_code == 422 or res_invalid_offsets.status_code == 400

    # Blank comment body
    res_blank_body = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Sanitization",
            "start": 0,
            "end": 12,
            "body": "    ",
        },
        headers=headers("blank-body-cmt"),
    )
    assert res_blank_body.status_code == 422 or res_blank_body.status_code == 400


def test_concurrent_comment_resolution_version_precondition(client: TestClient) -> None:
    import concurrent.futures

    doc = create_doc(client, "Doc Concurrency", "Concurrent comment resolution test text.")
    doc_id = doc["document_id"]
    rev_id = doc["current_revision_id"]

    # Issue tokens for two separate agent identities
    token_agent1 = issue_agent_token(
        client, actor_id="agent:one", capabilities=("read", "update"), path_prefix="notes.md"
    )
    token_agent2 = issue_agent_token(
        client, actor_id="agent:two", capabilities=("read", "update"), path_prefix="notes.md"
    )

    # Create a comment
    create_res = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "Concurrent",
            "start": 0,
            "end": 10,
            "body": "Comment for concurrent resolve test",
        },
        headers=headers("create-cmt-conc"),
    )
    assert create_res.status_code == 201, create_res.text
    comment = create_res.json()
    comment_id = comment["comment_id"]
    assert comment["version"] == 1

    results = []

    def resolve_agent(agent_idx: int, token: str, resolve_val: bool):
        agent_headers = {
            "Authorization": f"Bearer {token}",
            **headers(f"agent-{agent_idx}-resolve"),
        }
        res = client.post(
            f"/api/v1/documents/{doc_id}/comments/{comment_id}/resolve",
            json={"resolved": resolve_val, "expected_version": 1},
            headers=agent_headers,
        )
        results.append(res)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(resolve_agent, 1, token_agent1, True)
        f2 = executor.submit(resolve_agent, 2, token_agent2, False)
        f1.result(timeout=10)
        f2.result(timeout=10)

    status_codes = sorted(r.status_code for r in results)
    assert status_codes == [200, 409], (
        f"Expected exactly one winner (200) and one conflict (409), got: {status_codes}"
    )

    winning_resp = next(r for r in results if r.status_code == 200)
    winning_comment = winning_resp.json()
    assert winning_comment["version"] == 2

    losing_resp = next(r for r in results if r.status_code == 409)
    assert losing_resp.json()["error"]["code"] in (
        "revision_conflict",
        "comment_version_mismatch",
        "conflict",
    )


def test_agent_comment_reads_are_audited_and_scoped(client: TestClient) -> None:
    doc = create_doc(client, "Audit Doc", "Document for comment audit testing.", path="notes.md")
    doc_id = doc["document_id"]
    rev_id = doc["current_revision_id"]

    # Post a comment as human
    comment_res = client.post(
        f"/api/v1/documents/{doc_id}/comments",
        json={
            "revision_id": rev_id,
            "exact": "comment audit",
            "start": 13,
            "end": 26,
            "body": "Audit test comment",
        },
        headers=headers("audit-cmt-1"),
    )
    assert comment_res.status_code == 201
    comment_id = comment_res.json()["comment_id"]

    # Issue agent token scoped to notes.md
    agent_token = issue_agent_token(client, capabilities=("read",), path_prefix="notes.md")
    agent_headers = {"Authorization": f"Bearer {agent_token}"}

    # List comments as agent
    list_res = client.get(f"/api/v1/documents/{doc_id}/comments", headers=agent_headers)
    assert list_res.status_code == 200
    assert len(list_res.json()) == 1

    # Get single comment as agent
    get_res = client.get(f"/api/v1/documents/{doc_id}/comments/{comment_id}", headers=agent_headers)
    assert get_res.status_code == 200
    assert get_res.json()["comment_id"] == comment_id

    # Check activity ledger for agent events
    activity_res = client.get("/api/v1/activity?actor_kind=agent")
    assert activity_res.status_code == 200
    events = activity_res.json()
    actions = [e["action"] for e in events]
    assert "list_comments" in actions
    assert "get_comment" in actions

    # Agent with different path prefix scope is denied
    other_token = issue_agent_token(client, capabilities=("read",), path_prefix="other")
    other_headers = {"Authorization": f"Bearer {other_token}"}

    denied_list = client.get(f"/api/v1/documents/{doc_id}/comments", headers=other_headers)
    assert denied_list.status_code == 403

    denied_get = client.get(
        f"/api/v1/documents/{doc_id}/comments/{comment_id}", headers=other_headers
    )
    assert denied_get.status_code == 403
