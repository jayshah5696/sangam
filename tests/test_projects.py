from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient

from sangam.application import build_application_services
from sangam.config import Settings
from sangam.schemas import (
    AddProjectDocument,
    CreateProject,
)
from sangam.security import Principal


def test_projects_reject_scoped_agents_without_disclosing_references(client: TestClient) -> None:
    project = client.post("/api/v1/projects", json={"name": "Private"}).json()
    token = issue_agent_token(
        client, capabilities=("read", "create", "update"), path_prefix="public"
    )
    auth = {"Authorization": f"Bearer {token}"}
    for method, path, body in [
        ("GET", "/api/v1/projects", None),
        ("GET", f"/api/v1/projects/{project['project_id']}", None),
        ("POST", "/api/v1/projects", {"name": "Escape"}),
        ("PATCH", f"/api/v1/projects/{project['project_id']}", {"name": "Escape"}),
        ("DELETE", f"/api/v1/projects/{project['project_id']}", None),
    ]:
        response = client.request(method, path, json=body, headers=auth)
        assert response.status_code == 403, response.text
        assert project["brief_document_id"] not in response.text


def test_project_create_and_delete_replay_do_not_duplicate_brief(client: TestClient) -> None:
    payload = {"name": "Replay", "description": "One purpose"}
    first = client.post("/api/v1/projects", json=payload, headers=headers("project-replay"))
    second = client.post("/api/v1/projects", json=payload, headers=headers("project-replay"))
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert len(client.get("/api/v1/projects").json()) == 1
    assert len(client.get("/api/v1/documents").json()) == 1
    conflict = client.post(
        "/api/v1/projects", json={"name": "Other"}, headers=headers("project-replay")
    )
    assert conflict.status_code == 409
    path = f"/api/v1/projects/{first.json()['project_id']}"
    assert client.delete(path, headers=headers("delete-replay")).status_code == 204
    assert client.delete(path, headers=headers("delete-replay")).status_code == 204


def test_project_optimistic_conflict_and_explicit_null_clear(client: TestClient) -> None:
    project = client.post(
        "/api/v1/projects", json={"name": "Concurrent", "description": "Purpose"}
    ).json()
    path = f"/api/v1/projects/{project['project_id']}"

    def update(name: str):
        return client.patch(path, json={"name": name, "expected_version": project["version"]})

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(update, ["First", "Second"]))
    assert sorted(r.status_code for r in responses) == [200, 409]
    current = client.get(path).json()
    cleared = client.patch(
        path,
        json={
            "description": None,
            "brief_document_id": None,
            "expected_version": current["version"],
        },
    )
    assert cleared.status_code == 200
    assert cleared.json()["description"] is None
    assert cleared.json()["brief_document_id"] is None


def test_project_rejects_invalid_layout_and_nonmember_draft(client: TestClient) -> None:
    project = client.post("/api/v1/projects", json={"name": "Layout"}).json()
    doc = client.post(
        "/api/v1/documents",
        json={"title": "Unrelated", "content": "Body"},
        headers=headers("unrelated"),
    ).json()
    path = f"/api/v1/projects/{project['project_id']}"
    assert client.patch(path, json={"workbench_state_json": "{bad"}).status_code == 422
    assert (
        client.patch(path, json={"workbench_state_json": json.dumps({"groups": []})}).status_code
        == 422
    )
    assert client.patch(path, json={"active_document_id": doc["document_id"]}).status_code == 422
    assert (
        client.patch(path, json={"active_document_id": project["brief_document_id"]}).status_code
        == 422
    )


