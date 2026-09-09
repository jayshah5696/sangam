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
