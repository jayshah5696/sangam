from __future__ import annotations

import pytest
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient

from sangam.application import build_application_services
from sangam.config import Settings
from sangam.errors import ConflictError, ValidationError
from sangam.schemas import AddProjectDocument, CreateProject
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


def test_child_assignment_scope_and_budget_constraints(settings: Settings):
    from sangam.assignments import AssignmentService, CreateAssignment
    from sangam.schemas import CreateProject

    services = build_application_services(settings)
    principal = Principal.trusted_human(
        actor_id=settings.trusted_human_actor_id, display_name="Local", operation_id="child-test"
    )
    project = services.projects.create_project(principal, CreateProject(name="Hierarchical"))
    doc1 = services.chat.workspace.create_document(
        principal, title="Doc 1", content="Alpha evidence.", path=None, idempotency_key="doc-1"
    )
    doc2 = services.chat.workspace.create_document(
        principal, title="Doc 2", content="Beta evidence.", path=None, idempotency_key="doc-2"
    )
    doc_outside = services.chat.workspace.create_document(
        principal, title="Outside", content="Gamma evidence.", path=None, idempotency_key="doc-out"
    )
    services.projects.add_document_once(
        principal,
        "add-1",
        project.project_id,
        AddProjectDocument(document_id=doc1.document_id, role="source"),
    )
    services.projects.add_document_once(
        principal,
        "add-2",
        project.project_id,
        AddProjectDocument(document_id=doc2.document_id, role="source"),
    )

    service = AssignmentService(services.chat, services.projects)
    parent = service.create(
        principal,
        project.project_id,
        CreateAssignment(
            instructions="Parent review",
            document_ids=[doc1.document_id, doc2.document_id],
            max_steps=5,
            max_seconds=300,
            max_budget_cents=5000,
        ),
        "parent-key",
    )
    assert parent.working_on == "Queued for execution"
    assert parent.child_assignments == []

    # Child attempting to include document not in parent scope
    with pytest.raises(ValidationError, match="subset of parent sources"):
        service.create(
            principal,
            project.project_id,
            CreateAssignment(
                instructions="Child with outside doc",
                document_ids=[doc1.document_id, doc_outside.document_id],
                parent_assignment_id=parent.assignment_id,
            ),
            "child-invalid-scope",
        )

    # Child exceeding steps
    with pytest.raises(ValidationError, match="cannot exceed parent remaining steps"):
        service.create(
            principal,
            project.project_id,
            CreateAssignment(
                instructions="Child steps",
                document_ids=[doc1.document_id],
                max_steps=6,
                parent_assignment_id=parent.assignment_id,
            ),
            "child-invalid-steps",
        )

    # Child exceeding budget
    with pytest.raises(ValidationError, match="cannot exceed parent remaining budget"):
        service.create(
            principal,
            project.project_id,
            CreateAssignment(
                instructions="Child budget",
                document_ids=[doc1.document_id],
                max_budget_cents=6000,
                parent_assignment_id=parent.assignment_id,
            ),
            "child-invalid-budget",
        )

    # Valid child
    child = service.create(
        principal,
        project.project_id,
        CreateAssignment(
            instructions="Child review",
            document_ids=[doc1.document_id],
            max_steps=2,
            max_seconds=100,
            max_budget_cents=2000,
            parent_assignment_id=parent.assignment_id,
        ),
        "child-valid-key",
    )
    assert child.parent_assignment_id == parent.assignment_id
    updated_parent = service.get(principal, parent.assignment_id)
    assert child.assignment_id in updated_parent.child_assignments