def test_project_source_revision_and_membership_nulls(client: TestClient) -> None:
    project = client.post(
        "/api/v1/projects", json={"name": "Sources", "create_brief": False}
    ).json()
    doc = client.post(
        "/api/v1/documents",
        json={"title": "Decision", "content": "# Header\n\nUseful body."},
        headers=headers("source"),
    ).json()
    path = f"/api/v1/projects/{project['project_id']}/documents"
    added = client.post(
        path,
        json={
            "document_id": doc["document_id"],
            "role": "decision",
            "notes": "Keep this",
            "pinned_page": 1,
        },
    )
    assert added.status_code == 201
    assert added.json()["source_revision_id"] == doc["current_revision_id"]
    assert added.json()["excerpt"] == "Useful body."
    changed = client.patch(
        f"/api/v1/documents/{doc['document_id']}",
        json={
            "content": "# Header\n\nNew body.",
            "expected_revision_id": doc["current_revision_id"],
        },
        headers=headers("change-source"),
    )
    assert changed.status_code == 200, changed.text
    detail = client.get(f"/api/v1/projects/{project['project_id']}").json()
    assert detail["documents"][0]["source_updated"] is True
    cleared = client.patch(
        f"{path}/{doc['document_id']}",
        json={
            "notes": None,
            "pinned_page": None,
            "source_revision_id": changed.json()["current_revision_id"],
        },
    )
    assert cleared.status_code == 200
    assert cleared.json()["notes"] is None
    assert cleared.json()["pinned_page"] is None
    assert cleared.json()["source_updated"] is False


def test_project_atomic_audit_failure_rolls_back_brief(settings: Settings) -> None:
    services = build_application_services(settings)
    principal = Principal.trusted_human(
        actor_id=settings.trusted_human_actor_id,
        display_name="Owner",
        operation_id="atomic-project",
    )
    with services.projects.database.connection() as conn:
        conn.execute(
            "CREATE TRIGGER fail_project_audit BEFORE INSERT ON operation_events "
            "WHEN NEW.resource_type = 'project' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END"
        )
    with pytest.raises(Exception, match="audit blocked"):
        services.projects.create_project_once(
            principal, "atomic-key", CreateProject(name="Rollback")
        )
    assert services.projects.list_projects() == []
    assert services.documents.list_document_summaries() == []


def test_deleted_brief_is_not_a_resume_reference(client: TestClient) -> None:
    project = client.post("/api/v1/projects", json={"name": "Deleted brief"}).json()
    brief = client.get(f"/api/v1/documents/{project['brief_document_id']}").json()
    response = client.request(
        "DELETE",
        f"/api/v1/documents/{project['brief_document_id']}",
        json={"expected_revision_id": brief["current_revision_id"]},
        headers=headers("trash-brief"),
    )
    assert response.status_code == 200
    detail = client.get(f"/api/v1/projects/{project['project_id']}").json()
    assert detail["brief_document_id"] is None
    assert detail["active_document_id"] is None
    assert detail["documents"] == []


def test_project_crud_and_auto_brief(client: TestClient) -> None:
    # 1. Create project with auto-generated brief
    create_res = client.post(
        "/api/v1/projects",
        json={
            "name": "Distributed Consensus Review",
            "description": "Evaluate Raft and Paxos implementations for Sangam.",
            "create_brief": True,
        },
    )
    assert create_res.status_code == 201
    project = create_res.json()
    project_id = project["project_id"]
    assert project["name"] == "Distributed Consensus Review"
    assert project["description"] == "Evaluate Raft and Paxos implementations for Sangam."
    assert project["brief_document_id"] is not None
    assert project["brief_document_title"] == "Distributed Consensus Review Brief"
    assert project["document_count"] == 1
    assert len(project["documents"]) == 1
    assert project["documents"][0]["role"] == "note"

    # Verify brief document exists as an ordinary Markdown document
    brief_id = project["brief_document_id"]
    doc_res = client.get(f"/api/v1/documents/{brief_id}")
    assert doc_res.status_code == 200
    brief_doc = doc_res.json()
    assert brief_doc["title"] == "Distributed Consensus Review Brief"
    assert "Distributed Consensus Review" in brief_doc["content"]
    assert "Evaluate Raft and Paxos" in brief_doc["content"]

    # 2. Get project details
    get_res = client.get(f"/api/v1/projects/{project_id}")
    assert get_res.status_code == 200
    assert get_res.json()["project_id"] == project_id

    # 3. Update project details and workbench state
    layout_state = {
        "schemaVersion": 1,
        "activeGroupId": "group-1",
        "recentlyClosed": [],
        "root": {
            "kind": "group",
            "id": "group-1",
            "activeTabId": brief_id,
            "tabs": [{"documentId": brief_id, "title": "Brief", "pinned": False}],
        },
    }
    update_res = client.patch(
        f"/api/v1/projects/{project_id}",
        json={
            "name": "Distributed Consensus Deep Dive",
            "workbench_state_json": json.dumps(layout_state),
        },
    )
    assert update_res.status_code == 200
    updated = update_res.json()
    assert updated["name"] == "Distributed Consensus Deep Dive"
    assert json.loads(updated["workbench_state_json"]) == layout_state

    # 4. List projects
    list_res = client.get("/api/v1/projects")
    assert list_res.status_code == 200
    summaries = list_res.json()
    assert len(summaries) >= 1
    assert any(s["project_id"] == project_id for s in summaries)


