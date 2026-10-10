from __future__ import annotations

import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient


def create(client, path="docs/item.md", content="base", content_type="text/markdown"):
    response = client.post(
        "/api/v1/documents",
        json=dict(title="Contract", path=path, content=content, content_type=content_type),
        headers=headers(f"create-{path}"),
    )
    assert response.status_code == 201, response.text
    return response


@pytest.mark.parametrize(
    "scope", ["//", "*/*", "**/**", "docs/*/", "docs/**/x", "docs//x", "\n*", "\r/**"]
)
def test_invalid_scopes_never_issue_global_grants(client: TestClient, scope):
    response = client.post(
        "/api/v1/agent-tokens",
        json=dict(
            actor_id="agent:invalid",
            display_name="Invalid",
            label="Invalid",
            scopes=[dict(capability="read", path_prefix=scope)],
        ),
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "param_name,invalid_value",
    [
        ("q", "search\x00term"),
        ("q", "search\x07term"),
        ("category", "cat\x00egory"),
        ("actor_id", "agent\x00id"),
        ("tag_id", "tag\x00id"),
    ],
)
def test_search_documents_rejects_null_bytes_and_control_chars(
    client: TestClient, param_name, invalid_value
):
    response = client.get("/api/v1/search", params={param_name: invalid_value})
    assert response.status_code == 422
    assert "cannot contain" in response.json()["error"]["message"]


@pytest.mark.parametrize(
    "field_name,invalid_value",
    [
        ("query", "search\x00term"),
        ("tag_id", "tag\x00id"),
    ],
)
def test_saved_views_rejects_null_bytes_and_control_chars_in_filters(
    client: TestClient, field_name, invalid_value
):
    response = client.post(
        "/api/v1/saved-views",
        json={
            "name": "Valid Name",
            "filters": {field_name: invalid_value},
        },
        headers=headers("save-view-invalid"),
    )
    assert response.status_code == 422
    assert "cannot contain" in response.json()["error"]["message"]


def test_pdf_search_and_annotations_query_reject_null_bytes(client: TestClient):
    # Import a simple PDF document first
    pdf_content = b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<\n/Root 1 0 R\n>>\n%%EOF"
    imported = client.post(
        "/api/v1/pdfs",
        params={"title": "Test PDF", "path": "docs/test.pdf"},
        content=pdf_content,
        headers={"Content-Type": "application/pdf", **headers("import-pdf")},
    )
    assert imported.status_code == 201
    doc_id = imported.json()["document_id"]

    search_res = client.get(f"/api/v1/pdfs/{doc_id}/search", params={"q": "term\x00null"})
    assert search_res.status_code == 422

    annotations_res = client.get(
        f"/api/v1/pdfs/{doc_id}/annotations", params={"q": "term\x00null"}
    )
    assert annotations_res.status_code == 422


@pytest.mark.parametrize(
    "prefix,path,expected",
    [
        (None, "docs/item.md", True),
        ("docs", None, False),
        ("", "docs/item.md", True),
        ("/", "docs/item.md", True),
        ("docs", "docs", True),
        ("docs", "docs/", True),
        ("docs/", "docs", True),
        ("docs", "docs/item.md", True),
        ("docs/", "docs/item.md", True),
        ("docs", "docs-private/secret.md", False),
        ("docs", "docs_extra/item.md", False),
        ("docs/sub", "docs/sub/item.md", True),
        ("docs/sub", "docs/sub_extra/item.md", False),
    ],
)
def test_path_matches_component_boundaries(prefix, path, expected):
    from sangam.security import path_matches

    assert path_matches(prefix, path) is expected


def test_agent_scope_boundary_enforcement(client: TestClient):
    token = issue_agent_token(
        client,
        actor_id="agent:boundary",
        display_name="Boundary Agent",
        capabilities=("read", "create"),
        path_prefix="docs",
    )
    auth = {"Authorization": f"Bearer {token}"}

    # Allowed in docs/
    allowed = client.post(
        "/api/v1/documents",
        json=dict(title="Allowed", content="ok", path="docs/item.md"),
        headers={**auth, **headers("boundary-allowed")},
    )
    assert allowed.status_code == 201

    # Denied in docs-private/
    denied = client.post(
        "/api/v1/documents",
        json=dict(title="Denied", content="secret", path="docs-private/secret.md"),
        headers={**auth, **headers("boundary-denied")},
    )
    assert denied.status_code == 403


