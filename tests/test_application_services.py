from __future__ import annotations

import pytest
from conftest import headers
from fastapi.testclient import TestClient

from sangam.application import ApplicationServices
from sangam.service import DocumentService


def test_composition_root_exposes_explicit_application_services(client: TestClient) -> None:
    services = client.app.state.services

    assert isinstance(services, ApplicationServices)
    assert isinstance(services.documents, DocumentService)
    assert services.reconciliation.documents is services.documents
    assert services.backups.database is services.documents.database
    assert services.organization.database is services.documents.database
    assert not hasattr(services.documents, "backups")
    assert not hasattr(services.documents, "reconciliation")


@pytest.mark.parametrize("resolution", ["accept-disk", "recognize-move"])
def test_reconciliation_retry_after_resolution_interruption_is_idempotent(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch, resolution: str
) -> None:
    created = client.post(
        "/api/v1/documents",
        json={"title": "Interrupted reconciliation", "content": "database", "path": "old.md"},
        headers=headers(f"reconciliation-interruption-{resolution}"),
    ).json()
    if resolution == "accept-disk":
        (settings.workspace_root / "old.md").write_text("disk", encoding="utf-8")
    else:
        (settings.workspace_root / "old.md").rename(settings.workspace_root / "new.md")
    conflict = client.post("/api/v1/reconciliation/scan").json()["conflicts"][0]

    reconciliation = client.app.state.services.reconciliation
    original_resolve = reconciliation._resolve_conflict
    attempts = 0

    def fail_once(conflict_id: str) -> None:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("simulated interruption before conflict resolution")
        original_resolve(conflict_id)

    monkeypatch.setattr(reconciliation, "_resolve_conflict", fail_once)
    endpoint = f"/api/v1/reconciliation/{conflict['conflict_id']}/{resolution}"
    with pytest.raises(RuntimeError, match="simulated interruption"):
        client.post(endpoint)

    retried = client.post(endpoint)
    assert retried.status_code == 200
    assert retried.json()["document_id"] == created["document_id"]
    assert client.get("/api/v1/reconciliation").json()["conflicts"] == []
    history = client.get(f"/api/v1/documents/{created['document_id']}/history").json()
    assert len(history) == 2