def test_document_membership_shared_across_projects(client: TestClient) -> None:
    # Create two source documents
    doc1 = client.post(
        "/api/v1/documents",
        json={"title": "Raft Paper", "content": "# Raft\nIn Search of Understandable Consensus."},
        headers=headers("create-raft"),
    ).json()
    doc2 = client.post(
        "/api/v1/documents",
        json={"title": "Paxos Paper", "content": "# Paxos\nThe Part-Time Parliament."},
        headers=headers("create-paxos"),
    ).json()

    # Create two distinct projects
    p1 = client.post(
        "/api/v1/projects",
        json={"name": "Storage Engine", "create_brief": False},
    ).json()
    p2 = client.post(
        "/api/v1/projects",
        json={"name": "Replication Protocol", "create_brief": False},
    ).json()

    # Add Raft paper to p1 as 'source' with pinned page 1
    add_res1 = client.post(
        f"/api/v1/projects/{p1['project_id']}/documents",
        json={"document_id": doc1["document_id"], "role": "source", "pinned_page": 1},
    )
    assert add_res1.status_code == 201

    # Add same Raft paper to p2 as 'output' with pinned page 10 and custom notes
    add_res2 = client.post(
        f"/api/v1/projects/{p2['project_id']}/documents",
        json={
            "document_id": doc1["document_id"],
            "role": "output",
            "pinned_page": 10,
            "notes": "Reference for state machine replication",
        },
    )
    assert add_res2.status_code == 201

    # Add Paxos paper only to p2
    client.post(
        f"/api/v1/projects/{p2['project_id']}/documents",
        json={"document_id": doc2["document_id"], "role": "source"},
    )

    # Verify Project 1 has only Raft with role 'source' and pinned page 1
    p1_detail = client.get(f"/api/v1/projects/{p1['project_id']}").json()
    assert p1_detail["document_count"] == 1
    assert p1_detail["documents"][0]["document_id"] == doc1["document_id"]
    assert p1_detail["documents"][0]["role"] == "source"
    assert p1_detail["documents"][0]["pinned_page"] == 1

    # Verify Project 2 has both documents, with Raft role 'output' and pinned page 10
    p2_detail = client.get(f"/api/v1/projects/{p2['project_id']}").json()
    assert p2_detail["document_count"] == 2
    raft_in_p2 = next(d for d in p2_detail["documents"] if d["document_id"] == doc1["document_id"])
    assert raft_in_p2["role"] == "output"
    assert raft_in_p2["pinned_page"] == 10
    assert raft_in_p2["notes"] == "Reference for state machine replication"

    # Update document role in Project 1
    patch_doc = client.patch(
        f"/api/v1/projects/{p1['project_id']}/documents/{doc1['document_id']}",
        json={"role": "note", "notes": "Audited for storage"},
    )
    assert patch_doc.status_code == 200
    assert patch_doc.json()["role"] == "note"
    assert patch_doc.json()["notes"] == "Audited for storage"

    # Verify Project 2 was NOT affected
    p2_detail_after = client.get(f"/api/v1/projects/{p2['project_id']}").json()
    raft_in_p2_after = next(
        d for d in p2_detail_after["documents"] if d["document_id"] == doc1["document_id"]
    )
    assert raft_in_p2_after["role"] == "output"

    # Remove document from Project 1
    del_res = client.delete(f"/api/v1/projects/{p1['project_id']}/documents/{doc1['document_id']}")
    assert del_res.status_code == 204

    # Verify Project 1 now has 0 documents
    p1_empty = client.get(f"/api/v1/projects/{p1['project_id']}").json()
    assert p1_empty["document_count"] == 0

    # Underlying document must still exist!
    assert client.get(f"/api/v1/documents/{doc1['document_id']}").status_code == 200
    # And Project 2 still has Raft!
    assert client.get(f"/api/v1/projects/{p2['project_id']}").json()["document_count"] == 2


