from __future__ import annotations

import json

from conftest import headers
from fastapi.testclient import TestClient

from sangam.security import sanitize_headers, sanitize_sensitive_data, sanitize_sensitive_text


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
        "private_key_data": "my_private_key_value",
        "authorization_headers": "some_auth_string",
        "summary": "Updated document content",
        "nested": {
            "api_key": "secret_api_key_123",
            "title": "My Sensitive Note",
            "jwt": "eyA0NTY3OCB9.eyBjb250ZW50IH0.sig_string_here_123",
        },
    }
    sanitized_data = sanitize_sensitive_data(sensitive_payload)
    assert isinstance(sanitized_data, dict)
    assert sanitized_data["token_id"] == "agt_12345678"
    assert sanitized_data["token_label"] == "Researcher Agent"
    assert sanitized_data["secret_token"] == "[REDACTED]"
    assert sanitized_data["bearer_token"] == "[REDACTED]"
    assert sanitized_data["private_key_data"] == "[REDACTED]"
    assert sanitized_data["authorization_headers"] == "[REDACTED]"
    assert sanitized_data["summary"] == "Updated document content"
    assert sanitized_data["nested"]["api_key"] == "[REDACTED]"
    assert sanitized_data["nested"]["title"] == "My Sensitive Note"
    assert sanitized_data["nested"]["jwt"] == "[REDACTED]"


def test_agent_document_mutation_audit_provenance(client: TestClient) -> None:
    # 1. Issue an agent token
    issue_resp = client.post(
        "/api/v1/agent-tokens",
        json={
            "actor_id": "agent:chronicle-test",
            "display_name": "Chronicle Audit Agent",
            "label": "Audit Test Token",
            "scopes": [
                {"capability": "read", "path_prefix": "agent_docs"},
                {"capability": "create", "path_prefix": "agent_docs"},
                {"capability": "update", "path_prefix": "agent_docs"},
                {"capability": "move", "path_prefix": "agent_docs"},
                {"capability": "delete", "path_prefix": "agent_docs"},
            ],
        },
        headers=headers("idemp_issue_agent_audit"),
    )
    assert issue_resp.status_code == 201
    issued_data = issue_resp.json()
    raw_token = issued_data["token"]
    agent_token_id = issued_data["token_id"]

    agent_headers = {
        "Authorization": f"Bearer {raw_token}",
        "X-Sangam-Operation-Id": "agent_op_001",
    }

    # 2. Create document as agent
    create_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Agent Created Doc",
            "content": "# Agent Content\nInitial text.",
            "path": "agent_docs/test_agent_doc.md",
        },
        headers={**agent_headers, **headers("idemp_agent_create")},
    )
    assert create_resp.status_code == 201
    created_doc = create_resp.json()
    doc_id = created_doc["document_id"]
    rev1 = created_doc["current_revision_id"]

    # 3. Update document as agent
    update_resp = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={
            "expected_revision_id": rev1,
            "content": "# Agent Content\nUpdated text.",
            "title": "Agent Created Doc (Updated)",
        },
        headers={**agent_headers, **headers("idemp_agent_update")},
    )
    assert update_resp.status_code == 200
    updated_doc = update_resp.json()
    rev2 = updated_doc["current_revision_id"]

    # 4. Move document as agent
    move_resp = client.post(
        f"/api/v1/documents/{doc_id}/move",
        json={
            "expected_revision_id": rev2,
            "path": "agent_docs/moved_test_agent_doc.md",
        },
        headers={**agent_headers, **headers("idemp_agent_move")},
    )
    assert move_resp.status_code == 200
    moved_doc = move_resp.json()
    rev3 = moved_doc["current_revision_id"]

    # 5. Delete document as agent
    delete_resp = client.request(
        "DELETE",
        f"/api/v1/documents/{doc_id}",
        json={"expected_revision_id": rev3},
        headers={**agent_headers, **headers("idemp_agent_delete")},
    )
    assert delete_resp.status_code == 200

    # Query activity logs for agent actor_kind
    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "agent"})
    assert activity_resp.status_code == 200
    events = activity_resp.json()

    agent_events = [
        e for e in events if e["actor_id"] == "agent:chronicle-test" and e["resource_id"] == doc_id
    ]
    actions = {e["action"]: e for e in agent_events}

    assert "create" in actions
    assert actions["create"]["actor_id"] == "agent:chronicle-test"
    assert actions["create"]["actor_kind"] == "agent"
    assert actions["create"]["token_id"] == agent_token_id
    assert actions["create"]["path"] == "agent_docs/test_agent_doc.md"
    assert actions["create"]["outcome"] == "accepted"

    assert "update" in actions
    assert actions["update"]["actor_id"] == "agent:chronicle-test"
    assert actions["update"]["actor_kind"] == "agent"
    assert actions["update"]["token_id"] == agent_token_id
    assert actions["update"]["path"] == "agent_docs/test_agent_doc.md"

    assert "move" in actions
    assert actions["move"]["actor_id"] == "agent:chronicle-test"
    assert actions["move"]["actor_kind"] == "agent"
    assert actions["move"]["token_id"] == agent_token_id
    assert actions["move"]["path"] == "agent_docs/moved_test_agent_doc.md"

    assert "delete" in actions
    assert actions["delete"]["actor_id"] == "agent:chronicle-test"
    assert actions["delete"]["actor_kind"] == "agent"
    assert actions["delete"]["token_id"] == agent_token_id
    assert actions["delete"]["path"] == "agent_docs/moved_test_agent_doc.md"


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
    assert actions["update"]["details"]["expected_revision_id"] == rev1
    assert actions["update"]["details"]["title"] == "Audit Trail Test Doc (Updated)"

    assert "move" in actions
    assert actions["move"]["path"] == "docs/moved_audit_test.md"
    assert actions["move"]["details"]["source_path"] == "docs/audit_test.md"
    assert actions["move"]["details"]["destination_path"] == "docs/moved_audit_test.md"

    assert "delete" in actions
    assert actions["delete"]["path"] == "docs/moved_audit_test.md"
    assert actions["delete"]["details"]["expected_revision_id"] == rev3

    assert "restore" in actions
    assert actions["restore"]["path"] == "docs/moved_audit_test.md"
    assert actions["restore"]["details"]["expected_revision_id"] == rev4
    assert actions["restore"]["details"]["current_revision_id"] == rev3


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


