"""Tests for user-authored chat skills:
registration, scoping, diagnostics, pinning, and execution."""

from __future__ import annotations

from conftest import run_in_app
from fastapi.testclient import TestClient

from sangam.chat_context import ChatRequestContext
from sangam.chat_skills import parse_skill_content
from sangam.security import Principal


def _create_doc(client: TestClient, title: str, content: str) -> str:
    res = client.post(
        "/api/v1/documents",
        json={"title": title, "content": content, "content_type": "text/markdown"},
        headers={"Idempotency-Key": f"create-{title}"},
    )
    assert res.status_code == 201
    return res.json()["document_id"]


def test_parse_skill_content():
    # Valid
    valid = (
        "---\nname: code-review\ndescription: Review pull requests\n---\n"
        "## Instructions\nDo review."
    )
    parsed, proc, diags = parse_skill_content(valid)
    assert parsed is not None
    assert parsed.name == "code-review"
    assert parsed.description == "Review pull requests"
    assert "Do review." in proc
    assert len(diags) == 0

    # Malformed frontmatter
    malformed = "---\nname: [unclosed\n---\nBody"
    parsed, proc, diags = parse_skill_content(malformed)
    assert parsed is None
    assert any("Malformed YAML" in d for d in diags)

    # Missing frontmatter
    no_fm = "Just some text without frontmatter"
    parsed, proc, diags = parse_skill_content(no_fm)
    assert parsed is None
    assert any("must begin with YAML frontmatter" in d for d in diags)

    # Invalid name
    bad_name = "---\nname: Invalid_Name!\ndescription: Test\n---\nProcedure"
    parsed, proc, diags = parse_skill_content(bad_name)
    assert any("must be 1-64 characters matching lowercase alphanumeric" in d for d in diags)

    # Scripts declared
    with_scripts = (
        "---\nname: run-tests\ndescription: Run tests\nscripts:\n  - ./test.sh\n---\nBody"
    )
    parsed, proc, diags = parse_skill_content(with_scripts)
    assert parsed is not None
    assert parsed.scripts is not None


def test_register_and_get_personal_skill(client: TestClient):
    content = (
        "---\nname: summarize-spec\ndescription: Summarize architecture specifications\n---\n"
        "Follow these steps:\n1. Extract goals\n2. List components"
    )
    doc_id = _create_doc(client, "Summarize Spec Skill", content)

    # Register
    res = client.post(
        "/api/v1/chat/skills",
        json={"document_id": doc_id},
        headers={"Idempotency-Key": "reg-1"},
    )
    assert res.status_code == 201
    skill = res.json()
    assert skill["name"] == "summarize-spec"
    assert skill["description"] == "Summarize architecture specifications"
    assert skill["origin"] == "personal"
    assert skill["valid"] is True
    assert skill["has_scripts"] is False
    assert skill["skill_id"].endswith(":user:summarize-spec")

    # Replay with same idempotency key
    replay = client.post(
        "/api/v1/chat/skills",
        json={"document_id": doc_id},
        headers={"Idempotency-Key": "reg-1"},
    )
    assert replay.status_code == 201
    assert replay.json()["skill_id"] == skill["skill_id"]

    # Get by ID
    get_res = client.get(f"/api/v1/chat/skills/{skill['skill_id']}")
    assert get_res.status_code == 200
    assert get_res.json()["skill_id"] == skill["skill_id"]

    # List skills
    list_res = client.get("/api/v1/chat/skills")
    assert list_res.status_code == 200
    skills = list_res.json()
    assert any(s["skill_id"] == skill["skill_id"] for s in skills)


def test_register_project_scoped_skill(client: TestClient):
    project = client.post("/api/v1/projects", json={"name": "Atlas", "create_brief": False}).json()
    project_id = project["project_id"]

    content = (
        "---\nname: deploy-guide\ndescription: Atlas deployment instructions\n---\n"
        "Steps to deploy Atlas."
    )
    doc_id = _create_doc(client, "Atlas Deploy Skill", content)

    # Cannot register as project skill if document is not in project
    fail_res = client.post(
        "/api/v1/chat/skills",
        json={"document_id": doc_id, "project_id": project_id},
    )
    assert fail_res.status_code == 422
    assert "must be an explicit member" in fail_res.text

    # Add document to project
    add_doc = client.post(
        f"/api/v1/projects/{project_id}/documents",
        json={"document_id": doc_id},
        headers={"Idempotency-Key": "add-doc-atlas"},
    )
    assert add_doc.status_code == 201

    # Now register succeeds
    res = client.post(
        "/api/v1/chat/skills",
        json={"document_id": doc_id, "project_id": project_id},
    )
    assert res.status_code == 201
    skill = res.json()
    assert skill["origin"] == "project"
    assert skill["project_id"] == project_id
    assert f":project:{project_id}:deploy-guide" in skill["skill_id"]