@pytest.mark.parametrize("scope", ["docs/*", "docs/**", "/*", "/**", "*", "**"])
def test_wildcard_issuance_and_recursive_access(client: TestClient, scope):
    token = issue_agent_token(client, capabilities=("read", "create"), path_prefix=scope)
    auth = {"Authorization": f"Bearer {token}"}
    result = client.post(
        "/api/v1/documents",
        json=dict(title="Allowed", content="ok", path="docs/nested/deep.md"),
        headers={**auth, **headers("allowed")},
    )
    assert result.status_code == 201
    assert (
        client.get(f"/api/v1/documents/{result.json()['document_id']}", headers=auth).status_code
        == 200
    )
    outside = client.post(
        "/api/v1/documents",
        json=dict(title="Outside", content="ok", path="outside/item.md"),
        headers={**auth, **headers("outside")},
    )
    assert outside.status_code == (403 if scope.startswith("docs") else 201)


@pytest.mark.parametrize(
    "tag,status",
    [
        ('"*"', 412),
        ('W/"CURRENT"', 412),
        ('"missing", "CURRENT"', 200),
        ('"a,b", "CURRENT"', 200),
        ("unquoted", 422),
        ("'CURRENT'", 422),
        ('"unterminated', 422),
        ('*, "CURRENT"', 422),
        ('"CURRENT" trailing', 422),
        ("", 422),
    ],
)
def test_write_tag_grammar_and_strong_list_or(client: TestClient, tag, status):
    created = create(client)
    url = f"/api/v1/documents/{created.json()['document_id']}"
    current = client.get(url).headers["etag"]
    value = tag.replace('"CURRENT"', current).replace("'CURRENT'", "'" + current[1:-1] + "'")
    result = client.patch(
        url, json={"content": "changed"}, headers={**headers("grammar"), "If-Match": value}
    )
    assert result.status_code == status, result.text
    assert client.get(url).json()["content"] == ("changed" if status == 200 else "base")
    events = client.get("/api/v1/activity", params={"actor_kind": "human"}).json()
    assert any(
        e["action"] == "update"
        and e["resource_id"] == created.json()["document_id"]
        and e["outcome"]
        == ("accepted" if status == 200 else "conflict" if status == 412 else "failed")
        for e in events
    )


@pytest.mark.parametrize("suffix", ["", "/raw", "/download"])
def test_read_conditions_weak_lists_wildcards_and_precedence(client: TestClient, suffix):
    created = create(client)
    url = f"/api/v1/documents/{created.json()['document_id']}{suffix}"
    tag = client.get(url).headers["etag"]
    for value in [f"W/{tag}", f'"other,tag", W/{tag}', "*"]:
        result = client.get(url, headers={"If-None-Match": value})
        assert result.status_code == 304
        assert result.content == b""
        assert result.headers["etag"] == tag
    assert client.get(url, headers={"If-None-Match": '"*"'}).status_code == 200
    assert client.get(url, headers={"If-Match": f"W/{tag}"}).status_code == 412
    assert (
        client.get(url, headers={"If-Match": '"missing"', "If-None-Match": "*"}).status_code == 412
    )
    assert client.get(url, headers={"If-None-Match": "broken"}).status_code == 422


def test_metadata_trust_and_extraction_invalidate_json_validator(client: TestClient):
    created = create(client, "docs/item.html", "<p>base</p>", "text/html")
    doc = created.json()
    url = f"/api/v1/documents/{doc['document_id']}"
    etag = client.get(url).headers["etag"]
    metadata = client.patch(
        url + "/metadata",
        json=dict(expected_metadata_version=doc["metadata_version"], category="new", tag_ids=[]),
        headers={**headers("metadata"), "If-Match": etag},
    )
    assert metadata.status_code == 200
    assert metadata.json()["current_revision_id"] == doc["current_revision_id"]
    next_tag = client.get(url, headers={"If-None-Match": etag})
    assert next_tag.status_code == 200
    assert next_tag.headers["etag"] != etag
    stale = client.patch(
        url + "/metadata",
        json=dict(
            expected_metadata_version=metadata.json()["metadata_version"],
            category="bad",
            tag_ids=[],
        ),
        headers={**headers("stale-metadata"), "If-Match": etag},
    )
    assert stale.status_code == 412
    trust = client.patch(
        url + "/trust",
        json=dict(expected_trust_version=doc["trust_version"], trust_level="trusted_interactive"),
        headers={**headers("trust"), "If-Match": next_tag.headers["etag"]},
    )
    assert trust.status_code == 200
    assert client.get(url, headers={"If-None-Match": next_tag.headers["etag"]}).status_code == 200
    assert (
        client.patch(
            url + "/trust",
            json=dict(
                expected_trust_version=trust.json()["trust_version"], trust_level="untrusted"
            ),
            headers={**headers("stale-trust"), "If-Match": etag},
        ).status_code
        == 412
    )