def test_audit_line_counts_include_content_starting_with_diff_markers(client: TestClient) -> None:
    create_response = client.post(
        "/api/v1/documents",
        json={
            "title": "Diff Marker Audit Doc",
            "content": "keep\n--remove-me",
            "path": "docs/diff_marker_audit.md",
        },
        headers=headers("idemp_diff_marker_create"),
    )
    assert create_response.status_code == 201
    created_document = create_response.json()

    update_response = client.patch(
        f"/api/v1/documents/{created_document['document_id']}",
        json={
            "expected_revision_id": created_document["current_revision_id"],
            "content": "keep\n+++add-me",
        },
        headers=headers("idemp_diff_marker_update"),
    )
    assert update_response.status_code == 200

    activity_response = client.get("/api/v1/activity", params={"actor_kind": "human"})
    assert activity_response.status_code == 200
    update_event = next(
        event
        for event in activity_response.json()
        if event["resource_id"] == created_document["document_id"] and event["action"] == "update"
    )
    assert update_event["details"]["lines_added"] == 1
    assert update_event["details"]["lines_removed"] == 1


def test_document_trust_audit_provenance(client: TestClient) -> None:
    create_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Trust Audit Doc",
            "content": "<h1>Trust Level Test</h1>",
            "path": "docs/trust_audit.html",
            "content_type": "text/html",
        },
        headers=headers("idemp_trust_doc_create"),
    )
    assert create_resp.status_code == 201
    created_doc = create_resp.json()
    doc_id = created_doc["document_id"]

    trust_resp = client.patch(
        f"/api/v1/documents/{doc_id}/trust",
        json={
            "expected_trust_version": 0,
            "trust_level": "trusted_interactive",
        },
        headers=headers("idemp_trust_doc_update"),
    )
    assert trust_resp.status_code == 200

    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "human"})
    assert activity_resp.status_code == 200
    trust_events = [
        e for e in activity_resp.json() if e["resource_id"] == doc_id and e["action"] == "trust"
    ]
    assert len(trust_events) == 1
    event = trust_events[0]
    assert event["resource_type"] == "document"
    assert event["path"] == "docs/trust_audit.html"
    assert event["outcome"] == "accepted"
    assert event["details"]["trust_level"] == "trusted_interactive"
    assert event["details"]["expected_trust_version"] == 0


