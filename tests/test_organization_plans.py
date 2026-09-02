from __future__ import annotations

import pytest
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient


def create_document(client: TestClient, *, title: str, path: str, key: str) -> dict[str, object]:
    response = client.post(
        "/api/v1/documents",
        headers=headers(key),
        json={"title": title, "path": path, "content": f"# {title}"},
    )
    assert response.status_code == 201
    return response.json()


def move_operation(document: dict[str, object], destination: str) -> dict[str, object]:
    return {
        "kind": "move_document",
        "document_id": document["document_id"],
        "expected_revision_id": document["current_revision_id"],
        "expected_source_path": document["path"],
        "destination_path": destination,
    }


def test_bounded_organization_snapshot_includes_stable_state(client: TestClient) -> None:
    document = create_document(client, title="Plan", path="projects/plan.md", key="document")

    response = client.get("/api/v1/organization", params={"limit": 2})

    assert response.status_code == 200
    payload = response.json()
    assert payload["limit"] == 2
    matching = next(
        item for item in payload["items"] if item.get("document_id") == document["document_id"]
    )
    assert matching["current_revision_id"] == document["current_revision_id"]
    assert matching["metadata_version"] == document["metadata_version"]
    assert "content" not in matching


def test_plan_moves_documents_and_duplicate_delivery_returns_original_result(
    client: TestClient,
) -> None:
    first = create_document(client, title="First", path="inbox/first.md", key="first")
    second = create_document(client, title="Second", path="inbox/second.md", key="second")
    created_folder = client.post(
        "/api/v1/folders", headers=headers("folder"), json={"path": "archive"}
    )
    assert created_folder.status_code == 201
    body = {
        "operations": [
            move_operation(first, "archive/first.md"),
            move_operation(second, "archive/second.md"),
        ]
    }

    applied = client.post("/api/v1/organization/plans", headers=headers("move-both"), json=body)
    replayed = client.post("/api/v1/organization/plans", headers=headers("move-both"), json=body)

    assert applied.status_code == 200
    assert applied.json()["status"] == "completed"
    assert applied.json()["completed"] == 2
    assert replayed.json() == applied.json()
    assert (
        client.get(f"/api/v1/documents/{first['document_id']}").json()["path"] == "archive/first.md"
    )
    assert (
        client.get(f"/api/v1/documents/{second['document_id']}").json()["path"]
        == "archive/second.md"
    )


