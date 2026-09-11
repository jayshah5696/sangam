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


def test_write_atomic_cleanup_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    path = "docs/test.md"

    # Test failure before replace (during os.fsync or write)
    def mock_fsync_fail(fd: int) -> None:
        raise OSError("Disk write error")

    monkeypatch.setattr("os.fsync", mock_fsync_fail)
    with pytest.raises(OSError, match="Disk write error"):
        workspace.write_atomic(path, "failed content")

    # Verify no temporary files or orphaned destination file exist
    folder = workspace.root / "docs"
    assert folder.exists()
    assert list(folder.iterdir()) == []


def test_concurrent_reads_and_writes(tmp_path: Path) -> None:
    import concurrent.futures

    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    doc_path = "concurrent.md"
    workspace.write_atomic(doc_path, "initial content")

    stop = False
    read_errors: list[str] = []

    def writer() -> None:
        idx = 0
        while not stop:
            content = f"revision-{idx}-" + ("x" * 1000)
            workspace.write_atomic(doc_path, content)
            idx += 1

    def reader() -> None:
        while not stop:
            try:
                content = workspace.read_document(doc_path)
                valid_prefix = content.startswith("initial content") or content.startswith(
                    "revision-"
                )
                if not valid_prefix:
                    read_errors.append(f"Corrupt read content: {content[:30]}")
                if len(content) == 0:
                    read_errors.append("Zero-byte read detected!")
            except Exception as e:
                read_errors.append(f"Exception during read: {e}")

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
        writer_future = executor.submit(writer)
        reader_futures = [executor.submit(reader) for _ in range(4)]

        import time

        time.sleep(0.5)
        stop = True

        writer_future.result()
        for rf in reader_futures:
            rf.result()

    assert not read_errors, f"Concurrency errors occurred: {read_errors}"
