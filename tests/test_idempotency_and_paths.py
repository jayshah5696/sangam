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
        "note\x00.md",
        "note\n.md",
        "note\r.md",
        "note\x1f.md",
        "note\x7f.md",
        ".sangam-trash/exploit.md",
        ".git/config.md",
        "sub/.sangam-trash/exploit.md",
        " .. /escape.md",
        "projects/ .. /escape.md",
        "projects/ .hidden/exploit.md",
        "aux.md",
        "CON/note.md",
        "nul.html",
        "com1.pdf",
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


@pytest.mark.parametrize(
    "invalid_scope",
    [
        " .. ",
        "projects/ .. /escape",
        "projects/ .hidden",
        " .. /secret",
        "aux",
        "CON/docs",
    ],
)
def test_whitespace_padded_traversal_in_token_scope_is_rejected(invalid_scope: str) -> None:
    from sangam.errors import ValidationError
    from sangam.security import normalize_scope_prefix

    with pytest.raises(ValidationError):
        normalize_scope_prefix(invalid_scope)


@pytest.mark.parametrize(
    "bad_title",
    [
        "Doc\x00Title",
        "Doc\x07Title",
        "Doc\rTitle",
        "Doc\nTitle",
        "Doc\x1fTitle",
        "Doc\x7fTitle",
    ],
)
def test_document_title_sanitization(client: TestClient, bad_title: str) -> None:
    response = client.post(
        "/api/v1/documents",
        json={"title": bad_title, "content": "test content"},
        headers=headers("bad-title-key"),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize(
    "bad_summary",
    [
        "Summary\x00Text",
        "Summary\x07Text",
        "Summary\rText",
        "Summary\nText",
    ],
)
def test_revision_summary_sanitization(client: TestClient, bad_summary: str) -> None:
    created = client.post(
        "/api/v1/documents",
        json={"title": "Valid Title", "content": "v1"},
        headers=headers("create-valid-doc"),
    )
    assert created.status_code == 201
    doc_id = created.json()["document_id"]
    rev_id = created.json()["current_revision_id"]

    response = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={"expected_revision_id": rev_id, "content": "v2", "summary": bad_summary},
        headers=headers("patch-bad-summary"),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