def test_reconciliation_audit_provenance(client: TestClient, settings) -> None:
    unindexed_path = settings.workspace_root / "docs" / "reconcile_audit.md"
    unindexed_path.parent.mkdir(parents=True, exist_ok=True)
    unindexed_path.write_text("# Unindexed File\nContent.", encoding="utf-8")

    scan_resp = client.post("/api/v1/reconciliation/scan")
    assert scan_resp.status_code == 200

    reindex_resp = client.post(
        "/api/v1/reconciliation/reindex",
        json={"path": "docs/reconcile_audit.md"},
        headers=headers("idemp_reconcile_reindex"),
    )
    assert reindex_resp.status_code == 201
    doc = reindex_resp.json()
    doc_id = doc["document_id"]

    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "human"})
    assert activity_resp.status_code == 200
    reconcile_events = [
        e
        for e in activity_resp.json()
        if e["resource_id"] == doc_id and e["action"] == "reconcile_reindex"
    ]
    assert len(reconcile_events) == 1
    event = reconcile_events[0]
    assert event["resource_type"] == "document"
    assert event["path"] == "docs/reconcile_audit.md"
    assert event["outcome"] == "accepted"


def test_extended_sensitive_header_and_data_sanitization() -> None:
    request_headers = {
        "Sangam-Preview": "sgm_prv_123.preview_token_value",
        "Proxy-Authenticate": "Basic realm=secret_realm",
        "Passphrase": "my_secret_passphrase",
        "X-Client-Cert": "MIIE...client_cert_data",
        "Ssl-Client-Cert": "MIIE...ssl_cert_data",
        "X-Custom-Signature": "sig_9988776655443322",
    }
    sanitized_headers = sanitize_headers(request_headers)
    assert sanitized_headers["Sangam-Preview"] == "[REDACTED]"
    assert sanitized_headers["Proxy-Authenticate"] == "[REDACTED]"
    assert sanitized_headers["Passphrase"] == "[REDACTED]"
    assert sanitized_headers["X-Client-Cert"] == "[REDACTED]"
    assert sanitized_headers["Ssl-Client-Cert"] == "[REDACTED]"
    assert sanitized_headers["X-Custom-Signature"] == "[REDACTED]"

    sensitive_payload = {
        "private_payload": "sensitive_data_blob",
        "passphrase": "super_secret_passphrase",
        "database_url": "postgresql://user:pass@localhost/db",
        "dsn": "sqlite:///data/secret.db",
        "connection_string": "Server=myServerAddress;Database=db;Uid=usr;Pwd=pass;",
        "client_secret": "secret_client_val",
        "auth_token": "sgm_agt_11111.secret_auth",
        "refresh_token": "sgm_agt_22222.secret_refresh",
        "access_token": "sgm_agt_33333.secret_access",
        "api_token": "sgm_agt_44444.secret_api",
        "tls_key": "my_tls_key_data",
        "priv_key": "my_priv_key_data",
        "access_token_secret": "my_oauth_secret",
        "pem": "-----BEGIN PRIVATE KEY-----\nMIIE...",
        "client_certificate": "-----BEGIN CERTIFICATE-----\nMIIE...",
        "digital_signature": "signature_hash_bytes",
        "oauth_token": "glpat-1234567890abcdef1234",
        "slack_token": "xoxb-123456789012-345678901234",
        "env_var": "SECRET_ENV_VALUE",
        "env_val": "ANOTHER_SECRET_VAL",
    }
    sanitized_data = sanitize_sensitive_data(sensitive_payload)
    assert isinstance(sanitized_data, dict)
    for key in sensitive_payload:
        assert sanitized_data[key] == "[REDACTED]"


def test_folder_mutation_audit_provenance(client: TestClient) -> None:
    # 1. Create a folder
    create_resp = client.post(
        "/api/v1/folders",
        json={"path": "projects/audit_folder", "category": "engineering"},
        headers=headers("idemp_folder_create"),
    )
    assert create_resp.status_code == 201
    folder = create_resp.json()
    folder_id = folder["folder_id"]

    # 2. Update folder metadata
    update_resp = client.patch(
        f"/api/v1/folders/{folder_id}",
        json={
            "expected_metadata_version": folder["metadata_version"],
            "category": "research",
            "tag_ids": [],
        },
        headers=headers("idemp_folder_update"),
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["category"] == "research"

    # 3. Move folder
    move_resp = client.post(
        f"/api/v1/folders/{folder_id}/move",
        json={"path": "projects/moved_audit_folder"},
        headers=headers("idemp_folder_move"),
    )
    assert move_resp.status_code == 200

    # Query activity logs for human actor
    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "human"})
    assert activity_resp.status_code == 200
    events = activity_resp.json()

    folder_events = [e for e in events if e["resource_id"] == folder_id]
    actions = {e["action"]: e for e in folder_events}

    assert "create" in actions
    assert actions["create"]["resource_type"] == "folder"
    assert actions["create"]["path"] == "projects/audit_folder"
    assert actions["create"]["actor_kind"] == "human"
    assert actions["create"]["outcome"] == "accepted"

    assert "tag" in actions
    assert actions["tag"]["resource_type"] == "folder"
    assert actions["tag"]["actor_kind"] == "human"
    assert actions["tag"]["details"]["category"] == "research"

    assert "move" in actions
    assert actions["move"]["resource_type"] == "folder"
    assert actions["move"]["path"] == "projects/moved_audit_folder"
    assert actions["move"]["actor_kind"] == "human"


