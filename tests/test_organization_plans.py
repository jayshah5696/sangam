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
