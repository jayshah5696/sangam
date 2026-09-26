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
        "X-Access-Token": "secret_access_token",
        "X-Secret-Key": "ultra_secret_value",
        "X-Session-ID": "session_identifier_abc",
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
    assert sanitized["X-Access-Token"] == "[REDACTED]"
    assert sanitized["X-Secret-Key"] == "[REDACTED]"
    assert sanitized["X-Session-ID"] == "[REDACTED]"
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
        "summary": (
            "Updated document content with sk-123456789012345678 key "
            "and ghp_0123456789abcdef0123 token"
        ),
        "nested": {
            "api_key": "secret_api_key_123",
            "title": "My Sensitive Note",
            "jwt": "eyA0NTY3OCB9.eyBjb250ZW50IH0.sig_string_here_123",
        },
        "set_values": {"sk-987654321098765432", "safe_value"},
    }
    sanitized_data = sanitize_sensitive_data(sensitive_payload)
    assert isinstance(sanitized_data, dict)
    assert sanitized_data["token_id"] == "agt_12345678"
    assert sanitized_data["token_label"] == "Researcher Agent"
    assert sanitized_data["secret_token"] == "[REDACTED]"
    assert sanitized_data["bearer_token"] == "[REDACTED]"
    assert sanitized_data["private_key_data"] == "[REDACTED]"
    assert sanitized_data["authorization_headers"] == "[REDACTED]"
    assert "[REDACTED]" in str(sanitized_data["summary"])
    assert "sk-" not in str(sanitized_data["summary"])
    assert "ghp_" not in str(sanitized_data["summary"])
    assert sanitized_data["nested"]["api_key"] == "[REDACTED]"
    assert sanitized_data["nested"]["title"] == "My Sensitive Note"
    assert sanitized_data["nested"]["jwt"] == "[REDACTED]"
    assert isinstance(sanitized_data["set_values"], set)
    assert "[REDACTED]" in sanitized_data["set_values"]
    assert "safe_value" in sanitized_data["set_values"]


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


def test_update_patch_metadata_audit_event(client: TestClient) -> None:
    # 1. Create a document
    create_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Patch Metadata Test Doc",
            "content": "Line 1\nLine 2\nLine 3\n",
            "path": "docs/patch_meta_test.md",
        },
        headers=headers("idemp_patch_create"),
    )
    assert create_resp.status_code == 201
    created_doc = create_resp.json()
    doc_id = created_doc["document_id"]
    rev1 = created_doc["current_revision_id"]

    # 2. Update document content (add 2 lines, remove 1 line)
    update_resp = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={
            "expected_revision_id": rev1,
            "content": "Line 1\nLine 2 modified\nLine 3\nLine 4\nLine 5\n",
            "summary": "Added lines 4 and 5, modified line 2",
        },
        headers=headers("idemp_patch_update"),
    )
    assert update_resp.status_code == 200

    # 3. Reread activity log
    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "human"})
    assert activity_resp.status_code == 200
    events = activity_resp.json()

    update_events = [e for e in events if e["resource_id"] == doc_id and e["action"] == "update"]
    assert len(update_events) == 1
    event_details = update_events[0]["details"]
    assert "lines_added" in event_details
    assert "lines_removed" in event_details
    assert event_details["lines_added"] > 0
    assert event_details["lines_removed"] > 0
    assert event_details["expected_revision_id"] == rev1
    assert event_details["summary"] == "Added lines 4 and 5, modified line 2"


def test_materialize_duplicate_tag_import_audit_details(client: TestClient) -> None:
    # 1. Create an unmaterialized draft document
    draft_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Draft Document",
            "content": "# Draft Content",
            "path": None,
        },
        headers=headers("idemp_draft_create"),
    )
    assert draft_resp.status_code == 201
    draft_doc = draft_resp.json()
    draft_id = draft_doc["document_id"]
    draft_rev = draft_doc["current_revision_id"]

    # 2. Materialize draft
    mat_resp = client.post(
        f"/api/v1/documents/{draft_id}/materialize",
        json={
            "expected_revision_id": draft_rev,
            "path": "docs/materialized_draft.md",
            "summary": "Materialized draft",
        },
        headers=headers("idemp_draft_mat"),
    )
    assert mat_resp.status_code == 200
    mat_doc = mat_resp.json()
    mat_rev = mat_doc["current_revision_id"]

    # 3. Duplicate document
    dup_resp = client.post(
        f"/api/v1/documents/{draft_id}/duplicate",
        json={
            "expected_revision_id": mat_rev,
            "title": "Draft Copy",
            "path": "docs/materialized_draft_copy.md",
        },
        headers=headers("idemp_draft_dup"),
    )
    assert dup_resp.status_code == 201
    dup_doc = dup_resp.json()
    dup_id = dup_doc["document_id"]

    # 4. Tag document metadata
    tag_resp = client.post(
        "/api/v1/tags",
        json={"name": "AuditTag", "color": "#00ff00"},
        headers=headers("idemp_create_audit_tag"),
    )
    assert tag_resp.status_code == 201
    tag_data = tag_resp.json()

    meta_resp = client.patch(
        f"/api/v1/documents/{draft_id}/metadata",
        json={
            "expected_metadata_version": mat_doc["metadata_version"],
            "category": "Documentation",
            "tag_ids": [tag_data["tag_id"]],
        },
        headers=headers("idemp_update_meta"),
    )
    assert meta_resp.status_code == 200

    # Verify activity events for materialize, duplicate, tag
    activity_resp = client.get("/api/v1/activity", params={"actor_kind": "human"})
    assert activity_resp.status_code == 200
    events = activity_resp.json()

    draft_events = {e["action"]: e for e in events if e["resource_id"] == draft_id}
    dup_events = {e["action"]: e for e in events if e["resource_id"] == dup_id}

    assert "materialize" in draft_events
    mat_details = draft_events["materialize"]["details"]
    assert mat_details["destination_path"] == "docs/materialized_draft.md"
    assert mat_details["expected_revision_id"] == draft_rev

    assert "duplicate" in dup_events
    dup_details = dup_events["duplicate"]["details"]
    assert dup_details["source_path"] == "docs/materialized_draft.md"
    assert dup_details["destination_path"] == "docs/materialized_draft_copy.md"
    assert dup_details["title"] == "Draft Copy"

    assert "tag" in draft_events
    tag_details = draft_events["tag"]["details"]
    assert tag_details["expected_metadata_version"] == mat_doc["metadata_version"]
    assert tag_details["category"] == "Documentation"
    assert tag_details["tag_ids"] == [tag_data["tag_id"]]
