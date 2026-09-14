from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from sangam.errors import InvalidPathError, ValidationError
from sangam.security import normalize_scope_prefix
from sangam.workspace import DiskWorkspaceFilesystem


def test_atomic_write_scan_and_delete(tmp_path: Path) -> None:
    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")

    first_hash = workspace.write_atomic("projects/note.md", "first")
    second_hash = workspace.write_atomic("projects/note.md", "second")

    assert first_hash == hashlib.sha256(b"first").hexdigest()
    assert second_hash == hashlib.sha256(b"second").hexdigest()
    assert workspace.read_document("projects/note.md") == "second"
    assert workspace.scan_markdown() == {"projects/note.md": second_hash}

    workspace.delete_document("projects/note.md")
    assert not workspace.is_document_file("projects/note.md")


@pytest.mark.parametrize(
    "bad_path",
    [
        "doc\x00.md",
        "doc\n.md",
        "doc\r.md",
        "doc\x1f.md",
        "doc\x7f.md",
        ".sangam-trash/stolen.md",
        ".git/HEAD.md",
        "folder/.sangam-trash/stolen.md",
    ],
)
def test_workspace_filesystem_rejects_dangerous_paths(tmp_path: Path, bad_path: str) -> None:
    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    with pytest.raises(InvalidPathError):
        workspace.normalize_document_path(bad_path)


@pytest.mark.parametrize(
    "bad_scope",
    [
        "folder\x00",
        "folder\n",
        "folder\r",
        "folder\x1f",
        "folder\x7f",
        ".sangam-trash",
        ".git",
        "folder/.sangam-trash",
    ],
)
def test_normalize_scope_prefix_rejects_dangerous_scopes(bad_scope: str) -> None:
    with pytest.raises(ValidationError):
        normalize_scope_prefix(bad_scope)


def test_scan_ignores_sangam_temporary_files(tmp_path: Path) -> None:
    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    workspace.write_atomic("kept.md", "kept")
    temporary = workspace.root / ".ignored.md.sangam-interrupted.md"
    temporary.write_text("partial", encoding="utf-8")

    assert workspace.scan_markdown() == {
        "kept.md": hashlib.sha256(b"kept").hexdigest(),
    }


def test_write_atomic_bytes_verifies_hash_before_replace_and_cleans_temp(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    workspace.write_atomic("doc.md", "original")

    # Monkeypatch hashlib.sha256 in workspace module or mock temporary.read_bytes
    # to simulate hash mismatch during written_hash calculation.
    original_sha256 = hashlib.sha256

    def corrupt_sha256(data: bytes = b"") -> hashlib._Hash:
        digest = original_sha256(data)
        if data == b"corrupted":
            # Return mismatching digest
            return original_sha256(b"wrong")
        return digest

    # Or simulate OSError during verification before os.replace
    real_read_bytes = Path.read_bytes

    def fake_read_bytes(path_obj: Path) -> bytes:
        if ".sangam-" in path_obj.name:
            return b"corrupted"
        return real_read_bytes(path_obj)

    monkeypatch.setattr(Path, "read_bytes", fake_read_bytes)

    with pytest.raises(OSError, match="Materialized file hash does not match"):
        workspace.write_atomic_bytes("doc.md", b"new_content", overwrite=True)

    # Verify destination was NOT overwritten with corrupted content
    assert workspace.read_document("doc.md") == "original"

    # Verify temporary file was unlinked and cleaned up
    temp_files = list(workspace.root.glob("**/.doc.md.sangam-*"))
    assert temp_files == []


def test_trash_and_restore_clean_temp_on_hash_mismatch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    content = "trashed document content"
    content_bytes = content.encode("utf-8")
    content_hash = hashlib.sha256(content_bytes).hexdigest()
    size_bytes = len(content_bytes)
    doc_id = "doc-1234"

    workspace.write_atomic("trashme.md", content)

    # Intercept Path.read_bytes for temporary trash files to simulate mismatch
    real_read_bytes = Path.read_bytes

    def fake_read_bytes(path_obj: Path) -> bytes:
        if ".sangam-trash-" in path_obj.name:
            return b"corrupted"
        return real_read_bytes(path_obj)

    monkeypatch.setattr(Path, "read_bytes", fake_read_bytes)

    with pytest.raises(OSError, match="Retained trash file hash does not match"):
        workspace.trash_document(doc_id, "trashme.md", content_hash, size_bytes)

    # Verify source file is untouched on disk
    assert workspace.read_document("trashme.md") == content
    # Verify no trash target was created and no orphaned temp files remain
    assert not workspace.has_trashed_document(doc_id)
    temp_files = list(workspace._trash_root.glob(".*.sangam-trash-*"))
    assert temp_files == []
