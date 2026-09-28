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
    "bad_doc_id",
    [
        "../stolen",
        "sub/../../stolen",
        "doc\x00_id",
        "doc\n_id",
        "doc\r_id",
        "doc\x1f_id",
        "doc\x7f_id",
        "sub/folder",
        "sub\\folder",
        "..",
    ],
)
def test_trash_path_rejects_dangerous_document_ids(tmp_path: Path, bad_doc_id: str) -> None:
    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    content = "test content"
    content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
    size_bytes = len(content.encode("utf-8"))
    workspace.write_atomic("test.md", content)

    with pytest.raises(InvalidPathError):
        workspace.has_trashed_document(bad_doc_id)

    with pytest.raises(InvalidPathError):
        workspace.trash_document(bad_doc_id, "test.md", content_hash, size_bytes)

    with pytest.raises(InvalidPathError):
        workspace.restore_trash_document(bad_doc_id, "restored.md", content_hash, size_bytes)


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

    # Simulate hash failure on temporary staging file before replace
    original_read_bytes = Path.read_bytes

    def mocked_read_bytes(self: Path) -> bytes:
        if ".sangam-" in self.name:
            return b"corrupted content"
        return original_read_bytes(self)

    monkeypatch.setattr(Path, "read_bytes", mocked_read_bytes)

    with pytest.raises(OSError, match="Materialized file hash does not match"):
        workspace.write_atomic("corrupted.md", "expected content")

    # Destination should not exist on failure (replace was never performed)
    assert not destination_path.exists()

    # No leftover temporary staging files
    temp_files = [f for f in workspace.root.glob("*") if ".sangam-" in f.name]
    assert temp_files == []


def test_concurrent_write_atomic_does_not_unlink_destination(tmp_path: Path) -> None:
    import threading

    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    doc_path = "race_write.md"

    errors: list[Exception] = []

    def writer(content: str):
        try:
            for _ in range(30):
                workspace.write_atomic(doc_path, content)
        except Exception as exc:
            errors.append(exc)

    t1 = threading.Thread(target=writer, args=("content A " * 100,))
    t2 = threading.Thread(target=writer, args=("content B " * 100,))

    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert not errors, f"Concurrent writes failed with errors: {errors}"
    assert workspace.is_document_file(doc_path)
    final_content = workspace.read_document(doc_path)
    assert final_content in ("content A " * 100, "content B " * 100)

    # Confirm workspace clean of temporary staging files
    temp_files = [f for f in workspace.root.rglob("*") if f.is_file() and ".sangam-" in f.name]
    assert temp_files == []


def test_concurrent_move_document_prevents_overwrite_and_prunes_staging(
    tmp_path: Path,
) -> None:
    import threading

    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")
    workspace.write_atomic("source1.md", "source 1 content")
    workspace.write_atomic("source2.md", "source 2 content")

    destination_path = "target.md"
    barrier = threading.Barrier(2)
    results: list[tuple[str, Exception | None]] = []
    lock = threading.Lock()

    def mover(src: str):
        barrier.wait()
        try:
            workspace.move_document(src, destination_path)
            with lock:
                results.append((src, None))
        except Exception as exc:
            with lock:
                results.append((src, exc))

    t1 = threading.Thread(target=mover, args=("source1.md",))
    t2 = threading.Thread(target=mover, args=("source2.md",))

    t1.start()
    t2.start()
    t1.join()
    t2.join()

    successes = [r for r in results if r[1] is None]
    failures = [r for r in results if r[1] is not None]

    assert len(successes) == 1
    assert len(failures) == 1
    assert isinstance(failures[0][1], InvalidPathError)

    winning_source = successes[0][0]
    losing_source = failures[0][0]

    # Target has content of winner, losing source file was NOT overwritten or destroyed
    expected_content = "source 1 content" if winning_source == "source1.md" else "source 2 content"
    assert workspace.read_document(destination_path) == expected_content
    assert workspace.is_document_file(losing_source)

    # Confirm workspace clean of temporary staging files
    temp_files = [f for f in workspace.root.rglob("*") if f.is_file() and ".sangam-" in f.name]
    assert temp_files == []


def test_concurrent_restore_trash_document_prevents_overwrite_and_prunes_staging(
    tmp_path: Path,
) -> None:
    import threading

    from sangam.errors import ConflictError

    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")

    # Create and trash two separate documents
    content1 = "trash 1 content"
    content2 = "trash 2 content"
    hash1 = hashlib.sha256(content1.encode("utf-8")).hexdigest()
    hash2 = hashlib.sha256(content2.encode("utf-8")).hexdigest()
    size1 = len(content1.encode("utf-8"))
    size2 = len(content2.encode("utf-8"))

    workspace.write_atomic("temp1.md", content1)
    workspace.write_atomic("temp2.md", content2)
    workspace.trash_document("doc1", "temp1.md", hash1, size1)
    workspace.trash_document("doc2", "temp2.md", hash2, size2)

    destination_path = "restored.md"
    barrier = threading.Barrier(2)
    results: list[tuple[str, Exception | None]] = []
    lock = threading.Lock()

    def restorer(doc_id: str, c_hash: str, size: int):
        barrier.wait()
        try:
            workspace.restore_trash_document(doc_id, destination_path, c_hash, size)
            with lock:
                results.append((doc_id, None))
        except Exception as exc:
            with lock:
                results.append((doc_id, exc))

    t1 = threading.Thread(target=restorer, args=("doc1", hash1, size1))
    t2 = threading.Thread(target=restorer, args=("doc2", hash2, size2))

    t1.start()
    t2.start()
    t1.join()
    t2.join()

    successes = [r for r in results if r[1] is None]
    failures = [r for r in results if r[1] is not None]

    assert len(successes) == 1
    assert len(failures) == 1
    assert isinstance(failures[0][1], ConflictError)

    # Confirm workspace clean of temporary staging files
    temp_files = [f for f in workspace.root.rglob("*") if f.is_file() and ".sangam-" in f.name]
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