def test_plan_materializes_an_unmaterialized_document(client: TestClient) -> None:
    draft_response = client.post(
        "/api/v1/documents",
        headers=headers("draft-document"),
        json={"title": "Sample 2", "content": "# Sample 2", "path": None},
    )
    assert draft_response.status_code == 201
    draft = draft_response.json()

    response = client.post(
        "/api/v1/organization/plans",
        headers=headers("materialize-draft-plan"),
        json={
            "operations": [
                {
                    "kind": "materialize_document",
                    "document_id": draft["document_id"],
                    "expected_revision_id": draft["current_revision_id"],
                    "destination_path": "projects/sample-2.md",
                }
            ]
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "completed"
    current = client.get(f"/api/v1/documents/{draft['document_id']}").json()
    assert current["path"] == "projects/sample-2.md"


def test_plan_preflight_rejects_stale_revision_before_any_write(client: TestClient) -> None:
    first = create_document(client, title="First", path="inbox/first.md", key="stale-first")
    second = create_document(client, title="Second", path="inbox/second.md", key="stale-second")
    body = {
        "operations": [
            move_operation(first, "first.md"),
            {
                **move_operation(second, "second.md"),
                "expected_revision_id": "rev_stale",
            },
        ]
    }

    response = client.post("/api/v1/organization/plans", headers=headers("stale"), json=body)

    assert response.status_code == 409
    assert (
        client.get(f"/api/v1/documents/{first['document_id']}").json()["path"] == "inbox/first.md"
    )


def test_plan_retry_recovers_commit_before_progress_record(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    document = create_document(
        client, title="Interrupted", path="inbox/interrupted.md", key="interrupted"
    )
    workspace = client.app.state.services.workspace_access
    original = workspace._execute_organization_operation
    interrupted = False

    def commit_then_interrupt(*args, **kwargs):
        nonlocal interrupted
        result = original(*args, **kwargs)
        if not interrupted:
            interrupted = True
            raise RuntimeError("response interrupted after domain commit")
        return result

    monkeypatch.setattr(workspace, "_execute_organization_operation", commit_then_interrupt)
    body = {"operations": [move_operation(document, "archive/interrupted.md")]}
    with pytest.raises(RuntimeError, match="response interrupted"):
        client.post(
            "/api/v1/organization/plans",
            headers=headers("interrupted-plan"),
            json=body,
        )

    monkeypatch.setattr(workspace, "_execute_organization_operation", original)
    recovered = client.post(
        "/api/v1/organization/plans",
        headers=headers("interrupted-plan"),
        json=body,
    )

    assert recovered.status_code == 200
    assert recovered.json()["status"] == "completed"
    assert recovered.json()["completed"] == 1
    current = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert current["path"] == "archive/interrupted.md"


def test_plan_authorizes_source_and_destination_for_scoped_agent(client: TestClient) -> None:
    document = create_document(client, title="Scoped", path="allowed/scoped.md", key="scoped")
    token = issue_agent_token(
        client,
        actor_id="agent:organizer",
        capabilities=("read", "move"),
        path_prefix="allowed",
    )
    response = client.post(
        "/api/v1/organization/plans",
        headers={"Authorization": f"Bearer {token}", "Idempotency-Key": "cross-scope"},
        json={"operations": [move_operation(document, "private/scoped.md")]},
    )

    assert response.status_code == 403
    assert (
        client.get(f"/api/v1/documents/{document['document_id']}").json()["path"]
        == "allowed/scoped.md"
    )


def test_plan_schema_rejects_unknown_operations_and_extra_fields(client: TestClient) -> None:
    unknown = client.post(
        "/api/v1/organization/plans",
        headers=headers("unknown"),
        json={"operations": [{"kind": "shell", "command": "rm -rf workspace"}]},
    )
    extra = client.post(
        "/api/v1/organization/plans",
        headers=headers("extra"),
        json={
            "operations": [
                {
                    "kind": "create_folder",
                    "path": "safe",
                    "category": None,
                    "tag_ids": [],
                    "publish": True,
                }
            ]
        },
    )

    assert unknown.status_code == 422
    assert extra.status_code == 422


def test_plan_applies_exact_tags_and_trashes_documents_with_preconditions(
    client: TestClient,
) -> None:
    first = create_document(client, title="First", path="inbox/first.md", key="tag-first")
    second = create_document(client, title="Second", path="inbox/second.md", key="tag-second")
    tag_response = client.post(
        "/api/v1/tags",
        headers=headers("tag-create"),
        json={"name": "Reviewed", "color": "#2457d6"},
    )
    assert tag_response.status_code == 201
    tag_id = tag_response.json()["tag_id"]
    tag_plan = {
        "operations": [
            {
                "kind": "update_document_metadata",
                "document_id": document["document_id"],
                "expected_metadata_version": document["metadata_version"],
                "expected_category": document["category"],
                "expected_tag_ids": [],
                "category": document["category"],
                "tag_ids": [tag_id],
            }
            for document in (first, second)
        ]
    }

    tagged = client.post("/api/v1/organization/plans", headers=headers("tag-both"), json=tag_plan)
    trashed = client.post(
        "/api/v1/organization/plans",
        headers=headers("trash-both"),
        json={
            "operations": [
                {
                    "kind": "trash_document",
                    "document_id": document["document_id"],
                    "expected_revision_id": document["current_revision_id"],
                    "expected_source_path": document["path"],
                }
                for document in (first, second)
            ]
        },
    )

    assert tagged.status_code == 200
    assert tagged.json()["completed"] == 2
    assert trashed.status_code == 200
    assert trashed.json()["completed"] == 2
    deleted_ids = {
        document["document_id"]
        for document in client.get("/api/v1/documents", params={"include_deleted": True}).json()
        if document["deleted"]
    }
    assert deleted_ids.issuperset({first["document_id"], second["document_id"]})


def test_mixed_content_organization_plan_with_pdf(client: TestClient, settings) -> None:
    from test_phase_five_pdf_research import import_pdf, text_pdf

    md_doc = create_document(client, title="Markdown Note", path="incoming/note.md", key="plan-md")
    html_resp = client.post(
        "/api/v1/documents",
        headers=headers("plan-html"),
        json={
            "title": "HTML Page",
            "path": "incoming/page.html",
            "content": "<p>hello</p>",
            "content_type": "text/html",
        },
    )
    assert html_resp.status_code == 201
    html_doc = html_resp.json()

    pdf_source = text_pdf("Mixed plan test")
    pdf_resp = import_pdf(
        client, content=pdf_source, key="plan-pdf", path="incoming/research.pdf", title="PDF Report"
    )
    assert pdf_resp.status_code == 201
    pdf_doc = pdf_resp.json()

    tag_resp = client.post(
        "/api/v1/tags", headers=headers("tag-mixed"), json={"name": "Organized", "color": "#123456"}
    )
    assert tag_resp.status_code == 201
    tag_id = tag_resp.json()["tag_id"]

    plan = {
        "operations": [
            move_operation(md_doc, "organized/note.md"),
            move_operation(html_doc, "organized/page.html"),
            move_operation(pdf_doc, "organized/research.pdf"),
            {
                "kind": "update_document_metadata",
                "document_id": pdf_doc["document_id"],
                "expected_metadata_version": pdf_doc["metadata_version"],
                "expected_category": None,
                "expected_tag_ids": [],
                "category": "Reports",
                "tag_ids": [tag_id],
            },
        ]
    }
    applied = client.post("/api/v1/organization/plans", headers=headers("mixed-plan"), json=plan)
    assert applied.status_code == 200, applied.text
    assert applied.json()["status"] == "completed"
    assert applied.json()["completed"] == 4

    assert (
        client.get(f"/api/v1/documents/{md_doc['document_id']}").json()["path"]
        == "organized/note.md"
    )
    assert (
        client.get(f"/api/v1/documents/{html_doc['document_id']}").json()["path"]
        == "organized/page.html"
    )
    pdf_current = client.get(f"/api/v1/documents/{pdf_doc['document_id']}").json()
    assert pdf_current["path"] == "organized/research.pdf"
    assert pdf_current["category"] == "Reports"
    assert [t["tag_id"] for t in pdf_current["tags"]] == [tag_id]
    assert (settings.workspace_root / "organized/research.pdf").read_bytes() == pdf_source

    trash_plan = {
        "operations": [
            {
                "kind": "trash_document",
                "document_id": doc["document_id"],
                "expected_revision_id": client.get(
                    f"/api/v1/documents/{doc['document_id']}"
                ).json()["current_revision_id"],
                "expected_source_path": expected_path,
            }
            for doc, expected_path in [
                (md_doc, "organized/note.md"),
                (html_doc, "organized/page.html"),
                (pdf_doc, "organized/research.pdf"),
            ]
        ]
    }
    trashed = client.post(
        "/api/v1/organization/plans", headers=headers("trash-all"), json=trash_plan
    )
    assert trashed.status_code == 200, trashed.text
    assert trashed.json()["completed"] == 3

    assert not (settings.workspace_root / "organized/research.pdf").exists()
    assert (settings.workspace_root / ".sangam-trash" / f"{pdf_doc['document_id']}.pdf").exists()
