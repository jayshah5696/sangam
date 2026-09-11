from __future__ import annotations

import json

from conftest import headers
from fastapi.testclient import TestClient

from sangam.security import sanitize_headers, sanitize_sensitive_data


def test_sensitive_header_and_data_sanitization() -> None:
    jwt_claim = "v1.eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.sig"
    request_headers = {
        "Authorization": "Bearer sgm_agt_12345.secret_bearer_token",
        "Sangam-Publication": "sgm_pub_67890.secret_pub_token",
        "Cf-Access-Jwt-Assertion": jwt_claim,
        "Cookie": "session=secret_session_id",
        "X-Api-Key": "secret_api_key",
        "X-Sangam-Trusted-Identity": "secret_trusted_header",
        "Content-Type": "application/json",
        "User-Agent": "SangamTestClient/1.0",
    }
    sanitized = sanitize_headers(request_headers)
    assert sanitized["Authorization"] == "[REDACTED]"
    assert sanitized["Sangam-Publication"] == "[REDACTED]"
    assert sanitized["Cf-Access-Jwt-Assertion"] == "[REDACTED]"
    assert sanitized["Cookie"] == "[REDACTED]"
    assert sanitized["X-Api-Key"] == "[REDACTED]"
    assert sanitized["X-Sangam-Trusted-Identity"] == "[REDACTED]"
    assert sanitized["Content-Type"] == "application/json"
    assert sanitized["User-Agent"] == "SangamTestClient/1.0"

    sensitive_payload = {
        "token_id": "agt_12345678",
        "token_label": "Researcher Agent",
        "secret_token": "sgm_agt_99999.ultra_secret_key",
        "bearer_token": "Bearer sgm_agt_88888.another_secret",
        "summary": "Updated document content",
        "nested": {
            "api_key": "secret_api_key_123",
            "title": "My Sensitive Note",
            "jwt": "eyA0NTY3OCB9.eyBjb250ZW50IH0.sig_string_here_123",
            "private_key_pem": "-----BEGIN PRIVATE KEY-----\nMIIE...",
            "auth_cookie": "session_id_val_999",
            "user_auth_token": "auth_token_value_777",
        },
    }
    sanitized_data = sanitize_sensitive_data(sensitive_payload)
    assert isinstance(sanitized_data, dict)
    assert sanitized_data["token_id"] == "agt_12345678"
    assert sanitized_data["token_label"] == "Researcher Agent"
    assert sanitized_data["secret_token"] == "[REDACTED]"
    assert sanitized_data["bearer_token"] == "[REDACTED]"
    assert sanitized_data["summary"] == "Updated document content"
    assert sanitized_data["nested"]["api_key"] == "[REDACTED]"
    assert sanitized_data["nested"]["title"] == "My Sensitive Note"
    assert sanitized_data["nested"]["jwt"] == "[REDACTED]"
    assert sanitized_data["nested"]["private_key_pem"] == "[REDACTED]"
    assert sanitized_data["nested"]["auth_cookie"] == "[REDACTED]"
    assert sanitized_data["nested"]["user_auth_token"] == "[REDACTED]"


def test_agent_actor_mutation_provenance(client: TestClient) -> None:
    # Issue agent token with full capabilities
    issue_resp = client.post(
        "/api/v1/agent-tokens",
        json={
            "actor_id": "agent:provenance_bot",
            "display_name": "Provenance Bot Agent",
            "label": "Audit Test Token",
            "scopes": [
                {"capability": "create", "path_prefix": ""},
                {"capability": "read", "path_prefix": ""},
                {"capability": "update", "path_prefix": ""},
                {"capability": "move", "path_prefix": ""},
                {"capability": "delete", "path_prefix": ""},
                {"capability": "restore", "path_prefix": ""},
            ],
            "expires_at": None,
        },
    )
    assert issue_resp.status_code == 201
    issued_token = issue_resp.json()["token"]
    agent_token_id = issue_resp.json()["token_id"]

    agent_headers = {
        "Authorization": f"Bearer {issued_token}",
        "Idempotency-Key": "agent_idemp_create",
    }

    # 1. Agent creates document
    create_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Agent Provenance Doc",
            "content": "# Agent Content",
            "path": "docs/agent_test.md",
        },
        headers=agent_headers,
    )
    assert create_resp.status_code == 201
    doc = create_resp.json()
    doc_id = doc["document_id"]
    rev1 = doc["current_revision_id"]

    # 2. Agent moves document
    move_headers = {
        "Authorization": f"Bearer {issued_token}",
        "Idempotency-Key": "agent_idemp_move",
    }
    move_resp = client.post(
        f"/api/v1/documents/{doc_id}/move",
        json={
            "expected_revision_id": rev1,
            "path": "docs/agent_test_moved.md",
        },
        headers=move_headers,
    )
    assert move_resp.status_code == 200

    # Query activity log for agent actor
    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "agent"})
    assert activity_resp.status_code == 200
    events = activity_resp.json()

    agent_events = [e for e in events if e["actor_id"] == "agent:provenance_bot"]
    assert len(agent_events) >= 2

    create_event = next(e for e in agent_events if e["action"] == "create")
    assert create_event["actor_kind"] == "agent"
    assert create_event["token_id"] == agent_token_id
    assert create_event["path"] == "docs/agent_test.md"

    move_event = next(e for e in agent_events if e["action"] == "move")
    assert move_event["actor_kind"] == "agent"
    assert move_event["token_id"] == agent_token_id
    assert move_event["details"]["source_path"] == "docs/agent_test.md"
    assert move_event["details"]["destination_path"] == "docs/agent_test_moved.md"