def test_organization_plan_audit_provenance(client: TestClient) -> None:
    # 1. Create a document to be moved in plan
    create_doc_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Org Plan Doc",
            "content": "# Organization Plan Content",
            "path": "docs/plan_test_doc.md",
        },
        headers=headers("idemp_plan_doc_create"),
    )
    assert create_doc_resp.status_code == 201
    doc = create_doc_resp.json()
    doc_id = doc["document_id"]
    rev1 = doc["current_revision_id"]

    # 2. Apply organization plan with folder creation and document move
    plan_resp = client.post(
        "/api/v1/organization/plans",
        json={
            "operations": [
                {
                    "kind": "create_folder",
                    "path": "archive",
                    "category": None,
                    "tag_ids": [],
                },
                {
                    "kind": "move_document",
                    "document_id": doc_id,
                    "expected_revision_id": rev1,
                    "expected_source_path": "docs/plan_test_doc.md",
                    "destination_path": "archive/plan_test_doc.md",
                },
            ]
        },
        headers=headers("idemp_org_plan_apply"),
    )
    assert plan_resp.status_code == 200
    plan_result = plan_resp.json()
    assert plan_result["status"] == "completed"

    # Query activity logs
    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "human"})
    assert activity_resp.status_code == 200
    events = activity_resp.json()

    doc_events = [e for e in events if e["resource_id"] == doc_id and e["action"] == "move"]
    assert len(doc_events) == 1
    move_event = doc_events[0]
    assert move_event["resource_type"] == "document"
    assert move_event["path"] == "archive/plan_test_doc.md"
    assert move_event["actor_kind"] == "human"
    assert move_event["outcome"] == "accepted"
    assert move_event["details"]["source_path"] == "docs/plan_test_doc.md"
    assert move_event["details"]["destination_path"] == "archive/plan_test_doc.md"


def test_uri_credentials_and_bearer_text_sanitization() -> None:
    text_with_secrets = (
        "Config: DATABASE_URL=postgresql://dbuser:super_secret_password@db.local:5432/sangam "
        "and Auth: Bearer my_custom_bearer_token_abc123 and API_KEY=secret_key_778899 "
        "and db_pass: my_database_pass_123"
    )
    sanitized = sanitize_sensitive_text(text_with_secrets)
    assert "super_secret_password" not in sanitized
    assert "my_custom_bearer_token_abc123" not in sanitized
    assert "secret_key_778899" not in sanitized
    assert "my_database_pass_123" not in sanitized
    assert "postgresql://[REDACTED]:[REDACTED]@db.local:5432/sangam" in sanitized
    assert "Bearer [REDACTED]" in sanitized
    assert "API_KEY=[REDACTED]" in sanitized
    assert "db_pass=[REDACTED]" in sanitized


def test_extended_credential_keys_sanitization() -> None:
    payload = {
        "passwd": "user_password_val",
        "db_pass": "database_password_val",
        "credentials": "user_credentials_blob",
        "api_credentials": "api_credentials_blob",
    }
    sanitized = sanitize_sensitive_data(payload)
    assert isinstance(sanitized, dict)
    assert sanitized["passwd"] == "[REDACTED]"
    assert sanitized["db_pass"] == "[REDACTED]"
    assert sanitized["credentials"] == "[REDACTED]"
    assert sanitized["api_credentials"] == "[REDACTED]"


