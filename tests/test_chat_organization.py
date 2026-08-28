"""Tests for chat organization capabilities: inspect and apply plan."""

from __future__ import annotations

import pytest
from conftest import headers
from fastapi.testclient import TestClient

from sangam.security import Principal


def test_inspect_workspace_organization_capability_is_registered(client: TestClient) -> None:
    """The inspect capability is discoverable in the registry."""
    registry = client.app.state.services.chat.toolset.registry
    capability = registry.get("inspect_workspace_organization")
    assert capability.effect_class.value == "read"
    assert capability.approval_policy.value == "none"
    assert capability.requires_global_scope is True


def test_apply_organization_plan_capability_is_registered(client: TestClient) -> None:
    """The apply plan capability uses exact_effect approval."""
    registry = client.app.state.services.chat.toolset.registry
    capability = registry.get("apply_workspace_organization_plan")
    assert capability.effect_class.value == "write"
    assert capability.approval_policy.value == "exact_effect"
    assert capability.requires_global_scope is True
    assert capability.renderer == "organization_plan"


def test_apply_organization_plan_validates_operations() -> None:
    """The input schema validates structure and rejects duplicates."""
    from pydantic import ValidationError

    from sangam.chat_capabilities import ApplyOrganizationPlanInput

    # Valid plan with one move
    valid = ApplyOrganizationPlanInput.model_validate(
        {
            "operations": [
                {
                    "kind": "move_document",
                    "document_id": "doc_abc",
                    "expected_revision_id": "rev_123",
                    "expected_source_path": "old/path.md",
                    "destination_path": "new/path.md",
                }
            ],
            "summary": "Move one document",
        }
    )
    assert len(valid.operations) == 1
    assert valid.operations[0].kind == "move_document"

    # Reject duplicate document moves
    with pytest.raises(ValidationError, match="Duplicate move"):
        ApplyOrganizationPlanInput.model_validate(
            {
                "operations": [
                    {
                        "kind": "move_document",
                        "document_id": "doc_abc",
                        "expected_revision_id": "rev_1",
                        "expected_source_path": "a.md",
                        "destination_path": "b.md",
                    },
                    {
                        "kind": "move_document",
                        "document_id": "doc_abc",
                        "expected_revision_id": "rev_2",
                        "expected_source_path": "a.md",
                        "destination_path": "c.md",
                    },
                ],
                "summary": "Duplicate",
            }
        )

    # Reject empty operations
    with pytest.raises(ValidationError):
        ApplyOrganizationPlanInput.model_validate(
            {
                "operations": [],
                "summary": "Empty plan",
            }
        )


def test_apply_organization_plan_rejects_unknown_operation_kinds() -> None:
    """Unknown operation kinds are rejected at validation."""
    from pydantic import ValidationError

    from sangam.chat_capabilities import ApplyOrganizationPlanInput

    with pytest.raises(ValidationError):
        ApplyOrganizationPlanInput.model_validate(
            {
                "operations": [{"kind": "delete_everything", "target": "all"}],
                "summary": "Bad plan",
            }
        )


def test_mixed_operation_plan_validates_all_types() -> None:
    """A plan with all supported operation types validates cleanly."""
    from sangam.chat_capabilities import ApplyOrganizationPlanInput

    plan = ApplyOrganizationPlanInput.model_validate(
        {
            "operations": [
                {
                    "kind": "create_folder",
                    "path": "projects/launch",
                    "category": "active",
                    "tag_ids": [],
                },
                {
                    "kind": "move_document",
                    "document_id": "doc_1",
                    "expected_revision_id": "rev_1",
                    "expected_source_path": "drafts/plan.md",
                    "destination_path": "projects/launch/plan.md",
                },
                {
                    "kind": "move_folder",
                    "folder_id": "folder_old",
                    "expected_source_path": "archive/2024",
                    "destination_path": "archive/legacy/2024",
                },
                {
                    "kind": "update_document_metadata",
                    "document_id": "doc_2",
                    "expected_metadata_version": 3,
                    "category": "research",
                    "add_tag_ids": ["tag_priority"],
                    "remove_tag_ids": ["tag_draft"],
                },
                {
                    "kind": "update_folder_metadata",
                    "folder_id": "folder_proj",
                    "expected_metadata_version": 1,
                    "category": "active",
                    "tag_ids": ["tag_priority"],
                },
            ],
            "summary": "Complete workspace reorganization",
        }
    )
    assert len(plan.operations) == 5
    kinds = [op.kind for op in plan.operations]
    assert kinds == [
        "create_folder",
        "move_document",
        "move_folder",
        "update_document_metadata",
        "update_folder_metadata",
    ]


