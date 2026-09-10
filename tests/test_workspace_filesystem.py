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


def test_concurrent_writes_and_reads_workspace_filesystem(tmp_path: Path) -> None:
    import threading

    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    path = "concurrent.md"
    workspace.write_atomic(path, "initial content")

    errors: list[Exception] = []
    read_contents: list[str] = []
    stop_flag = threading.Event()

    def writer(thread_id: int):
        for i in range(25):
            if stop_flag.is_set():
                break
            content = f"writer-{thread_id} iteration-{i} " + ("data" * 500)
            try:
                workspace.write_atomic(path, content)
            except Exception as exc:
                errors.append(exc)

    def reader():
        while not stop_flag.is_set():
            try:
                content = workspace.read_document(path)
                read_contents.append(content)
            except Exception as exc:
                errors.append(exc)

    writers = [threading.Thread(target=writer, args=(i,)) for i in range(4)]
    readers = [threading.Thread(target=reader) for _ in range(3)]

    for r in readers:
        r.start()
    for w in writers:
        w.start()

    for w in writers:
        w.join()

    stop_flag.set()
    for r in readers:
        r.join()

    assert not errors
    assert len(read_contents) > 0
    for text in read_contents:
        assert len(text) > 0
        assert text == "initial content" or "writer-" in text

    # Ensure no leftover temporary files in workspace
    leftover_temps = list(workspace.root.glob(".*.sangam-*"))
    assert leftover_temps == []