def test_audit_provenance_and_structured_change_events_detail(client: TestClient) -> None:
    # 1. Create a document with initial content
    create_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Structured Audit Doc",
            "content": "line1\nline2",
            "path": "docs/structured_audit.md",
        },
        headers=headers("idemp_struct_audit_create"),
    )
    assert create_resp.status_code == 201
    doc = create_resp.json()
    doc_id = doc["document_id"]
    rev1 = doc["current_revision_id"]

    # 2. Update the document to generate patch diff metadata
    update_resp = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={
            "expected_revision_id": rev1,
            "content": "line1\nline2_modified\nline3_added",
        },
        headers=headers("idemp_struct_audit_update"),
    )
    assert update_resp.status_code == 200

    # 3. Duplicate the document
    dupe_resp = client.post(
        f"/api/v1/documents/{doc_id}/duplicate",
        json={
            "expected_revision_id": update_resp.json()["current_revision_id"],
            "title": "Structured Audit Doc Copy",
            "path": "docs/structured_audit_copy.md",
        },
        headers=headers("idemp_struct_audit_duplicate"),
    )
    assert dupe_resp.status_code == 201
    dupe_doc_id = dupe_resp.json()["document_id"]

    # 4. Inspect activity log for structured change events and provenance
    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "human"})
    assert activity_resp.status_code == 200
    events = activity_resp.json()

    update_events = [e for e in events if e["resource_id"] == doc_id and e["action"] == "update"]
    assert len(update_events) == 1
    up_event = update_events[0]
    assert up_event["actor_kind"] == "human"
    assert up_event["path"] == "docs/structured_audit.md"
    assert up_event["outcome"] == "accepted"
    assert up_event["details"]["lines_added"] == 2
    assert up_event["details"]["lines_removed"] == 1
    assert "diff" in up_event["details"]
    assert up_event["details"]["expected_revision_id"] == rev1

    dupe_events = [
        e for e in events if e["resource_id"] == dupe_doc_id and e["action"] == "duplicate"
    ]
    assert len(dupe_events) == 1
    dupe_event = dupe_events[0]
    assert dupe_event["actor_kind"] == "human"
    assert dupe_event["path"] == "docs/structured_audit_copy.md"
    assert dupe_event["details"]["source_path"] == "docs/structured_audit.md"
    assert dupe_event["details"]["destination_path"] == "docs/structured_audit_copy.md"


def test_hardened_security_sanitization_patterns() -> None:
    headers_dict = {
        "x-sangam-trusted-identity": "secret_trusted_val",
        "sangam-trusted-identity": "another_trusted_val",
        "x-refresh-token": "secret_refresh_hdr",
        "x-auth-secret": "secret_auth_hdr",
        "x-api-secret": "secret_api_hdr",
        "content-type": "application/json",
    }
    sanitized_hdrs = sanitize_headers(headers_dict)
    assert sanitized_hdrs["x-sangam-trusted-identity"] == "[REDACTED]"
    assert sanitized_hdrs["sangam-trusted-identity"] == "[REDACTED]"
    assert sanitized_hdrs["x-refresh-token"] == "[REDACTED]"
    assert sanitized_hdrs["x-auth-secret"] == "[REDACTED]"
    assert sanitized_hdrs["x-api-secret"] == "[REDACTED]"
    assert sanitized_hdrs["content-type"] == "application/json"

    data_payload = {
        "signing_key": "secret_signing_key_data",
        "encryption_key": "secret_encryption_key_data",
        "user_key": "secret_user_key_data",
        "safe_item": "hello_world",
    }
    sanitized_payload = sanitize_sensitive_data(data_payload)
    assert isinstance(sanitized_payload, dict)
    assert sanitized_payload["signing_key"] == "[REDACTED]"
    assert sanitized_payload["encryption_key"] == "[REDACTED]"
    assert sanitized_payload["user_key"] == "[REDACTED]"
    assert sanitized_payload["safe_item"] == "hello_world"

    text_assignment = (
        "Config: signing_key='secret_sign_123' and encryption_key=\"enc_456\" "
        "and account_key: acc_789 and id_token=id_tok_000"
    )
    sanitized_text = sanitize_sensitive_text(text_assignment)
    assert "secret_sign_123" not in sanitized_text
    assert "enc_456" not in sanitized_text
    assert "acc_789" not in sanitized_text
    assert "id_tok_000" not in sanitized_text
    assert "signing_key=[REDACTED]" in sanitized_text
    assert "encryption_key=[REDACTED]" in sanitized_text
    assert "account_key=[REDACTED]" in sanitized_text
    assert "id_token=[REDACTED]" in sanitized_text


def test_operation_event_action_and_path_provenance(client: TestClient) -> None:
    create_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Auto Detail Audit Doc",
            "content": "# Test\nAuto populated details.",
            "path": "docs/auto_detail_test.md",
        },
        headers=headers("idemp_auto_detail_create"),
    )
    assert create_resp.status_code == 201
    doc = create_resp.json()
    doc_id = doc["document_id"]

    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "human"})
    assert activity_resp.status_code == 200
    events = activity_resp.json()

    doc_events = [e for e in events if e["resource_id"] == doc_id]
    assert len(doc_events) >= 1
    create_event = next(e for e in doc_events if e["action"] == "create")

    assert create_event["action"] == "create"
    assert create_event["path"] == "docs/auto_detail_test.md"
