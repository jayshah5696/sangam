from __future__ import annotations

from fastapi.testclient import TestClient


def test_project_api_lifecycle(client: TestClient) -> None:
    # 1. Create a few documents to link into a project
    doc1_resp = client.post(
        "/api/v1/documents",
        json={"title": "Design Spec", "content": "# Design Spec\nSystem details.", "path": "spec.md"},
        headers={"Idempotency-Key": "test-doc-1"},
    )
    assert doc1_resp.status_code == 201
    doc1 = doc1_resp.json()

    doc2_resp = client.post(
        "/api/v1/documents",
        json={"title": "Research Notes", "content": "# Research\nUser feedback.", "path": "notes.md"},
        headers={"Idempotency-Key": "test-doc-2"},
    )
    assert doc2_resp.status_code == 201
    doc2 = doc2_resp.json()

    # 2. List projects initially empty
    resp = client.get("/api/v1/projects")
    assert resp.status_code == 200
    assert resp.json() == []

    # 3. Create a project
    create_payload = {
        "name": "Phase 7 Workspace",
        "description": "Building project-oriented home experience.",
        "primary_document_id": doc1["document_id"],
        "resume_hint": "Draft the project resume widget.",
        "document_ids": [doc1["document_id"]],
    }
    create_resp = client.post("/api/v1/projects", json=create_payload)
    assert create_resp.status_code == 201
    project = create_resp.json()
    project_id = project["project_id"]
    assert project["name"] == "Phase 7 Workspace"
    assert project["primary_document_id"] == doc1["document_id"]
    assert project["primary_document"] is not None
    assert project["primary_document"]["title"] == "Design Spec"
    assert len(project["documents"]) == 1

    # 4. Add second document with role 'notes'
    add_doc_resp = client.post(
        f"/api/v1/projects/{project_id}/documents",
        json={
            "document_id": doc2["document_id"],
            "role": "note",
            "context_summary": "Background interviews and user testing.",
            "resume_hint": "Incorporate findings into spec.",
        },
    )
    assert add_doc_resp.status_code == 201
    added_doc = add_doc_resp.json()
    assert added_doc["role"] == "note"
    assert added_doc["title"] == "Research Notes"

    # 5. Fetch project and verify documents
    get_resp = client.get(f"/api/v1/projects/{project_id}")
    assert get_resp.status_code == 200
    fetched = get_resp.json()
    assert len(fetched["documents"]) == 2
    roles = {d["role"] for d in fetched["documents"]}
    assert "draft" in roles
    assert "note" in roles

    # 6. Update project
    update_resp = client.patch(
        f"/api/v1/projects/{project_id}",
        json={
            "expected_metadata_version": fetched["metadata_version"],
            "resume_hint": "Review the newly incorporated user research.",
        },
    )
    assert update_resp.status_code == 200
    updated = update_resp.json()
    assert updated["resume_hint"] == "Review the newly incorporated user research."
    assert updated["metadata_version"] == fetched["metadata_version"] + 1

    # 7. Remove document
    del_doc_resp = client.delete(f"/api/v1/projects/{project_id}/documents/{doc2['document_id']}")
    assert del_doc_resp.status_code == 204

    refetched = client.get(f"/api/v1/projects/{project_id}").json()
    assert len(refetched["documents"]) == 1
    assert refetched["documents"][0]["document_id"] == doc1["document_id"]

    # 8. Archive project and test include_archived
    archive_resp = client.patch(
        f"/api/v1/projects/{project_id}",
        json={
            "archived": True,
        },
    )
    assert archive_resp.status_code == 200
    assert archive_resp.json()["archived"] is True

    # Active list should not include it
    active_projects = client.get("/api/v1/projects").json()
    assert len(active_projects) == 0

    # With include_archived=true it should appear
    all_projects = client.get("/api/v1/projects?include_archived=true").json()
    assert len(all_projects) == 1
    assert all_projects[0]["project_id"] == project_id

    # 9. Delete project
    del_resp = client.delete(f"/api/v1/projects/{project_id}")
    assert del_resp.status_code == 204

    assert client.get(f"/api/v1/projects/{project_id}").status_code == 404
