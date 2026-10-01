from __future__ import annotations

import pytest
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient

from sangam.application import build_application_services
from sangam.config import Settings
from sangam.errors import ConflictError, ValidationError
from sangam.schemas import CreateProject
from sangam.security import Principal


def project_with_source(client: TestClient):
    project = client.post("/api/v1/projects", json={"name": "Research"}).json()
    doc = client.post(
        "/api/v1/documents",
        json={"title": "Benchmark", "content": "CPU latency is 12 ms."},
        headers=headers("benchmark"),
    ).json()
    client.post(
        f"/api/v1/projects/{project['project_id']}/documents",
        json={"document_id": doc["document_id"], "role": "source"},
        headers=headers("membership"),
    )
    return project, doc


def test_assignment_start_replay_and_authority(client: TestClient):
    project, doc = project_with_source(client)
    path = f"/api/v1/projects/{project['project_id']}/assignments"
    payload = {"instructions": "Find weak claims", "document_ids": [doc["document_id"]]}
    first = client.post(path, json=payload, headers=headers("assignment"))
    assert first.status_code == 201, first.text
    repeated = client.post(path, json=payload, headers=headers("assignment"))
    assert repeated.status_code == 201
    assert repeated.json()["assignment_id"] == first.json()["assignment_id"]
    assert (
        client.post(
            path, json={**payload, "instructions": "Different"}, headers=headers("assignment")
        ).status_code
        == 409
    )
    outsider = client.post(
        "/api/v1/documents",
        json={"title": "Outside", "content": "Secret"},
        headers=headers("outside"),
    ).json()
    assert (
        client.post(
            path,
            json={**payload, "document_ids": [outsider["document_id"]]},
            headers=headers("escape"),
        ).status_code
        == 422
    )
    token = issue_agent_token(client, capabilities=("read", "inference"))
    assert client.get(path, headers={"Authorization": f"Bearer {token}"}).status_code == 403


def test_briefing_boundary_does_not_move_on_reads(client: TestClient):
    project, doc = project_with_source(client)
    base = f"/api/v1/projects/{project['project_id']}"
    initial = client.post(base + "/visits", headers=headers("visit")).json()
    assert initial["since"] is None
    changed = client.patch(
        f"/api/v1/documents/{doc['document_id']}",
        json={
            "expected_revision_id": doc["current_revision_id"],
            "content": "CPU latency is 20 ms.",
        },
        headers=headers("edit"),
    ).json()
    brief = client.get(base + "/briefing").json()
    assert brief["since"] == initial["as_of"]
    assert any(item["revision_id"] == changed["current_revision_id"] for item in brief["changes"])
    assert client.get(base + "/briefing").json()["since"] == brief["since"]
    second = client.post(base + "/visits", headers=headers("visit-two")).json()
    assert second["changes"] == brief["changes"]
    assert client.get(base + "/briefing").json()["changes"] == []


def test_controls_recovery_scope_and_exact_quotes(settings: Settings):
    from sangam.assignments import AssignmentService, CreateAssignment, ReviewResult

    services = build_application_services(settings)
    principal = Principal.trusted_human(
        actor_id=settings.trusted_human_actor_id, display_name="Local", operation_id="review-test"
    )
    project = services.projects.create_project(
        principal,
        CreateProject(name="Review"),
    )
    service = AssignmentService(services.chat, services.projects)
    body = CreateAssignment(instructions="Review purpose", document_ids=[project.brief_document_id])
    assignment = service.create(principal, project.project_id, body, "start")
    service.control(principal, assignment.assignment_id, "pause", "", "pause")
    service.recover()
    assert service.get(principal, assignment.assignment_id).status == "paused"
    service.control(principal, assignment.assignment_id, "steer", "CPU matters", "steer")
    assert service.get(principal, assignment.assignment_id).status == "paused"
    service.control(principal, assignment.assignment_id, "resume", "", "resume")
    claimed = service.claim()
    assert claimed.assignment_id == assignment.assignment_id
    service.recover()
    assert service.get(principal, assignment.assignment_id).status == "queued"
    service.control(principal, assignment.assignment_id, "stop", "", "stop")
    service.recover()
    assert service.get(principal, assignment.assignment_id).status == "stopped"
    with pytest.raises(ConflictError):
        service.control(principal, assignment.assignment_id, "resume", "", "resume-stopped")
    fabricated = ReviewResult.model_validate(
        {
            "findings": [
                {
                    "kind": "weak_claim",
                    "explanation": "Unsupported",
                    "missing_evidence": None,
                    "citations": [
                        {
                            "document_id": project.brief_document_id,
                            "revision_id": "invented",
                            "snippet": "invented",
                        }
                    ],
                }
            ]
        }
    )
    with pytest.raises(ValidationError):
        service.validate_result(principal, assignment, fabricated)


def test_invalid_model_result_never_becomes_an_artifact(settings: Settings):
    from sangam.assignments import AssignmentService, CreateAssignment, ReviewResult
    from sangam.schemas import CreateProject

    services = build_application_services(settings)
    principal = Principal.trusted_human(
        actor_id=settings.trusted_human_actor_id,
        display_name="Local",
        operation_id="invalid-review",
    )
    project = services.projects.create_project(principal, CreateProject(name="Review"))
    service = AssignmentService(services.chat, services.projects)
    assignment = service.create(
        principal,
        project.project_id,
        CreateAssignment(instructions="Review", document_ids=[project.brief_document_id]),
        "start",
    )
    unsupported = ReviewResult.model_validate(
        {
            "findings": [
                {
                    "kind": "weak_claim",
                    "explanation": "No source",
                    "missing_evidence": None,
                    "citations": [],
                }
            ]
        }
    )
    with pytest.raises(ValidationError):
        service.validate_result(principal, assignment, unsupported)
