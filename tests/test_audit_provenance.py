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


def test_agent_provenance_and_audit_attribution(client: TestClient) -> None:
    from conftest import issue_agent_token

    agent_token = issue_agent_token(
        client,
        actor_id="agent:auditor",
        display_name="Auditor Agent",
        capabilities=("create", "read", "update", "move", "delete", "restore"),
    )
    agent_headers = {
        "Authorization": f"Bearer {agent_token}",
        "Idempotency-Key": "agent_idemp_create",
    }

    # 1. Agent creates document
    create_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Agent Document",
            "content": "Line 1\nLine 2\nLine 3\n",
            "path": "docs/agent_doc.md",
        },
        headers=agent_headers,
    )
    assert create_resp.status_code == 201
    doc = create_resp.json()
    doc_id = doc["document_id"]
    rev1 = doc["current_revision_id"]

    # 2. Agent updates document
    agent_headers["Idempotency-Key"] = "agent_idemp_update"
    update_resp = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={
            "expected_revision_id": rev1,
            "content": "Line 1\nLine 2 modified\nLine 3\n",
            "title": "Agent Document (Modified)",
        },
        headers=agent_headers,
    )
    assert update_resp.status_code == 200
    rev2 = update_resp.json()["current_revision_id"]

    # 3. Agent moves document
    agent_headers["Idempotency-Key"] = "agent_idemp_move"
    move_resp = client.post(
        f"/api/v1/documents/{doc_id}/move",
        json={
            "expected_revision_id": rev2,
            "path": "docs/moved_agent_doc.md",
        },
        headers=agent_headers,
    )
    assert move_resp.status_code == 200
    rev3 = move_resp.json()["current_revision_id"]

    # 4. Agent deletes document
    agent_headers["Idempotency-Key"] = "agent_idemp_delete"
    del_resp = client.request(
        "DELETE",
        f"/api/v1/documents/{doc_id}",
        json={"expected_revision_id": rev3},
        headers=agent_headers,
    )
    assert del_resp.status_code == 200
    rev4 = del_resp.json()["current_revision_id"]

    # 5. Agent restores document
    agent_headers["Idempotency-Key"] = "agent_idemp_restore"
    restore_resp = client.post(
        f"/api/v1/documents/{doc_id}/restore",
        json={
            "expected_revision_id": rev4,
            "revision_id": rev3,
        },
        headers=agent_headers,
    )
    assert restore_resp.status_code == 200

    # Query activity logs filtered by actor_id
    activity_resp = client.get("/api/v1/activity", params={"actor_id": "agent:auditor"})
    assert activity_resp.status_code == 200
    events = activity_resp.json()

    agent_actions = {e["action"]: e for e in events if e["resource_id"] == doc_id}
    assert agent_actions["create"]["actor_kind"] == "agent"
    assert agent_actions["create"]["actor_id"] == "agent:auditor"
    assert agent_actions["create"]["path"] == "docs/agent_doc.md"

    assert agent_actions["update"]["actor_kind"] == "agent"
    assert agent_actions["update"]["actor_id"] == "agent:auditor"
    assert agent_actions["update"]["path"] == "docs/agent_doc.md"

    assert agent_actions["move"]["actor_kind"] == "agent"
    assert agent_actions["move"]["path"] == "docs/moved_agent_doc.md"

    assert agent_actions["delete"]["actor_kind"] == "agent"
    assert agent_actions["delete"]["path"] == "docs/moved_agent_doc.md"

    assert agent_actions["restore"]["actor_kind"] == "agent"
    assert agent_actions["restore"]["path"] == "docs/moved_agent_doc.md"


def test_chat_proposal_patch_audit_logging(client: TestClient) -> None:
    from sangam.security import Principal

    # Human creates initial document
    doc_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Chat Patch Doc",
            "content": "Target Line Here\nAnother Line",
            "path": "docs/patch_doc.md",
        },
        headers=headers("idemp_patch_init"),
    )
    assert doc_resp.status_code == 201
    doc = doc_resp.json()
    doc_id = doc["document_id"]
    rev1 = doc["current_revision_id"]

    # Create thread ID using chatkit helper behavior
    thread_resp = client.post(
        "/api/v1/chatkit",
        json={
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": "Review this document"}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                }
            },
        },
        headers={"X-Sangam-Document-ID": doc_id},
    )
    assert thread_resp.status_code == 200
    events = [
        json.loads(line.removeprefix("data: "))
        for line in thread_resp.text.splitlines()
        if line.startswith("data: ")
    ]
    thread_id = next(e["thread"]["id"] for e in events if e.get("type") == "thread.created")

    # Create proposal directly via Chat service as the default trusted human principal
    chat_service = client.app.state.services.chat
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="audit-proposal",
    )
    proposal = chat_service.proposals.create(
        principal,
        thread_id=thread_id,
        document_id=doc_id,
        expected_revision_id=rev1,
        mode="replace",
        anchor="Target Line Here",
        content="Replaced Line Content",
        summary="Replace target line via proposal",
    )

    # Apply proposal via API endpoint
    apply_resp = client.post(
        f"/api/v1/chat/proposals/{proposal.proposal_id}/apply",
        json={"expected_revision_id": rev1},
        headers=headers("idemp_apply_prop"),
    )
    assert apply_resp.status_code == 200

    # Retrieve audit events for this document
    activity_resp = client.get(
        "/api/v1/activity", params={"resource_id": doc_id, "actor_kind": "human"}
    )
    assert activity_resp.status_code == 200
    activity_events = activity_resp.json()

    updates = [e for e in activity_events if e["action"] == "update"]
    assert len(updates) == 1
    update_event = updates[0]
    assert update_event["path"] == "docs/patch_doc.md"
    assert update_event["outcome"] == "accepted"
    assert update_event["actor_kind"] == "human"
    assert update_event["revision_id"] is not None