def test_delete_project_preserves_documents(client: TestClient) -> None:
    # Create project with brief
    p = client.post(
        "/api/v1/projects",
        json={"name": "Temporary Project", "create_brief": True},
    ).json()
    brief_id = p["brief_document_id"]
    project_id = p["project_id"]

    # Delete project
    del_res = client.delete(f"/api/v1/projects/{project_id}")
    assert del_res.status_code == 204

    # Project is gone
    assert client.get(f"/api/v1/projects/{project_id}").status_code == 404

    # Brief document is still intact!
    assert client.get(f"/api/v1/documents/{brief_id}").status_code == 200


def test_removing_brief_document_clears_project_brief_id(client: TestClient) -> None:
    p = client.post(
        "/api/v1/projects",
        json={"name": "Brief Clearing Test", "create_brief": True},
    ).json()
    project_id = p["project_id"]
    brief_id = p["brief_document_id"]

    client.delete(f"/api/v1/projects/{project_id}/documents/{brief_id}")

    detail = client.get(f"/api/v1/projects/{project_id}").json()
    assert detail["brief_document_id"] is None
    assert detail["brief_document_title"] is None


def test_project_performance_and_bulk_operations(settings: Settings) -> None:
    services = build_application_services(settings)
    principal = Principal.trusted_human(
        actor_id=settings.trusted_human_actor_id,
        display_name=settings.trusted_human_display_name,
        operation_id="op_bench",
    )

    # Create 50 documents
    doc_ids: list[str] = []
    for i in range(50):
        doc = services.documents.create_document(
            title=f"Doc {i}",
            content=f"Content for doc {i}",
            path=f"bench/doc_{i}.md",
            actor_id=principal.actor_id,
            idempotency_key=f"bench_doc_{i}",
        )
        doc_ids.append(doc.document_id)

    # Create 10 projects
    project_ids: list[str] = []
    for i in range(10):
        proj = services.projects.create_project(
            principal,
            CreateProject(name=f"Project {i}", create_brief=True),
        )
        project_ids.append(proj.project_id)

    # Attach all 50 documents across projects
    for p_idx, p_id in enumerate(project_ids):
        for d_idx in range(p_idx * 4, min(len(doc_ids), (p_idx + 1) * 8)):
            services.projects.add_document(
                principal,
                p_id,
                AddProjectDocument(
                    document_id=doc_ids[d_idx],
                    role="source" if d_idx % 2 == 0 else "draft",
                    pinned_page=(d_idx % 10) + 1,
                    notes=f"Note for doc {d_idx}",
                ),
            )

    # Verify list query returns all 10 projects efficiently with correct counts
    summaries = services.projects.list_projects()
    assert len(summaries) == 10
    assert all(s.document_count >= 1 for s in summaries)

    # Verify query plan for project listing uses index
    with services.projects.database.connection() as conn:
        plan = conn.execute(
            "EXPLAIN QUERY PLAN SELECT * FROM projects ORDER BY updated_at DESC"
        ).fetchall()
        plan_desc = " ".join(r["detail"] for r in plan)
        assert "projects_updated_at_idx" in plan_desc


