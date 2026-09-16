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

    # Simulate hash failure after replace
    original_read_bytes = Path.read_bytes

    def mocked_read_bytes(self: Path) -> bytes:
        if self == destination_path:
            return b"corrupted content"
        return original_read_bytes(self)

    monkeypatch.setattr(Path, "read_bytes", mocked_read_bytes)

    with pytest.raises(OSError, match="Materialized file hash does not match"):
        workspace.write_atomic("corrupted.md", "expected content")

    # Destination should be unlinked on failure
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


def test_write_atomic_bytes_cleanup_on_write_exception(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = DiskWorkspaceFilesystem(tmp_path / "workspace")

    def mocked_fdopen(*args, **kwargs):
        raise OSError("Disk write failed during staging")

    monkeypatch.setattr("os.fdopen", mocked_fdopen)

    with pytest.raises(OSError, match="Disk write failed during staging"):
        workspace.write_atomic("failed.md", "some text")

    # Confirm workspace is completely free of orphaned temporary staging files
    temp_files = [f for f in workspace.root.rglob("*") if ".sangam-" in f.name]
    assert temp_files == []


def test_concurrent_agent_edits_version_precondition_conflict(
    tmp_path: Path,
) -> None:
    import concurrent.futures

    from sangam.api import create_app
    from sangam.config import Settings
    from sangam.errors import ConflictError

    settings = Settings(
        database_path=tmp_path / "db.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
    )
    app = create_app(settings)
    service = app.state.services.documents

    # Register agent actors in DB directly
    db = service.database
    now = "2025-01-01T00:00:00Z"
    with db.transaction() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO actors("
            "actor_id, display_name, actor_type, identity_kind, created_at"
            ") VALUES ('agent:one', 'Agent One', 'client', 'agent', ?)",
            (now,),
        )
        conn.execute(
            "INSERT OR IGNORE INTO actors("
            "actor_id, display_name, actor_type, identity_kind, created_at"
            ") VALUES ('agent:two', 'Agent Two', 'client', 'agent', ?)",
            (now,),
        )

    doc = service.create_document(
        title="Shared Document",
        content="# Initial Content\n",
        path="shared.md",
        actor_id="agent:one",
        idempotency_key="create-shared-doc",
    )
    initial_revision_id = doc.current_revision_id

    # Concurrent updates from both agents starting with the same initial_revision_id
    def update_agent1():
        return service.update_document(
            document_id=doc.document_id,
            expected_revision_id=initial_revision_id,
            content="# Content by Agent 1\n",
            title="Shared Document",
            summary="Updated by Agent 1",
            actor_id="agent:one",
            idempotency_key="update-agent-1",
        )

    def update_agent2():
        return service.update_document(
            document_id=doc.document_id,
            expected_revision_id=initial_revision_id,
            content="# Content by Agent 2\n",
            title="Shared Document",
            summary="Updated by Agent 2",
            actor_id="agent:two",
            idempotency_key="update-agent-2",
        )

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(update_agent1)
        f2 = executor.submit(update_agent2)

        results = []
        errors = []
        for f in (f1, f2):
            try:
                results.append(f.result())
            except Exception as exc:
                errors.append(exc)

    # Exactly one agent must succeed and one must fail with ConflictError
    assert len(results) == 1
    assert len(errors) == 1
    assert isinstance(errors[0], ConflictError)
    assert "changed since it was read" in str(errors[0])