def test_pause_and_stop_propagation_to_children(settings: Settings):
    from sangam.assignments import AssignmentService, CreateAssignment
    from sangam.schemas import CreateProject

    services = build_application_services(settings)
    principal = Principal.trusted_human(
        actor_id=settings.trusted_human_actor_id, display_name="Local", operation_id="cascade-test"
    )
    project = services.projects.create_project(principal, CreateProject(name="Cascade"))
    doc = services.chat.workspace.create_document(
        principal, title="Doc", content="Evidence content.", path=None, idempotency_key="doc-c"
    )
    services.projects.add_document_once(
        principal,
        "add-c",
        project.project_id,
        AddProjectDocument(document_id=doc.document_id, role="source"),
    )

    service = AssignmentService(services.chat, services.projects)
    parent = service.create(
        principal,
        project.project_id,
        CreateAssignment(instructions="Parent", document_ids=[doc.document_id], max_steps=5),
        "parent-cascade",
    )
    child = service.create(
        principal,
        project.project_id,
        CreateAssignment(
            instructions="Child",
            document_ids=[doc.document_id],
            max_steps=2,
            parent_assignment_id=parent.assignment_id,
        ),
        "child-cascade",
    )

    # Pause propagation
    service.control(principal, parent.assignment_id, "pause", "", "parent-pause")
    assert service.get(principal, parent.assignment_id).status == "paused"
    assert service.get(principal, child.assignment_id).status == "paused"

    # Resume parent & child
    service.control(principal, parent.assignment_id, "resume", "", "parent-resume")
    service.control(principal, child.assignment_id, "resume", "", "child-resume")
    assert service.get(principal, parent.assignment_id).status == "queued"
    assert service.get(principal, child.assignment_id).status == "queued"

    # Stop propagation
    service.control(principal, parent.assignment_id, "stop", "", "parent-stop")
    assert service.get(principal, parent.assignment_id).status == "stopped"
    assert service.get(principal, child.assignment_id).status == "stopped"


def test_assignment_activity_and_judgment_state(settings: Settings):
    from sangam.assignments import AssignmentService, CreateAssignment
    from sangam.schemas import CreateProject

    services = build_application_services(settings)
    principal = Principal.trusted_human(
        actor_id=settings.trusted_human_actor_id, display_name="Local", operation_id="activity-test"
    )
    project = services.projects.create_project(principal, CreateProject(name="Activity"))
    doc = services.chat.workspace.create_document(
        principal, title="Benchmark", content="Latency is 10ms.", path=None, idempotency_key="doc-a"
    )
    services.projects.add_document_once(
        principal,
        "add-a",
        project.project_id,
        AddProjectDocument(document_id=doc.document_id, role="source"),
    )

    service = AssignmentService(services.chat, services.projects)
    assignment = service.create(
        principal,
        project.project_id,
        CreateAssignment(instructions="Verify latency", document_ids=[doc.document_id]),
        "activity-key",
    )
    assert assignment.working_on == "Queued for execution"

    claimed = service.claim()
    assert claimed.working_on == "Checking claims against workspace sources"

    # Simulate needs_judgment set by model
    expected_judgment = "Is 10ms measured on warm cache?"
    claimed.needs_judgment = expected_judgment
    service._save(claimed)
    assert (
        service.get(principal, assignment.assignment_id).needs_judgment
        == expected_judgment
    )

    # Steering resolves needs_judgment and records current direction
    service.control(principal, assignment.assignment_id, "steer", "Yes, warm cache", "steer-warm")
    refreshed = service.get(principal, assignment.assignment_id)
    assert refreshed.needs_judgment is None
    assert "Steered: Yes, warm cache" in (refreshed.working_on or "")


def test_document_assignments_endpoint(client: TestClient):
    project, doc = project_with_source(client)
    path = f"/api/v1/projects/{project['project_id']}/assignments"
    payload = {"instructions": "Find weak claims", "document_ids": [doc["document_id"]]}
    created = client.post(path, json=payload, headers=headers("doc-assign-test")).json()

    doc_path = f"/api/v1/documents/{doc['document_id']}/assignments"
    doc_assignments = client.get(doc_path, headers=headers("get-doc-assign")).json()
    assert any(a["assignment_id"] == created["assignment_id"] for a in doc_assignments)