def test_effect_service_executes_organization_plan(client: TestClient, settings) -> None:
    """The effect service executes each plan operation through the workspace service."""
    # Create a document and folder to work with
    doc_response = client.post(
        "/api/v1/documents",
        json={
            "title": "Plan move target",
            "content": "# Will be moved by plan",
            "path": "plan-target.md",
        },
        headers=headers("plan-doc"),
    )
    assert doc_response.status_code == 201
    doc = doc_response.json()

    folder_response = client.post(
        "/api/v1/folders",
        json={"path": "plan-destination"},
        headers=headers("plan-folder"),
    )
    assert folder_response.status_code == 201

    # Get current state
    doc_detail = client.get(f"/api/v1/documents/{doc['document_id']}").json()

    # Execute a plan through the effect service
    effects = client.app.state.services.chat.effects
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="plan-test"
    )

    operations = [
        {
            "kind": "create_folder",
            "path": "plan-destination/sub",
            "category": None,
            "tag_ids": [],
        },
        {
            "kind": "move_document",
            "document_id": doc["document_id"],
            "expected_revision_id": doc_detail["current_revision_id"],
            "expected_source_path": doc_detail["path"],
            "destination_path": "plan-destination/plan-target.md",
        },
    ]

    results = effects._execute_organization_plan(
        principal, {"operations": operations, "summary": "test plan"}, "test-plan-key"
    )
    assert len(results) == 2
    assert results[0]["status"] == "completed"
    assert results[0]["kind"] == "create_folder"
    assert results[1]["status"] == "completed"
    assert results[1]["kind"] == "move_document"
    assert results[1]["path"] == "plan-destination/plan-target.md"

    # Verify the document actually moved
    moved = client.get(f"/api/v1/documents/{doc['document_id']}").json()
    assert moved["path"] == "plan-destination/plan-target.md"


def test_effect_service_reports_conflicts_without_stopping(client: TestClient, settings) -> None:
    """Conflicted operations report status without aborting subsequent operations."""
    doc_response = client.post(
        "/api/v1/documents",
        json={
            "title": "Conflict target",
            "content": "# Will conflict",
            "path": "conflict-target.md",
        },
        headers=headers("conflict-doc"),
    )
    assert doc_response.status_code == 201
    doc = doc_response.json()

    folder_response = client.post(
        "/api/v1/folders",
        json={"path": "conflict-dest"},
        headers=headers("conflict-folder"),
    )
    assert folder_response.status_code == 201

    effects = client.app.state.services.chat.effects
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="conflict-test"
    )

    operations = [
        {
            # This will fail: wrong revision
            "kind": "move_document",
            "document_id": doc["document_id"],
            "expected_revision_id": "stale_revision_id",
            "expected_source_path": "conflict-target.md",
            "destination_path": "conflict-dest/conflict-target.md",
        },
        {
            # This should still succeed
            "kind": "create_folder",
            "path": "conflict-dest/new-sub",
            "category": None,
            "tag_ids": [],
        },
    ]

    results = effects._execute_organization_plan(
        principal, {"operations": operations, "summary": "partial plan"}, "conflict-key"
    )
    assert len(results) == 2
    assert results[0]["status"] == "conflicted"
    assert results[1]["status"] == "completed"
