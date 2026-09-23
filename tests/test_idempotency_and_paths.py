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
    ],
)
def test_whitespace_padded_traversal_in_token_scope_is_rejected(invalid_scope: str) -> None:
    from sangam.errors import ValidationError
    from sangam.security import normalize_scope_prefix

    with pytest.raises(ValidationError):
        normalize_scope_prefix(invalid_scope)


@pytest.mark.parametrize("bad_char", ["\x00", "\n", "\r", "\x1f", "\x7f"])
def test_document_title_rejects_null_bytes_and_control_characters(
    client: TestClient, bad_char: str
) -> None:
    response = client.post(
        "/api/v1/documents",
        json={"title": f"Bad{bad_char}Title", "content": "hello"},
        headers=headers(f"title-bad:{ord(bad_char)}"),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize("bad_char", ["\x00", "\n", "\r", "\x1f", "\x7f"])
def test_revision_summary_rejects_null_bytes_and_control_characters(
    client: TestClient, bad_char: str
) -> None:
    created = client.post(
        "/api/v1/documents",
        json={"title": "Good Title", "content": "v1"},
        headers=headers("summary-create"),
    ).json()

    response = client.patch(
        f"/api/v1/documents/{created['document_id']}",
        json={
            "expected_revision_id": created["current_revision_id"],
            "content": "v2",
            "summary": f"Bad{bad_char}Summary",
        },
        headers=headers(f"summary-update:{ord(bad_char)}"),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


@pytest.mark.parametrize("bad_char", ["\x00", "\n", "\r", "\x1f", "\x7f"])
def test_pdf_research_metadata_rejects_null_bytes_and_control_characters(
    bad_char: str,
) -> None:
    from sangam.errors import ValidationError
    from sangam.pdf_research import PdfResearchService

    with pytest.raises(ValidationError):
        PdfResearchService._normalize_annotation_fields(
            annotation_type="comment",
            selected_text=None,
            note=f"Note{bad_char}Text",
            geometry=[],
            tags=[],
            color="#ffffff",
        )

    with pytest.raises(ValidationError):
        PdfResearchService._normalize_annotation_fields(
            annotation_type="text_highlight",
            selected_text=f"Selected{bad_char}Text",
            note=None,
            geometry=[],
            tags=[],
            color="#ffffff",
        )


@pytest.mark.parametrize("bad_char", ["\x00", "\n", "\r", "\x1f", "\x7f"])
def test_chat_proposal_metadata_rejects_null_bytes_and_control_characters(
    bad_char: str,
) -> None:
    from unittest.mock import MagicMock

    from sangam.chat_proposals import ChatProposalService
    from sangam.errors import ValidationError
    from sangam.security import Principal

    proposal_service = ChatProposalService(repository=MagicMock(), workspace=MagicMock())
    principal = Principal.trusted_human(
        actor_id="human:owner", display_name="Owner", operation_id="op_1"
    )

    with pytest.raises(ValidationError):
        proposal_service.create(
            principal,
            thread_id="thread_1",
            document_id="doc_1",
            expected_revision_id="rev_1",
            content="content",
            summary=f"Bad{bad_char}Summary",
        )

    with pytest.raises(ValidationError):
        proposal_service.dismiss(
            principal,
            proposal_id="prop_1",
            reason=f"Bad{bad_char}Reason",
        )


@pytest.mark.parametrize("bad_char", ["\x00", "\n", "\r", "\x1f", "\x7f"])
def test_provider_connection_name_rejects_null_bytes_and_control_characters(
    bad_char: str,
) -> None:
    from sangam.errors import ValidationError
    from sangam.provider_connections import ProviderConnectionService

    with pytest.raises(ValidationError):
        ProviderConnectionService._validate_name(f"Bad{bad_char}Name")