def test_document_mutation_audit_provenance_lifecycle(client: TestClient) -> None:
    # 1. Create a document
    create_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Audit Trail Test Doc",
            "content": "# Provenance Test\nInitial content.",
            "path": "docs/audit_test.md",
        },
        headers=headers("idemp_audit_create"),
    )
    assert create_resp.status_code == 201
    created_doc = create_resp.json()
    doc_id = created_doc["document_id"]
    rev1 = created_doc["current_revision_id"]

    # 2. Update document
    update_resp = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={
            "expected_revision_id": rev1,
            "content": "# Provenance Test\nUpdated content.",
            "title": "Audit Trail Test Doc (Updated)",
        },
        headers=headers("idemp_audit_update"),
    )
    assert update_resp.status_code == 200
    updated_doc = update_resp.json()
    rev2 = updated_doc["current_revision_id"]

    # 3. Move document
    move_resp = client.post(
        f"/api/v1/documents/{doc_id}/move",
        json={
            "expected_revision_id": rev2,
            "path": "docs/moved_audit_test.md",
        },
        headers=headers("idemp_audit_move"),
    )
    assert move_resp.status_code == 200
    moved_doc = move_resp.json()
    rev3 = moved_doc["current_revision_id"]

    # 4. Delete document
    delete_resp = client.request(
        "DELETE",
        f"/api/v1/documents/{doc_id}",
        json={"expected_revision_id": rev3},
        headers=headers("idemp_audit_delete"),
    )
    assert delete_resp.status_code == 200
    deleted_doc = delete_resp.json()
    rev4 = deleted_doc["current_revision_id"]

    # 5. Restore document
    restore_resp = client.post(
        f"/api/v1/documents/{doc_id}/restore",
        json={
            "expected_revision_id": rev4,
            "revision_id": rev3,
        },
        headers=headers("idemp_audit_restore"),
    )
    assert restore_resp.status_code == 200

    # Query activity logs for human actor
    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "human"})
    assert activity_resp.status_code == 200
    events = activity_resp.json()

    # Verify event types are recorded with accurate paths and actors
    actions = {event["action"]: event for event in events if event["resource_id"] == doc_id}
    assert "create" in actions
    assert actions["create"]["path"] == "docs/audit_test.md"
    assert actions["create"]["actor_kind"] == "human"
    assert actions["create"]["outcome"] == "accepted"

    assert "update" in actions
    assert actions["update"]["path"] == "docs/audit_test.md"
    assert actions["update"]["actor_kind"] == "human"

    assert "move" in actions
    assert actions["move"]["path"] == "docs/moved_audit_test.md"

    assert "delete" in actions
    assert actions["delete"]["path"] == "docs/moved_audit_test.md"

    assert "restore" in actions
    assert actions["restore"]["path"] == "docs/moved_audit_test.md"


def test_export_json_lines_audit_logs(client: TestClient) -> None:
    # Create document to generate activity
    client.post(
        "/api/v1/documents",
        json={
            "title": "JSONL Export Doc",
            "content": "# Export Test",
            "path": "docs/export_test.md",
        },
        headers=headers("idemp_export_doc"),
    ).raise_for_status()

    jsonl_resp = client.get("/api/v1/activity/export.jsonl", params={"actor_kind": "human"})
    assert jsonl_resp.status_code == 200
    assert jsonl_resp.headers["content-type"].startswith("application/x-ndjson")

    lines = [line.strip() for line in jsonl_resp.text.strip().split("\n") if line.strip()]
    assert len(lines) > 0

    # Verify each line parses as valid JSON matching OperationEvent structure
    parsed_events = [json.loads(line) for line in lines]
    for event in parsed_events:
        assert "event_id" in event
        assert "operation_id" in event
        assert "actor_id" in event
        assert "actor_kind" in event
        assert "action" in event
        assert "outcome" in event
        assert "created_at" in event
