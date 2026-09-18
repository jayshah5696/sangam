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


def test_write_atomic_bytes_cleanup_on_hash_mismatch_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    destination_path = workspace.root / "corrupted.md"

    # Simulate hash failure on the temporary staging file before replace
    original_read_bytes = Path.read_bytes

    def mocked_read_bytes(self: Path) -> bytes:
        if ".sangam-" in self.name:
            return b"corrupted content"
        return original_read_bytes(self)

    monkeypatch.setattr(Path, "read_bytes", mocked_read_bytes)

    with pytest.raises(OSError, match="Materialized file hash does not match"):
        workspace.write_atomic("corrupted.md", "expected content")

    # Destination should never be created/replaced on staging failure
    assert not destination_path.exists()

    # No leftover temporary staging files
    temp_files = [f for f in workspace.root.glob("*") if ".sangam-" in f.name]
    assert temp_files == []


def test_concurrent_workspace_atomic_writes_and_reads(tmp_path: Path) -> None:
    import threading

    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    doc_path = "concurrent.md"
    workspace.write_atomic(doc_path, "initial content")

    stop_event = threading.Event()
    read_results: list[str] = []
    read_errors: list[str] = []
    write_lock = threading.Lock()

    def reader():
        while not stop_event.is_set():
            try:
                content = workspace.read_document(doc_path)
                read_results.append(content)
            except Exception as exc:
                read_errors.append(str(exc))

    def writer(thread_id: int):
        for i in range(20):
            with write_lock:
                workspace.write_atomic(doc_path, f"content from thread {thread_id} iteration {i}")

    reader_threads = [threading.Thread(target=reader) for _ in range(2)]
    writer_threads = [threading.Thread(target=writer, args=(t,)) for t in range(3)]

    for r in reader_threads:
        r.start()
    for t in writer_threads:
        t.start()

    for t in writer_threads:
        t.join()

    stop_event.set()
    for r in reader_threads:
        r.join()

    assert not read_errors
    assert len(read_results) > 0
    # Confirm every read was non-empty and zero-byte reads never occurred
    for res in read_results:
        assert len(res) > 0
        assert "content" in res

    # Confirm workspace clean of temporary staging files
    temp_files = [f for f in workspace.root.rglob("*") if ".sangam-" in f.name]
    assert temp_files == []
