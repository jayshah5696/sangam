from __future__ import annotations

import re

from fastapi.testclient import TestClient


def test_public_agent_discovery_points_to_hosted_skill_and_contract(client: TestClient) -> None:
    response = client.get("/llms.txt")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert response.headers["cache-control"] == "public, max-age=300"
    assert response.text.startswith("# Sangam\n")
    assert "http://testserver/skills/sangam/SKILL.md" in response.text
    assert "http://testserver/api/v1/openapi.json" in response.text
    assert "http://testserver/api/v1/docs" in response.text
    assert "sgm_agt_" not in response.text


def test_hosted_agent_skill_is_portable_specific_and_contains_no_secret(client: TestClient) -> None:
    response = client.get("/skills/sangam/SKILL.md")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/markdown")
    assert response.headers["cache-control"] == "public, max-age=300"
    assert response.text.startswith("---\nname: sangam\n")
    assert "description:" in response.text
    assert "http://testserver" in response.text
    assert "Idempotency-Key" in response.text
    assert "expected_revision_id" in response.text
    assert "409 revision_conflict" in response.text
    assert "403 authorization_denied" in response.text
    assert "sgm_agt_" not in response.text
    assert not re.search(r"SANGAM_TOKEN=['\"](?!\$|\{)", response.text)


def test_openapi_declares_bearer_security_and_stable_operation_ids(client: TestClient) -> None:
    schema = client.get("/api/v1/openapi.json").json()

    assert schema["openapi"].startswith("3.1.")
    assert schema["components"]["securitySchemes"]["AgentBearer"] == {
        "type": "http",
        "scheme": "bearer",
        "bearerFormat": "Sangam agent token",
        "description": (
            "A scoped token issued once by the workspace owner. Send it only in the "
            "Authorization header. Tokens can restrict capabilities, paths, and lifetime."
        ),
    }
    assert schema["paths"]["/api/v1/search"]["get"]["operationId"] == "searchDocuments"
    assert schema["paths"]["/api/v1/documents/{document_id}"]["get"]["operationId"] == (
        "getDocument"
    )
    assert schema["paths"]["/api/v1/documents/{document_id}"]["patch"]["operationId"] == (
        "updateDocument"
    )
    update_operation = schema["paths"]["/api/v1/documents/{document_id}"]["patch"]
    assert update_operation["security"] == [{"AgentBearer": []}]
    assert "reread, merge, and retry" in update_operation["description"]
    assert (
        update_operation["responses"]["409"]["content"]["application/json"]["examples"][
            "revisionConflict"
        ]["value"]["error"]["details"]["current_revision_id"]
        == "rev_current"
    )
    assert "security" not in schema["paths"]["/api/v1/health"]["get"]

    operation_ids = [
        operation["operationId"]
        for path in schema["paths"].values()
        for method, operation in path.items()
        if method in {"get", "post", "put", "patch", "delete"}
    ]
    assert len(operation_ids) == len(set(operation_ids))
    assert all(re.fullmatch(r"[a-z][A-Za-z0-9]*", operation_id) for operation_id in operation_ids)