@pytest.mark.parametrize(
    "action", ["update", "move", "materialize", "delete", "restore", "duplicate"]
)
def test_all_mutations_false_condition_and_stable_wildcard_replay(client: TestClient, action):
    created = create(client, None if action == "materialize" else "docs/item.md")
    doc = created.json()
    url = f"/api/v1/documents/{doc['document_id']}"
    method = "PATCH" if action == "update" else "DELETE" if action == "delete" else "POST"
    target = url if action in {"update", "delete"} else url + "/" + action
    body = (
        {"content": "changed"}
        if action == "update"
        else {"path": "docs/next.md"}
        if action in {"move", "materialize", "duplicate"}
        else {"revision_id": doc["current_revision_id"]}
        if action == "restore"
        else {}
    )
    rejected = client.request(
        method, target, json=body, headers={**headers("false"), "If-Match": '"*"'}
    )
    assert rejected.status_code == 412
    supplied = {**headers("wildcard"), "If-Match": "*"}
    first = client.request(method, target, json=body, headers=supplied)
    assert first.status_code == (201 if action == "duplicate" else 200), first.text
    replay = client.request(method, target, json=body, headers=supplied)
    assert replay.status_code == first.status_code, replay.text
    assert replay.json()["current_revision_id"] == first.json()["current_revision_id"]
    assert replay.json()["document_id"] == first.json()["document_id"]
    replay_events = client.get("/api/v1/activity", params={"actor_kind": "human"}).json()
    assert [
        event["resource_id"]
        for event in replay_events
        if event["operation_id"] == replay.headers["X-Operation-ID"]
    ] == [first.json()["document_id"]]
    changed = client.request(
        method, target, json=body, headers={**headers("wildcard"), "If-Match": '"changed"'}
    )
    assert changed.status_code == 409


def test_body_conflicts_remain_409_and_header_failures_412(client: TestClient):
    created = create(client)
    url = f"/api/v1/documents/{created.json()['document_id']}"
    assert (
        client.patch(
            url, json=dict(content="bad", expected_revision_id="stale"), headers=headers("body")
        ).status_code
        == 409
    )
    assert (
        client.patch(
            url,
            json=dict(content="bad", expected_revision_id="stale"),
            headers={**headers("both"), "If-Match": '"false"'},
        ).status_code
        == 412
    )
    assert (
        client.patch(
            url, json=dict(content="bad"), headers={**headers("none"), "If-None-Match": "*"}
        ).status_code
        == 412
    )


def test_scoped_denial_precedes_parsing_and_is_audited(client: TestClient):
    created = create(client)
    token = issue_agent_token(client, capabilities=("read", "update"), path_prefix="other")
    url = f"/api/v1/documents/{created.json()['document_id']}"
    auth = {"Authorization": f"Bearer {token}", "If-Match": "malformed"}
    assert (
        client.patch(
            url, json={"content": "bad"}, headers={**auth, **headers("denied")}
        ).status_code
        == 403
    )
    assert client.get(url, headers=auth).status_code == 403
    events = client.get("/api/v1/activity", params={"actor_kind": "agent"}).json()
    assert any(e["action"] == "update" and e["outcome"] == "denied" for e in events)


