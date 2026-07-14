from __future__ import annotations

from pathlib import Path

import pytest
from conftest import headers
from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.service import DocumentService


@pytest.mark.parametrize("write_then_fail", [False, True])
def test_committed_revision_recovers_after_interrupted_atomic_write(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch, write_then_fail: bool
) -> None:
    service: DocumentService = client.app.state.service
    original_write = service._write_atomic

    def fail_write(destination: Path, content: str) -> str:
        if write_then_fail:
            original_write(destination, content)
        raise OSError("injected failure after commit")

    monkeypatch.setattr(service, "_write_atomic", fail_write)
    body = {
        "title": "Recoverable",
        "content": "committed",
        "path": "recovery/test.md",
    }
    retry_headers = headers(f"failure-{write_then_fail}")
    response = client.post(
        "/api/v1/documents",
        json=body,
        headers=retry_headers,
    )
    assert response.status_code == 503
    details = response.json()["error"]["details"]
    document_id = details["document_id"]
    pending = service.get_document(document_id)
    assert pending.materialization_state == "pending"
    assert len(service.history(document_id)) == 1

    monkeypatch.setattr(service, "_write_atomic", original_write)
    retried = client.post("/api/v1/documents", json=body, headers=retry_headers)
    assert retried.status_code == 201
    recovered = service.get_document(document_id)
    assert recovered.materialization_state == "clean"
    assert retried.json()["document_id"] == document_id
    assert retried.json()["current_revision_id"] == pending.current_revision_id
    assert len(service.history(document_id)) == 1
    assert (settings.workspace_root / "recovery" / "test.md").read_text() == "committed"


def test_failure_before_database_commit_rolls_back_everything(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    service: DocumentService = client.app.state.service

    def fail_before_commit(*_args, **_kwargs) -> None:
        raise RuntimeError("injected before commit")

    monkeypatch.setattr(service, "_record_idempotency", fail_before_commit)
    with pytest.raises(RuntimeError, match="injected before commit"):
        service.create_document(
            title="Never committed",
            content="not durable",
            path="rollback.md",
            actor_id="human:jay",
            idempotency_key="rollback",
        )
    assert service.list_documents(include_deleted=True) == []
    assert not (settings.workspace_root / "rollback.md").exists()


def test_app_startup_completes_pending_materialization(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    service: DocumentService = client.app.state.service

    def fail_write(_destination: Path, _content: str) -> str:
        raise OSError("injected")

    monkeypatch.setattr(service, "_write_atomic", fail_write)
    failed = client.post(
        "/api/v1/documents",
        json={"title": "Startup", "content": "recover on startup", "path": "startup.md"},
        headers=headers("startup-failure"),
    )
    document_id = failed.json()["error"]["details"]["document_id"]

    with TestClient(create_app(settings)) as restarted:
        recovered = restarted.get(f"/api/v1/documents/{document_id}").json()
        assert recovered["materialization_state"] == "clean"
        assert (settings.workspace_root / "startup.md").read_text() == "recover on startup"


def test_missing_file_is_rematerialized_from_database_head(client: TestClient, settings) -> None:
    created = client.post(
        "/api/v1/documents",
        json={"title": "Missing", "content": "database wins", "path": "missing.md"},
        headers=headers("missing-create"),
    ).json()
    file_path = settings.workspace_root / "missing.md"
    file_path.unlink()
    report = client.post("/api/v1/reconciliation/scan").json()
    assert report["repaired_document_ids"] == [created["document_id"]]
    assert file_path.read_text() == "database wins"


def test_external_edit_becomes_conflict_then_attributed_revision(
    client: TestClient, settings
) -> None:
    created = client.post(
        "/api/v1/documents",
        json={"title": "External", "content": "database head", "path": "external.md"},
        headers=headers("external-create"),
    ).json()
    file_path = settings.workspace_root / "external.md"
    file_path.write_text("edited outside Sangam", encoding="utf-8")

    report = client.post("/api/v1/reconciliation/scan").json()
    assert report["repaired_document_ids"] == []
    assert len(report["conflicts"]) == 1
    conflict = report["conflicts"][0]
    assert conflict["conflict_type"] == "unexpected_hash"
    current = client.get(f"/api/v1/documents/{created['document_id']}").json()
    assert current["content"] == "database head"
    assert current["materialization_state"] == "conflict"
    assert file_path.read_text() == "edited outside Sangam"

    accepted = client.post(f"/api/v1/reconciliation/{conflict['conflict_id']}/accept-disk").json()
    assert accepted["content"] == "edited outside Sangam"
    assert accepted["materialization_state"] == "clean"
    history = client.get(f"/api/v1/documents/{created['document_id']}/history").json()
    assert history[0]["operation"] == "reconcile"
    assert history[0]["actor_id"] == "system:reconcile"


def test_possible_move_is_reported_without_guessing(client: TestClient, settings) -> None:
    created = client.post(
        "/api/v1/documents",
        json={"title": "Moved outside", "content": "same bytes", "path": "old.md"},
        headers=headers("possible-move-create"),
    ).json()
    old_path = settings.workspace_root / "old.md"
    candidate = settings.workspace_root / "new.md"
    old_path.rename(candidate)

    report = client.post("/api/v1/reconciliation/scan").json()
    conflict = report["conflicts"][0]
    assert conflict["conflict_type"] == "possible_move"
    assert conflict["document_id"] == created["document_id"]
    assert conflict["path"] == "old.md"
    assert conflict["candidate_path"] == "new.md"
    assert not old_path.exists()
    assert candidate.read_text() == "same bytes"


def test_unknown_file_requires_explicit_reindex(client: TestClient, settings) -> None:
    unknown = settings.workspace_root / "imports" / "outside.md"
    unknown.parent.mkdir(parents=True)
    unknown.write_text("# Imported explicitly\n", encoding="utf-8")
    report = client.post("/api/v1/reconciliation/scan").json()
    assert report["conflicts"][0]["conflict_type"] == "unknown_file"
    assert client.get("/api/v1/documents").json() == []

    imported = client.post(
        "/api/v1/reconciliation/reindex", json={"path": "imports/outside.md"}
    ).json()
    assert imported["path"] == "imports/outside.md"
    assert imported["content"] == "# Imported explicitly\n"
    assert imported["created_by"] == "system:reconcile"
    assert client.get("/api/v1/reconciliation").json()["conflicts"] == []
