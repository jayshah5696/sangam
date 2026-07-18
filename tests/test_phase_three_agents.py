from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings


def issue_token(
    client: TestClient,
    *,
    actor_id: str = "agent:researcher",
    display_name: str = "Researcher",
    scopes: list[dict[str, str | None]] | None = None,
    trusted_headers: dict[str, str] | None = None,
) -> dict[str, object]:
    response = client.post(
        "/api/v1/agent-tokens",
        headers=trusted_headers,
        json={
            "actor_id": actor_id,
            "display_name": display_name,
            "label": "Phase 3 test",
            "scopes": scopes
            or [
                {"capability": "read", "path_prefix": None},
                {"capability": "search", "path_prefix": None},
                {"capability": "create", "path_prefix": "/agents/**"},
                {"capability": "update", "path_prefix": "/agents/**"},
                {"capability": "move", "path_prefix": "/agents/**"},
                {"capability": "tag", "path_prefix": "/agents/**"},
                {"capability": "restore", "path_prefix": "/agents/**"},
                {"capability": "delete", "path_prefix": "/agents/**"},
            ],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def bearer(token: object, key: str | None = None) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {token}"}
    if key:
        headers["Idempotency-Key"] = key
    return headers


def create_human_document(
    client: TestClient, *, title: str, path: str | None, key: str
) -> dict[str, object]:
    response = client.post(
        "/api/v1/documents",
        headers={"Idempotency-Key": key},
        json={"title": title, "content": f"# {title}\n", "path": path},
    )
    assert response.status_code == 201
    return response.json()


def test_token_secret_is_one_time_hashed_revocable_and_rotatable(
    client: TestClient,
) -> None:
    issued = issue_token(client)
    token = issued["token"]
    token_id = issued["token_id"]
    assert isinstance(token, str) and token.startswith("sgm_agt_")
    assert issued["scopes"][2]["path_prefix"] == "agents"

    services = client.app.state.services
    with services.documents.database.connection() as connection:
        stored = connection.execute(
            "SELECT secret_hash FROM actor_tokens WHERE token_id = ?", (token_id,)
        ).fetchone()["secret_hash"]
    assert stored != token
    assert token not in stored

    listed = client.get("/api/v1/agent-tokens").json()
    assert listed[0]["token_id"] == token_id
    assert "token" not in listed[0]

    authenticated = client.get("/api/v1/documents", headers=bearer(token))
    assert authenticated.status_code == 200
    assert authenticated.headers["X-Operation-ID"]
    refreshed = client.get("/api/v1/agent-tokens").json()[0]
    assert refreshed["last_used_at"] is not None
    assert client.get("/api/v1/documents", headers=bearer(token)).status_code == 200
    throttled = client.get("/api/v1/agent-tokens").json()[0]
    assert throttled["last_used_at"] == refreshed["last_used_at"]

    rotated = client.post(f"/api/v1/agent-tokens/{token_id}/rotate")
    assert rotated.status_code == 200
    replacement = rotated.json()
    assert replacement["token"] != token
    assert replacement["rotated_from_token_id"] == token_id
    assert client.get("/api/v1/documents", headers=bearer(token)).status_code == 401
    assert client.get("/api/v1/documents", headers=bearer(replacement["token"])).status_code == 200

    revoked = client.delete(f"/api/v1/agent-tokens/{replacement['token_id']}")
    assert revoked.status_code == 200
    assert revoked.json()["revoked_at"] is not None
    denied = client.get("/api/v1/documents", headers=bearer(replacement["token"]))
    assert denied.status_code == 401
    assert denied.json()["error"]["code"] == "authentication_required"
    repeated_rotation = client.post(f"/api/v1/agent-tokens/{replacement['token_id']}/rotate")
    assert repeated_rotation.status_code == 409
    assert repeated_rotation.json()["error"]["code"] == "credential_conflict"


def test_token_listing_bulk_loads_scopes_and_agent_names_are_immutable(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    issue_token(client)
    issue_token(client, actor_id="agent:planner", display_name="Planner")
    database = client.app.state.services.identity.database
    statements: list[str] = []
    original_connect = database.connect

    def traced_connect():
        connection = original_connect()
        connection.set_trace_callback(statements.append)
        return connection

    monkeypatch.setattr(database, "connect", traced_connect)
    tokens = client.app.state.services.identity.list_tokens()
    assert len(tokens) == 2
    assert sum("FROM token_scopes" in statement for statement in statements) == 1

    conflicting_name = client.post(
        "/api/v1/agent-tokens",
        json={
            "actor_id": "agent:researcher",
            "display_name": "Renamed by credential",
            "label": "Must fail",
            "scopes": [{"capability": "read", "path_prefix": None}],
        },
    )
    assert conflicting_name.status_code == 409
    assert conflicting_name.json()["error"] == {
        "code": "credential_conflict",
        "message": "That agent ID already has a different display name",
        "details": {"actor_id": "agent:researcher"},
    }
    actors = client.get("/api/v1/actors").json()
    researcher = next(actor for actor in actors if actor["actor_id"] == "agent:researcher")
    assert researcher["display_name"] == "Researcher"


def test_agent_scope_enforcement_conflict_and_reviewable_activity(client: TestClient) -> None:
    private = create_human_document(
        client, title="Private plan", path="projects/private.md", key="private"
    )
    issued = issue_token(client)
    token = issued["token"]

    report_response = client.post(
        "/api/v1/documents",
        headers=bearer(token, "agent-create"),
        json={
            "title": "Research report",
            "content": "# Research\n",
            "path": "agents/research-report.md",
        },
    )
    assert report_response.status_code == 201
    report = report_response.json()
    assert report["created_by"] == "agent:researcher"
    replay = client.post(
        "/api/v1/documents",
        headers=bearer(token, "agent-create"),
        json={
            "title": "Research report",
            "content": "# Research\n",
            "path": "agents/research-report.md",
        },
    )
    assert replay.status_code == 201
    assert replay.json()["document_id"] == report["document_id"]

    outside = client.post(
        "/api/v1/documents",
        headers=bearer(token, "outside-create"),
        json={
            "title": "Outside",
            "content": "not allowed",
            "path": "projects/outside.md",
        },
    )
    assert outside.status_code == 403
    assert outside.json()["error"]["details"] == {
        "capability": "create",
        "path": "projects/outside.md",
    }

    boundary = client.post(
        "/api/v1/documents",
        headers=bearer(token, "boundary-create"),
        json={
            "title": "Boundary",
            "content": "not allowed",
            "path": "agents-private/report.md",
        },
    )
    assert boundary.status_code == 403

    updated = client.patch(
        f"/api/v1/documents/{report['document_id']}",
        headers=bearer(token, "agent-update"),
        json={
            "expected_revision_id": report["current_revision_id"],
            "content": "# Research\n\nAgent revision.\n",
            "summary": "Agent research pass",
        },
    )
    assert updated.status_code == 200

    denied_private = client.patch(
        f"/api/v1/documents/{private['document_id']}",
        headers=bearer(token, "private-update"),
        json={
            "expected_revision_id": private["current_revision_id"],
            "content": "overwrite",
        },
    )
    assert denied_private.status_code == 403

    denied_move = client.post(
        f"/api/v1/documents/{report['document_id']}/move",
        headers=bearer(token, "outside-move"),
        json={
            "expected_revision_id": updated.json()["current_revision_id"],
            "path": "projects/escaped.md",
        },
    )
    assert denied_move.status_code == 403

    stale = client.patch(
        f"/api/v1/documents/{report['document_id']}",
        headers=bearer(token, "agent-stale"),
        json={
            "expected_revision_id": report["current_revision_id"],
            "content": "stale",
        },
    )
    assert stale.status_code == 409
    assert (
        stale.json()["error"]["details"]["current_revision_id"]
        == updated.json()["current_revision_id"]
    )
    current = client.get(f"/api/v1/documents/{report['document_id']}", headers=bearer(token)).json()
    retry = client.patch(
        f"/api/v1/documents/{report['document_id']}",
        headers=bearer(token, "agent-retry"),
        json={
            "expected_revision_id": current["current_revision_id"],
            "content": f"{current['content']}\nMerged after conflict.\n",
            "summary": "Rebased agent revision",
        },
    )
    assert retry.status_code == 200
    history = client.get(
        f"/api/v1/documents/{report['document_id']}/history", headers=bearer(token)
    ).json()
    assert history[0]["actor_id"] == "agent:researcher"
    assert history[0]["operation_id"]
    compared = client.get(
        f"/api/v1/documents/{report['document_id']}/diff",
        headers=bearer(token),
        params={
            "from_revision_id": report["current_revision_id"],
            "to_revision_id": retry.json()["current_revision_id"],
        },
    )
    assert compared.status_code == 200
    assert "Merged after conflict" in compared.json()["unified_diff"]

    activity = client.get("/api/v1/activity", params={"actor_id": "agent:researcher"}).json()
    outcomes = {(event["action"], event["outcome"]) for event in activity}
    assert ("create", "accepted") in outcomes
    assert ("create", "denied") in outcomes
    assert ("update", "denied") in outcomes
    assert ("move", "denied") in outcomes
    assert ("update", "conflict") in outcomes
    serialized = json.dumps(activity)
    assert token not in serialized
    assert "Agent revision" not in serialized


def test_destination_paths_are_validated_before_scoped_authorization(client: TestClient) -> None:
    issued = issue_token(client)
    token = issued["token"]

    normalized = client.post(
        "/api/v1/documents",
        headers=bearer(token, "normalized-create"),
        json={
            "title": "Normalized",
            "content": "# Normalized\n",
            "path": "  agents/normalized.md  ",
        },
    )
    assert normalized.status_code == 201
    assert normalized.json()["path"] == "agents/normalized.md"
    document = normalized.json()

    invalid_operation_ids: set[str] = set()
    for key, path in (
        ("absolute-create", "/agents/absolute.md"),
        ("duplicate-slash-create", "agents//duplicate.md"),
    ):
        invalid = client.post(
            "/api/v1/documents",
            headers=bearer(token, key),
            json={"title": "Invalid", "content": "no", "path": path},
        )
        assert invalid.status_code == 422
        assert invalid.json()["error"]["code"] == "invalid_path"
        invalid_operation_ids.add(invalid.headers["X-Operation-ID"])

    moved = client.post(
        f"/api/v1/documents/{document['document_id']}/move",
        headers=bearer(token, "normalized-move"),
        json={
            "expected_revision_id": document["current_revision_id"],
            "path": "  agents/moved.md  ",
        },
    )
    assert moved.status_code == 200
    assert moved.json()["path"] == "agents/moved.md"

    invalid_move = client.post(
        f"/api/v1/documents/{document['document_id']}/move",
        headers=bearer(token, "absolute-move"),
        json={
            "expected_revision_id": moved.json()["current_revision_id"],
            "path": "/agents/moved-again.md",
        },
    )
    assert invalid_move.status_code == 422
    assert invalid_move.json()["error"]["code"] == "invalid_path"

    invalid_duplicate = client.post(
        f"/api/v1/documents/{document['document_id']}/duplicate",
        headers=bearer(token, "absolute-duplicate"),
        json={
            "expected_revision_id": moved.json()["current_revision_id"],
            "path": "/agents/copy.md",
        },
    )
    assert invalid_duplicate.status_code == 422
    assert invalid_duplicate.json()["error"]["code"] == "invalid_path"

    outside = client.post(
        "/api/v1/documents",
        headers=bearer(token, "outside-after-validation"),
        json={"title": "Outside", "content": "no", "path": "projects/outside.md"},
    )
    assert outside.status_code == 403

    activity = client.get("/api/v1/activity", params={"actor_id": "agent:researcher"}).json()
    invalid_operation_ids.update(
        {
            invalid_move.headers["X-Operation-ID"],
            invalid_duplicate.headers["X-Operation-ID"],
        }
    )
    invalid_events = [event for event in activity if event["operation_id"] in invalid_operation_ids]
    assert len(invalid_events) == 4
    assert {(event["outcome"], event["error_code"]) for event in invalid_events} == {
        ("failed", "invalid_path")
    }


def test_destination_authorization_precedes_filesystem_containment(
    client: TestClient, settings: Settings, tmp_path: Path
) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    for prefix in ("agents", "projects"):
        parent = settings.workspace_root / prefix
        parent.mkdir(parents=True, exist_ok=True)
        (parent / "linked").symlink_to(outside, target_is_directory=True)

    issued = issue_token(client)
    token = issued["token"]
    denied = client.post(
        "/api/v1/documents",
        headers=bearer(token, "out-of-scope-symlink"),
        json={
            "title": "Denied probe",
            "content": "no",
            "path": "projects/linked/probe.md",
        },
    )
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "forbidden"

    invalid = client.post(
        "/api/v1/documents",
        headers=bearer(token, "in-scope-symlink"),
        json={
            "title": "Invalid destination",
            "content": "no",
            "path": "agents/linked/escape.md",
        },
    )
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "invalid_path"
    assert not (outside / "escape.md").exists()

    operation_ids = {
        denied.headers["X-Operation-ID"],
        invalid.headers["X-Operation-ID"],
    }
    activity = client.get("/api/v1/activity", params={"actor_id": "agent:researcher"}).json()
    events = [event for event in activity if event["operation_id"] in operation_ids]
    assert {(event["outcome"], event["error_code"]) for event in events} == {
        ("denied", "forbidden"),
        ("failed", "invalid_path"),
    }


def test_path_scoped_reads_filter_lists_search_and_unmaterialized_documents(
    client: TestClient,
) -> None:
    visible = create_human_document(
        client, title="Visible", path="agents/visible.md", key="visible"
    )
    create_human_document(client, title="Private", path="projects/private.md", key="private")
    draft = create_human_document(client, title="Draft", path=None, key="draft")
    issued = issue_token(
        client,
        actor_id="agent:limited",
        scopes=[
            {"capability": "read", "path_prefix": "agents"},
            {"capability": "search", "path_prefix": "agents"},
        ],
    )
    token = issued["token"]

    listed = client.get("/api/v1/documents", headers=bearer(token)).json()
    assert [document["document_id"] for document in listed] == [visible["document_id"]]
    searched = client.get("/api/v1/search", headers=bearer(token), params={"q": "Private"})
    assert searched.status_code == 200
    assert searched.json() == []
    assert (
        client.get(f"/api/v1/documents/{draft['document_id']}", headers=bearer(token)).status_code
        == 403
    )
    assert client.get("/api/v1/tags", headers=bearer(token)).status_code == 403


def test_scoped_filters_run_before_pagination_and_intersect_search_authority(
    client: TestClient,
) -> None:
    documents = {
        path: create_human_document(client, title="Needle", path=path, key=f"page-{index}")
        for index, path in enumerate(
            (
                "agents/one.md",
                "projects/private-one.md",
                "agents/research/two.md",
                "agents-private/not-visible.md",
                "agents/other/three.md",
                "projects/private-two.md",
            )
        )
    }
    issued = issue_token(
        client,
        actor_id="agent:paginator",
        display_name="Paginator",
        scopes=[
            {"capability": "read", "path_prefix": "agents"},
            {"capability": "search", "path_prefix": "agents/research"},
        ],
    )
    token_headers = bearer(issued["token"])

    first_page = client.get(
        "/api/v1/documents", headers=token_headers, params={"limit": 2, "offset": 0}
    ).json()
    second_page = client.get(
        "/api/v1/documents", headers=token_headers, params={"limit": 2, "offset": 2}
    ).json()
    listed_ids = {document["document_id"] for document in first_page + second_page}
    assert len(first_page) == 2
    assert listed_ids == {
        documents["agents/one.md"]["document_id"],
        documents["agents/research/two.md"]["document_id"],
        documents["agents/other/three.md"]["document_id"],
    }

    searched = client.get(
        "/api/v1/search",
        headers=token_headers,
        params={"q": "Needle", "limit": 1, "offset": 0},
    )
    assert searched.status_code == 200
    assert [document["document_id"] for document in searched.json()] == [
        documents["agents/research/two.md"]["document_id"]
    ]


def test_trusted_proxy_mode_rejects_spoofed_actor_and_agent_admin_access(
    tmp_path: Path,
) -> None:
    settings = Settings(
        database_path=tmp_path / "database" / "sangam.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
        backups_enabled=False,
        frontend_dist=tmp_path / "missing",
        auth_mode="trusted_proxy",
        trusted_identity_header="X-Test-Identity",
        trusted_identity_value="jay@example.com",
        trusted_human_actor_id="human:proxy",
        trusted_human_display_name="Proxy Jay",
    )
    trusted = {"X-Test-Identity": "jay@example.com"}
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/documents").status_code == 401
        assert client.get("/api/v1/documents", headers={"X-Actor": "human:jay"}).status_code == 401
        assert client.get("/api/v1/documents", headers=trusted).status_code == 200
        created = client.post(
            "/api/v1/documents",
            headers={**trusted, "Idempotency-Key": "trusted-create"},
            json={"title": "Trusted", "content": "# Trusted\n"},
        )
        assert created.status_code == 201
        assert created.json()["created_by"] == "human:proxy"
        issued = issue_token(client, trusted_headers=trusted)
        agent_admin = client.get("/api/v1/agent-tokens", headers=bearer(issued["token"]))
        assert agent_admin.status_code == 403


def test_expired_and_malformed_tokens_fail_without_secret_disclosure(client: TestClient) -> None:
    issued = issue_token(client)
    services = client.app.state.services
    with services.documents.database.transaction() as connection:
        connection.execute(
            """
            UPDATE actor_tokens
            SET created_at = '2020-01-01T00:00:00+00:00',
                expires_at = '2021-01-01T00:00:00+00:00'
            WHERE token_id = ?
            """,
            (issued["token_id"],),
        )
    expired = client.get("/api/v1/documents", headers=bearer(issued["token"]))
    assert expired.status_code == 401
    assert "expired" in expired.json()["error"]["message"].lower()

    malformed = client.get(
        "/api/v1/documents", headers={"Authorization": "Bearer definitely-not-a-token"}
    )
    assert malformed.status_code == 401
    assert "definitely-not-a-token" not in malformed.text
    assert malformed.headers["X-Operation-ID"]


def test_list_search_and_document_payloads_are_bounded(tmp_path: Path) -> None:
    settings = Settings(
        database_path=tmp_path / "database" / "sangam.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
        backups_enabled=False,
        frontend_dist=tmp_path / "missing",
        max_document_bytes=1_024,
    )
    with TestClient(create_app(settings)) as client:
        created = [
            create_human_document(client, title=f"Document {index}", path=None, key=f"d-{index}")
            for index in range(3)
        ]
        page = client.get("/api/v1/documents", params={"limit": 2, "offset": 1})
        assert page.status_code == 200
        assert len(page.json()) == 2
        assert all("content" not in document for document in page.json())
        assert "content" in client.get(f"/api/v1/documents/{created[0]['document_id']}").json()
        assert client.get("/api/v1/documents", params={"limit": 201}).status_code == 422

        oversized = client.post(
            "/api/v1/documents",
            headers={"Idempotency-Key": "oversized"},
            json={"title": "Too large", "content": "x" * 1_025},
        )
        assert oversized.status_code == 422
        assert oversized.json()["error"]["details"] == {
            "size_bytes": 1_025,
            "max_document_bytes": 1_024,
        }