def test_issue_trusted_preview_enforces_read_scope_and_records_audit(client: TestClient):
    html_doc = create(
        client, path="docs/page.html", content="<h1>HTML</h1>", content_type="text/html"
    )
    doc_id = html_doc.json()["document_id"]
    rev_id = html_doc.json()["current_revision_id"]

    denied_token = issue_agent_token(client, capabilities=("read",), path_prefix="other")
    denied_res = client.post(
        f"/api/v1/documents/{doc_id}/trusted-preview",
        params={"revision_id": rev_id},
        headers={"Authorization": f"Bearer {denied_token}"},
    )
    assert denied_res.status_code == 403

    allowed_token = issue_agent_token(client, capabilities=("read",), path_prefix="docs")
    allowed_res = client.post(
        f"/api/v1/documents/{doc_id}/trusted-preview",
        params={"revision_id": rev_id},
        headers={"Authorization": f"Bearer {allowed_token}"},
    )
    assert allowed_res.status_code == 200
    assert "token" in allowed_res.json()

    events = client.get("/api/v1/activity", params={"actor_kind": "agent"}).json()
    accepted = [
        e for e in events if e["action"] == "issue_trusted_preview" and e["outcome"] == "accepted"
    ]
    denied = [
        e for e in events if e["action"] == "issue_trusted_preview" and e["outcome"] == "denied"
    ]
    assert len(accepted) >= 1
    assert len(denied) >= 1
    assert accepted[0]["resource_id"] == doc_id
    assert accepted[0].get("details", {}).get("revision_id") == rev_id