def test_project_metadata_sanitization_rejects_null_bytes_and_control_characters(
    client: TestClient,
) -> None:
    # 1. Project creation rejecting null bytes and control characters
    bad_name_null = client.post("/api/v1/projects", json={"name": "Bad\x00Name"})
    assert bad_name_null.status_code == 422
    msg = bad_name_null.json()["error"]["message"]
    assert "Project name cannot contain null bytes" in msg

    bad_name_ctrl = client.post("/api/v1/projects", json={"name": "Bad\x07Name"})
    assert bad_name_ctrl.status_code == 422
    msg = bad_name_ctrl.json()["error"]["message"]
    assert "Project name cannot contain control characters" in msg

    bad_desc_null = client.post(
        "/api/v1/projects", json={"name": "Valid", "description": "Bad\x00Desc"}
    )
    assert bad_desc_null.status_code == 422
    msg = bad_desc_null.json()["error"]["message"]
    assert "Project description cannot contain null bytes" in msg

    bad_desc_ctrl = client.post(
        "/api/v1/projects", json={"name": "Valid", "description": "Bad\x1fDesc"}
    )
    assert bad_desc_ctrl.status_code == 422
    msg = bad_desc_ctrl.json()["error"]["message"]
    assert "Project description cannot contain control characters" in msg

    # Create a valid project for update tests
    project = client.post("/api/v1/projects", json={"name": "Sanitization Test"}).json()
    project_id = project["project_id"]

    # 2. Project update rejecting null bytes and control characters
    bad_update_name = client.patch(f"/api/v1/projects/{project_id}", json={"name": "Bad\x00Update"})
    assert bad_update_name.status_code == 422
    msg = bad_update_name.json()["error"]["message"]
    assert "Project name cannot contain null bytes" in msg

    bad_update_desc = client.patch(
        f"/api/v1/projects/{project_id}", json={"description": "Bad\x08Desc"}
    )
    assert bad_update_desc.status_code == 422
    msg = bad_update_desc.json()["error"]["message"]
    assert "Project description cannot contain control characters" in msg

    # Create a valid document to attach
    doc = client.post(
        "/api/v1/documents",
        json={"title": "Test Doc", "content": "Sample content"},
        headers=headers("doc-sanitization"),
    ).json()

    # 3. Adding project document notes rejecting null bytes and control characters
    bad_add_notes_null = client.post(
        f"/api/v1/projects/{project_id}/documents",
        json={"document_id": doc["document_id"], "role": "source", "notes": "Bad\x00Note"},
    )
    assert bad_add_notes_null.status_code == 422
    msg = bad_add_notes_null.json()["error"]["message"]
    assert "Document notes cannot contain null bytes" in msg

    bad_add_notes_ctrl = client.post(
        f"/api/v1/projects/{project_id}/documents",
        json={"document_id": doc["document_id"], "role": "source", "notes": "Bad\x03Note"},
    )
    assert bad_add_notes_ctrl.status_code == 422
    msg = bad_add_notes_ctrl.json()["error"]["message"]
    assert "Document notes cannot contain control characters" in msg

    # Add document with valid notes
    client.post(
        f"/api/v1/projects/{project_id}/documents",
        json={"document_id": doc["document_id"], "role": "source", "notes": "Valid notes"},
    )

    # 4. Updating project document notes rejecting null bytes and control characters
    bad_update_notes_null = client.patch(
        f"/api/v1/projects/{project_id}/documents/{doc['document_id']}",
        json={"notes": "Bad\x00UpdateNote"},
    )
    assert bad_update_notes_null.status_code == 422
    msg = bad_update_notes_null.json()["error"]["message"]
    assert "Document notes cannot contain null bytes" in msg

    bad_update_notes_ctrl = client.patch(
        f"/api/v1/projects/{project_id}/documents/{doc['document_id']}",
        json={"notes": "Bad\x1eUpdateNote"},
    )
    assert bad_update_notes_ctrl.status_code == 422
    msg = bad_update_notes_ctrl.json()["error"]["message"]
    assert "Document notes cannot contain control characters" in msg
