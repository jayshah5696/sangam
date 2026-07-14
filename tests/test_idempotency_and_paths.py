from __future__ import annotations

from pathlib import Path

import pytest
from conftest import headers
from fastapi.testclient import TestClient


def test_create_retry_returns_same_document_and_revision(client: TestClient) -> None:
    body = {"title": "Once", "content": "Only one revision"}
    first = client.post("/api/v1/documents", json=body, headers=headers("same-key"))
    second = client.post("/api/v1/documents", json=body, headers=headers("same-key"))
    assert first.status_code == second.status_code == 201
    assert second.json()["document_id"] == first.json()["document_id"]
    assert second.json()["current_revision_id"] == first.json()["current_revision_id"]
    history = client.get(f"/api/v1/documents/{first.json()['document_id']}/history").json()
    assert len(history) == 1


def test_idempotency_key_reuse_with_different_payload_is_rejected(client: TestClient) -> None:
    client.post(
        "/api/v1/documents",
        json={"title": "First", "content": "one"},
        headers=headers("reused-key"),
    )
    response = client.post(
        "/api/v1/documents",
        json={"title": "Second", "content": "two"},
        headers=headers("reused-key"),
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "idempotency_conflict"


@pytest.mark.parametrize(
    "invalid_path",
    [
        "../escape.md",
        "/absolute.md",
        "projects/../../escape.md",
        "projects/./note.md",
        "projects//note.md",
        "projects\\note.md",
        "projects/note.txt",
        "",
    ],
)
def test_invalid_paths_never_escape_workspace(client: TestClient, invalid_path: str) -> None:
    response = client.post(
        "/api/v1/documents",
        json={"title": "Bad path", "content": "no", "path": invalid_path},
        headers=headers(f"bad:{invalid_path}"),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_path"


def test_symlink_escape_is_rejected(client: TestClient, settings, tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    settings.workspace_root.mkdir(parents=True, exist_ok=True)
    (settings.workspace_root / "linked").symlink_to(outside, target_is_directory=True)
    response = client.post(
        "/api/v1/documents",
        json={"title": "Symlink", "content": "no", "path": "linked/escape.md"},
        headers=headers("symlink-escape"),
    )
    assert response.status_code == 422
    assert not (outside / "escape.md").exists()


def test_duplicate_materialized_path_is_rejected(client: TestClient) -> None:
    first = client.post(
        "/api/v1/documents",
        json={"title": "First", "content": "one", "path": "same.md"},
        headers=headers("path-first"),
    )
    second = client.post(
        "/api/v1/documents",
        json={"title": "Second", "content": "two", "path": "same.md"},
        headers=headers("path-second"),
    )
    assert first.status_code == 201
    assert second.status_code == 422