def test_coordinated_agents_one_strong_winner_then_wildcard_uses_new_head(
    client: TestClient, settings
):
    created = create(client)
    doc_id = created.json()["document_id"]
    url = f"/api/v1/documents/{doc_id}"
    etag = client.get(url).headers["etag"]
    tokens = [
        issue_agent_token(
            client,
            actor_id=f"agent:writer{i}",
            display_name=f"Writer {i}",
            capabilities=("read", "update"),
            path_prefix="docs",
        )
        for i in range(2)
    ]
    coordinator = client.app.state.services.documents.mutations
    start = threading.Barrier(3)

    def update(i, condition):
        start.wait(timeout=10)
        return client.patch(
            url,
            json={"content": f"writer{i}"},
            headers={
                **headers(f"writer{i}"),
                "Authorization": f"Bearer {tokens[i]}",
                "If-Match": condition,
            },
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        with coordinator.document(doc_id):
            futures = [executor.submit(update, i, etag) for i in range(2)]
            start.wait(timeout=10)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                with coordinator._condition:
                    if coordinator._document_lock_users[doc_id] >= 3:
                        break
                time.sleep(0.01)
            else:
                pytest.fail("Both real requests did not reach the coordinated document boundary")
        results = [f.result(timeout=10) for f in futures]
    assert sorted(r.status_code for r in results) == [200, 412]
    final = client.get(url).json()
    assert (settings.workspace_root / "docs/item.md").read_text() == final["content"]
    assert len(client.get(url + "/history").json()) == 2
    assert (
        client.get("/api/v1/search", params={"q": final["content"]}).json()[0]["document_id"]
        == doc_id
    )


SECRETS = [
    "glpat-abcdefghijklmnop",
    "xoxb-1234567890-abcdefghij",
    "github_pat_abcdefghijklmnopqrstuv",
    "AKIA1234567890123456",
    "sgm_agt_98765",
    "sk-abcdefghijkl",
    "-----BEGIN PRIVATE KEY-----\nPRIVATE-MATERIAL\n-----END PRIVATE KEY-----",
]


@pytest.mark.parametrize("secret", SECRETS)
def test_audit_redacts_persisted_diff_path_json_and_jsonl(client: TestClient, secret):
    path = "docs/" + (secret if "\n" not in secret else "pem") + ".md"
    created = create(client, path, "Ordinary text\n" + secret)
    doc_id = created.json()["document_id"]
    rows = client.app.state.services.documents.database
    with rows.connection() as connection:
        persisted = [
            dict(row)
            for row in connection.execute(
                "SELECT * FROM operation_events WHERE resource_id = ?", (doc_id,)
            )
        ]
    assert persisted
    surfaces = [
        json.dumps(persisted),
        client.get("/api/v1/activity", params={"actor_kind": "human"}).text,
        client.get("/api/v1/activity/export.jsonl", params={"actor_kind": "human"}).text,
    ]
    for surface in surfaces:
        assert secret not in surface
        assert "PRIVATE-MATERIAL" not in surface
        assert "[REDACTED]" in surface
    assert client.get(f"/api/v1/documents/{doc_id}").json()["content"] == "Ordinary text\n" + secret


def test_organization_ancestor_is_structural_and_pagination_filters_first(client: TestClient):
    create(client, "a-hidden/item.md")
    create(client, "root/private/item.md")
    create(client, "root/public/nested/item.md")
    folder = next(f for f in client.get("/api/v1/folders").json() if f["path"] == "root")
    changed_folder = client.patch(
        f"/api/v1/folders/{folder['folder_id']}",
        json=dict(
            expected_metadata_version=folder["metadata_version"], category="secret", tag_ids=[]
        ),
        headers=headers("ancestor-metadata"),
    )
    assert changed_folder.status_code == 200, changed_folder.text
    token = issue_agent_token(client, capabilities=("read",), path_prefix="root/public/*")
    auth = {"Authorization": f"Bearer {token}"}
    folders = client.get("/api/v1/folders", headers=auth).json()
    ancestor = next(f for f in folders if f["path"] == "root")
    assert ancestor["category"] is None and ancestor["tags"] == []
    assert ancestor["document_count"] == 1
    page = client.get(
        "/api/v1/organization", params=dict(item_type="folder", limit=1), headers=auth
    )
    assert page.status_code == 200, page.text
    assert page.json()["items"] and page.json()["next_offset"] == 1
    tags = client.get("/api/v1/organization", params=dict(item_type="tag"), headers=auth)
    assert tags.json()["items"] == []
    events = client.get("/api/v1/activity", params=dict(actor_kind="agent")).json()
    assert any(e["action"] == "list_organization" for e in events)


def test_rejected_read_headers_and_version_conflicts_have_no_accepted_audit(client):
    created = create(client)
    url = f"/api/v1/documents/{created.json()['document_id']}"
    token = issue_agent_token(client, capabilities=("read", "tag"), path_prefix="docs")
    auth = {"Authorization": f"Bearer {token}"}
    read = client.get(
        url, headers={**auth, "If-Match": '"false"', "X-Sangam-Operation-Id": "read-failure"}
    )
    assert read.status_code == 412
    metadata = client.patch(
        url + "/metadata",
        json=dict(expected_metadata_version=99, category="bad", tag_ids=[]),
        headers={
            **auth,
            **headers("bad-version"),
            "If-Match": "*",
            "X-Sangam-Operation-Id": "version-failure",
        },
    )
    assert metadata.status_code == 409
    events = client.get("/api/v1/activity", params={"actor_kind": "agent"}).json()
    for operation in [read.headers["X-Operation-Id"], metadata.headers["X-Operation-Id"]]:
        matching = [e for e in events if e["operation_id"] == operation]
        assert [e["outcome"] for e in matching] == ["conflict"]


def test_deleted_restore_and_wildcard_wait_for_coordinated_head(client):
    created = create(client)
    doc_id = created.json()["document_id"]
    url = f"/api/v1/documents/{doc_id}"
    coordinator = client.app.state.services.documents.mutations
    start = threading.Barrier(2)

    def waiting_update():
        start.wait(timeout=10)
        return client.patch(
            url, json={"content": "after"}, headers={**headers("waiting"), "If-Match": "*"}
        )

    with ThreadPoolExecutor(max_workers=1) as executor:
        with coordinator.document(doc_id):
            future = executor.submit(waiting_update)
            start.wait(timeout=10)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                with coordinator._condition:
                    if coordinator._document_lock_users[doc_id] >= 2:
                        break
                time.sleep(0.01)
            else:
                pytest.fail("Wildcard request did not reach document boundary")
            service = client.app.state.services.documents
            service.update_document(
                document_id=doc_id,
                expected_revision_id=created.json()["current_revision_id"],
                content="middle",
                title=None,
                summary=None,
                actor_id="human:jay",
                idempotency_key="middle",
            )
        assert future.result(timeout=10).status_code == 200
    assert client.get(url).json()["content"] == "after"
    deleted = client.request("DELETE", url, json={}, headers={**headers("trash"), "If-Match": "*"})
    assert deleted.status_code == 200
    restored = client.post(
        url + "/restore",
        json={"revision_id": created.json()["current_revision_id"]},
        headers={**headers("restore-trash"), "If-Match": "*"},
    )
    assert restored.status_code == 200 and not restored.json()["deleted"]


def test_openapi_declares_representation_etags_and_preconditions(client):
    schema = client.get("/api/v1/openapi.json").json()
    assert "ETag" in schema["paths"]["/api/v1/documents"]["post"]["responses"]["201"]["headers"]
    assert (
        "X-Sangam-Revision-ID"
        in schema["paths"]["/api/v1/documents/{document_id}"]["get"]["responses"]["200"]["headers"]
    )
    for suffix in ["", "/raw", "/download"]:
        operation = schema["paths"]["/api/v1/documents/{document_id}" + suffix]["get"]
        assert {"304", "412"} <= operation["responses"].keys()
        assert "ETag" in operation["responses"]["200"]["headers"]
    for suffix, method in [
        ("", "patch"),
        ("", "delete"),
        ("/move", "post"),
        ("/materialize", "post"),
        ("/restore", "post"),
        ("/duplicate", "post"),
        ("/metadata", "patch"),
        ("/trust", "patch"),
    ]:
        operation = schema["paths"]["/api/v1/documents/{document_id}" + suffix][method]
        assert "412" in operation["responses"]


def test_nested_document_pipeline_finishes_before_waiting_backup():
    from sangam.mutations import MutationCoordinator

    coordinator = MutationCoordinator()
    acquired = threading.Event()
    enter_nested = threading.Event()
    finished = threading.Event()
    backup_finished = threading.Event()

    def mutate():
        with coordinator.document("document"):
            acquired.set()
            assert enter_nested.wait(timeout=10)
            with coordinator.document("document"):
                finished.set()

    def backup():
        with coordinator.backup():
            backup_finished.set()

    first = threading.Thread(target=mutate, daemon=True)
    first.start()
    assert acquired.wait(timeout=10)
    second = threading.Thread(target=backup, daemon=True)
    second.start()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with coordinator._condition:
            if coordinator._waiting_backups:
                break
        time.sleep(0.01)
    else:
        pytest.fail("Backup did not reach generation barrier")
    enter_nested.set()
    assert finished.wait(timeout=2), (
        "Nested coordinated pipeline deadlocked behind its own waiting backup"
    )
    assert backup_finished.wait(timeout=10)
    first.join(timeout=10)
    second.join(timeout=10)


def test_conditional_replay_repairs_committed_pending_materialization(client, settings):
    created = create(client, None)
    url = f"/api/v1/documents/{created.json()['document_id']}/materialize"
    settings.workspace_root.joinpath("docs").write_text("obstructing file")
    body = {"path": "docs/item.md"}
    supplied = {**headers("pending-materialize"), "If-Match": "*"}
    first = client.post(url, json=body, headers=supplied)
    assert first.status_code == 503
    settings.workspace_root.joinpath("docs").unlink()
    replay = client.post(url, json=body, headers=supplied)
    assert replay.status_code == 200
    assert replay.json()["materialization_state"] == "clean"
    assert settings.workspace_root.joinpath("docs/item.md").read_text() == "base"


def test_duplicate_replay_reauthorizes_actual_result_path(client):
    created = create(client)
    source = f"/api/v1/documents/{created.json()['document_id']}"
    token = issue_agent_token(client, capabilities=("read", "create"), path_prefix="docs")
    auth = {"Authorization": f"Bearer {token}", **headers("scoped-duplicate"), "If-Match": "*"}
    duplicated = client.post(source + "/duplicate", json={"path": "docs/copy.md"}, headers=auth)
    assert duplicated.status_code == 201
    copied = f"/api/v1/documents/{duplicated.json()['document_id']}"
    moved = client.post(
        copied + "/move",
        json={"path": "private/copy.md"},
        headers={**headers("move-copy"), "If-Match": "*"},
    )
    assert moved.status_code == 200
    assert (
        client.post(source + "/duplicate", json={"path": "docs/copy.md"}, headers=auth).status_code
        == 403
    )


def test_partial_pem_change_does_not_expose_material_in_audit_diff(client):
    lines = [f"PRIVATE-LINE-{i:02d}-MATERIAL" for i in range(20)]
    content = "-----BEGIN PRIVATE KEY-----\n" + "\n".join(lines) + "\n-----END PRIVATE KEY-----"
    created = create(client, content=content)
    changed = content.replace(lines[10], "NEW-PRIVATE-MATERIAL")
    url = f"/api/v1/documents/{created.json()['document_id']}"
    update = client.patch(
        url, json={"content": changed}, headers={**headers("partial-pem"), "If-Match": "*"}
    )
    assert update.status_code == 200
    with client.app.state.services.documents.database.connection() as connection:
        rows = [
            dict(row)
            for row in connection.execute("SELECT * FROM operation_events WHERE action = 'update'")
        ]
    assert rows
    serialized = json.dumps(rows)
    assert "NEW-PRIVATE-MATERIAL" not in serialized and "PRIVATE-LINE-" not in serialized
    details = json.loads(rows[0]["detail_json"])
    assert details["lines_added"] == 1 and details["lines_removed"] == 1


def test_organization_document_pages_use_one_authorized_order(client):
    for path in ["root/a.md", "root/b.md", "root/c.md", "root/d.md", "root/e.md", "private/z.md"]:
        create(client, path)
    token = issue_agent_token(client, capabilities=("read",), path_prefix="root/*")
    auth = {"Authorization": f"Bearer {token}"}
    paths = []
    offset = 0
    while True:
        response = client.get(
            "/api/v1/organization",
            params={"item_type": "document", "offset": offset, "limit": 1},
            headers=auth,
        )
        assert response.status_code == 200
        paths.extend(item["path"] for item in response.json()["items"])
        offset = response.json()["next_offset"]
        if offset is None:
            break
    assert paths == ["root/a.md", "root/b.md", "root/c.md", "root/d.md", "root/e.md"]


def test_nested_cross_document_pipeline_does_not_wait_on_a_backup_blocked_owner():
    from sangam.mutations import MutationCoordinator

    coordinator = MutationCoordinator()
    acquired = threading.Event()
    enter_nested = threading.Event()
    finished = threading.Event()
    backup_finished = threading.Event()
    other_finished = threading.Event()

    def source():
        with coordinator.document("source"):
            acquired.set()
            assert enter_nested.wait(timeout=10)
            with coordinator.document("copy"):
                finished.set()

    def backup():
        with coordinator.backup():
            backup_finished.set()

    def copy_request():
        with coordinator.document("copy"):
            other_finished.set()

    threads = [
        threading.Thread(target=target, daemon=True) for target in [source, backup, copy_request]
    ]
    threads[0].start()
    assert acquired.wait(timeout=10)
    threads[1].start()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with coordinator._condition:
            if coordinator._waiting_backups:
                break
        time.sleep(0.01)
    else:
        pytest.fail("Backup did not reach generation barrier")
    threads[2].start()
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with coordinator._condition:
            if coordinator._document_lock_users.get("copy", 0):
                break
        time.sleep(0.01)
    else:
        pytest.fail("Copy request did not reach document boundary")
    enter_nested.set()
    assert finished.wait(timeout=2), (
        "Pipeline waited on a document lock held by a backup-blocked request"
    )
    assert backup_finished.wait(timeout=10)
    assert other_finished.wait(timeout=10)
    for thread in threads:
        thread.join(timeout=10)


@pytest.mark.parametrize(
    "invalid_path",
    [
        "docs /item.md",
        "docs/ item.md",
        "docs./item.md",
        "docs/item.md.",
        "CON/item.md",
        "docs/NUL.md",
        "COM1.html",
        "aux.md",
    ],
)
def test_path_sanitization_rejects_whitespace_trailing_dots_and_reserved_names(
    client: TestClient, invalid_path
):
    response = client.post(
        "/api/v1/documents",
        json=dict(
            title="Invalid Path", path=invalid_path, content="test", content_type="text/markdown"
        ),
        headers=headers(f"create-invalid-{invalid_path}"),
    )
    assert response.status_code == 422


@pytest.mark.parametrize(
    "invalid_scope",
    [
        "docs /sub",
        "docs/ sub",
        "docs.",
        "NUL",
        "CON/*",
    ],
)
def test_token_scope_normalization_rejects_whitespace_dots_and_reserved_names(
    client: TestClient, invalid_scope
):
    response = client.post(
        "/api/v1/agent-tokens",
        json=dict(
            actor_id="agent:invalidscope",
            display_name="Invalid Scope",
            label="Invalid Scope",
            scopes=[dict(capability="read", path_prefix=invalid_scope)],
        ),
    )
    assert response.status_code == 422