def test_scripts_reported_as_unsupported(client: TestClient):
    content = (
        "---\nname: script-runner\ndescription: A skill with scripts\nscripts:\n"
        "  - ./run.py\n---\nRun the script."
    )
    doc_id = _create_doc(client, "Script Skill", content)

    res = client.post("/api/v1/chat/skills", json={"document_id": doc_id})
    assert res.status_code == 201
    skill = res.json()
    assert skill["has_scripts"] is True
    assert any("does not support them" in d for d in skill["diagnostics"])


def test_conflict_on_duplicate_name_different_document(client: TestClient):
    content1 = "---\nname: shared-name\ndescription: First skill\n---\nProcedure 1"
    content2 = "---\nname: shared-name\ndescription: Second skill\n---\nProcedure 2"
    doc1 = _create_doc(client, "Skill 1", content1)
    doc2 = _create_doc(client, "Skill 2", content2)

    res1 = client.post("/api/v1/chat/skills", json={"document_id": doc1})
    assert res1.status_code == 201

    # Conflict in same personal scope
    res2 = client.post("/api/v1/chat/skills", json={"document_id": doc2})
    assert res2.status_code == 409


def test_unregister_skill(client: TestClient):
    content = "---\nname: temp-skill\ndescription: Temporary\n---\nTemp procedure"
    doc_id = _create_doc(client, "Temp Skill", content)

    res = client.post("/api/v1/chat/skills", json={"document_id": doc_id})
    assert res.status_code == 201
    skill_id = res.json()["skill_id"]

    del_res = client.delete(f"/api/v1/chat/skills/{skill_id}")
    assert del_res.status_code == 204

    # Now get returns 404
    get_res = client.get(f"/api/v1/chat/skills/{skill_id}")
    assert get_res.status_code == 404


def test_skill_activation_and_revision_pinning(client: TestClient):
    content = "---\nname: pinned-task\ndescription: Test pinning\n---\nOriginal instructions."
    doc_id = _create_doc(client, "Pinning Skill", content)

    res = client.post("/api/v1/chat/skills", json={"document_id": doc_id})
    assert res.status_code == 201
    skill_id = res.json()["skill_id"]

    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="test-skill"
    )
    chat = client.app.state.services.chat
    turn = chat.evidence.create_turn_context(
        principal, entry_point="workspace", document_id=None, revision_id=None, selected_text=""
    )
    req_context = ChatRequestContext(
        principal=principal,
        context_snapshot_id=turn.context_id,
    )

    # First activation
    act1 = chat.skills.activate(principal, req_context, skill_id)
    assert act1.procedure.strip() == "Original instructions."
    original_rev = act1.revision_id

    # Update the document to a new revision
    doc_res = client.get(f"/api/v1/documents/{doc_id}").json()
    patch_res = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={
            "expected_revision_id": doc_res["current_revision_id"],
            "content": (
                "---\nname: pinned-task\ndescription: Test pinning\n---\n"
                "Modified instructions next turn."
            ),
        },
        headers={"Idempotency-Key": "patch-skill-doc"},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["current_revision_id"] != original_rev

    # Second activation in the SAME turn context pins the original revision!
    act2 = chat.skills.activate(principal, req_context, skill_id)
    assert act2.revision_id == original_rev
    assert act2.procedure.strip() == "Original instructions."

    # In a NEW turn context, the new revision is loaded
    turn2 = chat.evidence.create_turn_context(
        principal, entry_point="workspace", document_id=None, revision_id=None, selected_text=""
    )
    req_context2 = ChatRequestContext(
        principal=principal,
        context_snapshot_id=turn2.context_id,
    )
    act3 = chat.skills.activate(principal, req_context2, skill_id)
    assert act3.revision_id != original_rev
    assert "Modified instructions next turn." in act3.procedure


def test_prompt_catalog_includes_skills(client: TestClient):
    content = (
        "---\nname: catalog-test\ndescription: Test in prompt catalog\n---\nCatalog instructions."
    )
    doc_id = _create_doc(client, "Catalog Skill", content)
    client.post("/api/v1/chat/skills", json={"document_id": doc_id})

    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="test-catalog"
    )
    chat = client.app.state.services.chat
    context = ChatRequestContext(principal=principal)
    text = run_in_app(client, chat.app_context(context, "thread"))

    assert "<CHAT_SKILLS>" in text
    assert "catalog-test" in text
    assert "Test in prompt catalog" in text
    assert "activate_chat_skill" in text
