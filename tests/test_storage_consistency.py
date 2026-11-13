from __future__ import annotations

import hashlib
import io
import json
import shutil
import sqlite3
import tarfile
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from contextlib import contextmanager
from pathlib import Path

import pytest
from conftest import headers
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from sangam.errors import ConflictError, ValidationError
from sangam.service import DocumentService


def _pdf_bytes() -> bytes:
    output = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.write(output)
    return output.getvalue()


def _create_text(client: TestClient, *, path: str = "race.md") -> dict:
    response = client.post(
        "/api/v1/documents",
        json={"title": "Race", "content": "base", "path": path},
        headers=headers(f"create-{path}"),
    )
    assert response.status_code == 201
    return response.json()


def _wait_for_pipeline_attempt(service: DocumentService, document_id: str, users: int = 2) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        with service.mutations._condition:
            if service.mutations._document_lock_users.get(document_id, 0) >= users:
                return
        time.sleep(0.01)
    pytest.fail("Request did not reach the coordinated document boundary")


def _start_paused_backup(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    manager = client.app.state.services.backups.manager
    original_archive = manager._archive_workspace
    snapshot_complete = threading.Event()
    release_archive = threading.Event()

    def paused_archive(destination: Path) -> None:
        snapshot_complete.set()
        assert release_archive.wait(timeout=5)
        original_archive(destination)

    monkeypatch.setattr(manager, "_archive_workspace", paused_archive)
    executor = ThreadPoolExecutor(max_workers=2)
    backup_future = executor.submit(manager.create)
    assert snapshot_complete.wait(timeout=5)
    return manager, executor, backup_future, release_archive


@pytest.mark.parametrize("source_type", ["text", "pdf"])
def test_duplicate_rechecks_source_after_concurrent_change(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, source_type: str
) -> None:
    if source_type == "text":
        created = _create_text(client, path="duplicate/source.md")
    else:
        response = client.post(
            "/api/v1/pdfs",
            params={"title": "Source", "path": "duplicate/source.pdf"},
            content=_pdf_bytes(),
            headers={**headers("duplicate-source-pdf"), "Content-Type": "application/pdf"},
        )
        assert response.status_code == 201
        created = response.json()

    service: DocumentService = client.app.state.services.documents
    original_get = service.get_document
    snapshot_read = threading.Event()
    resume = threading.Event()

    def paused_get(document_id: str, *, include_deleted: bool = False):
        document = original_get(document_id, include_deleted=include_deleted)
        if threading.current_thread().name == "duplicate-snapshot" and not snapshot_read.is_set():
            snapshot_read.set()
            assert resume.wait(timeout=10)
        return document

    monkeypatch.setattr(service, "get_document", paused_get)
    outcomes: list[object] = []

    def duplicate() -> None:
        try:
            outcomes.append(
                service.duplicate_document(
                    document_id=created["document_id"],
                    expected_revision_id=created["current_revision_id"],
                    title=None,
                    path=None,
                    actor_id=created["created_by"],
                    idempotency_key="duplicate-stale-snapshot",
                )
            )
        except Exception as error:  # noqa: BLE001 - propagate worker failures to the test
            outcomes.append(error)

    thread = threading.Thread(target=duplicate, name="duplicate-snapshot", daemon=True)
    thread.start()
    try:
        assert snapshot_read.wait(timeout=5)
        with ThreadPoolExecutor(max_workers=1) as executor:
            if source_type == "text":
                changed = executor.submit(
                    client.patch,
                    f"/api/v1/documents/{created['document_id']}",
                    json={"expected_revision_id": created["current_revision_id"], "content": "new"},
                    headers=headers("duplicate-source-update"),
                )
            else:
                changed = executor.submit(
                    client.post,
                    f"/api/v1/documents/{created['document_id']}/move",
                    json={
                        "expected_revision_id": created["current_revision_id"],
                        "path": "duplicate/moved.pdf",
                    },
                    headers=headers("duplicate-source-move"),
                )
            # A source lock may serialize the change behind the paused snapshot.
            try:
                response = changed.result(timeout=1)
                changed_first = True
            except FutureTimeoutError:
                changed_first = False
            finally:
                resume.set()
            if not changed_first:
                response = changed.result(timeout=10)
            assert response.status_code == 200, response.text
    finally:
        resume.set()
        thread.join(timeout=10)

    assert not thread.is_alive()
    assert len(outcomes) == 1
    if changed_first:
        assert isinstance(outcomes[0], ConflictError), outcomes[0]
        assert len(service.list_documents()) == 1
    else:
        assert not isinstance(outcomes[0], Exception), outcomes[0]
        assert len(service.list_documents()) == 2


def test_create_retry_does_not_hold_path_while_waiting_for_update(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = _create_text(client, path="retry.md")
    service: DocumentService = client.app.state.services.documents
    access = client.app.state.services.workspace_access
    original_store = access._store_document_write
    original_document = service.mutations.document
    update_has_document = threading.Event()
    retry_waiting = threading.Event()
    update_finished = threading.Event()
    release_update = threading.Event()
    outcomes: list[object] = []

    def pause_update(*args, **kwargs):
        update_has_document.set()
        assert release_update.wait(timeout=10)
        return original_store(*args, **kwargs)

    @contextmanager
    def observe_document(document_id: str):
        if threading.current_thread().name == "create-retry":
            retry_waiting.set()
            if not update_finished.wait(timeout=3):
                raise TimeoutError("update could not finish while create retry waited")
        with original_document(document_id):
            yield

    monkeypatch.setattr(access, "_store_document_write", pause_update)
    monkeypatch.setattr(service.mutations, "document", observe_document)

    def update() -> None:
        try:
            outcomes.append(
                client.patch(
                    f"/api/v1/documents/{created['document_id']}",
                    json={"expected_revision_id": created["current_revision_id"], "content": "new"},
                    headers=headers("retry-update"),
                )
            )
        finally:
            update_finished.set()

    def retry() -> None:
        try:
            outcomes.append(
                service.create_document(
                    title="Race",
                    content="base",
                    path="retry.md",
                    actor_id=created["created_by"],
                    idempotency_key="create-retry.md",
                )
            )
        except Exception as error:  # noqa: BLE001 - propagate worker failures to the test
            outcomes.append(error)

    update_thread = threading.Thread(target=update, daemon=True)
    retry_thread = threading.Thread(target=retry, name="create-retry", daemon=True)
    update_thread.start()
    try:
        assert update_has_document.wait(timeout=5)
        retry_thread.start()
        assert retry_waiting.wait(timeout=5)
    finally:
        release_update.set()
        update_thread.join(timeout=10)
        if retry_thread.ident is not None:
            retry_thread.join(timeout=10)

    assert not update_thread.is_alive()
    assert not retry_thread.is_alive()
    assert len(outcomes) == 2
    assert not any(isinstance(result, Exception) for result in outcomes), outcomes
    assert any(getattr(result, "status_code", None) == 200 for result in outcomes)
    assert service.get_document(created["document_id"]).content == "new"


def test_move_finishes_before_stale_update_and_backup(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = _create_text(client, path="move-race/before.md")
    service: DocumentService = client.app.state.services.documents
    manager = client.app.state.services.backups.manager
    original_write = service.workspace.write_atomic
    move_writing = threading.Event()
    release_move = threading.Event()
    backup_waiting = threading.Event()
    original_backup = manager.mutations.backup

    def paused_write(path: str, content: str) -> str:
        if path == "move-race/after.md":
            move_writing.set()
            assert release_move.wait(timeout=10)
        return original_write(path, content)

    @contextmanager
    def observed_backup():
        backup_waiting.set()
        with original_backup():
            yield

    monkeypatch.setattr(service.workspace, "write_atomic", paused_write)
    monkeypatch.setattr(manager.mutations, "backup", observed_backup)
    with ThreadPoolExecutor(max_workers=3) as executor:
        move = executor.submit(
            client.post,
            f"/api/v1/documents/{created['document_id']}/move",
            json={
                "expected_revision_id": created["current_revision_id"],
                "path": "move-race/after.md",
            },
            headers=headers("move-race"),
        )
        try:
            assert move_writing.wait(timeout=5)
            update = executor.submit(
                client.patch,
                f"/api/v1/documents/{created['document_id']}",
                json={"expected_revision_id": created["current_revision_id"], "content": "stale"},
                headers=headers("move-race-stale-update"),
            )
            _wait_for_pipeline_attempt(service, created["document_id"])
            backup = executor.submit(manager.create)
            assert backup_waiting.wait(timeout=5)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                with service.mutations._condition:
                    if service.mutations._waiting_backups:
                        break
                time.sleep(0.01)
            else:
                pytest.fail("Backup did not reach the generation barrier")
        finally:
            release_move.set()
        assert move.result(timeout=10).status_code == 200
        assert update.result(timeout=10).status_code == 409
        snapshot = backup.result(timeout=10)

    assert manager.verify(snapshot.backup_id).valid
    assert not (settings.workspace_root / "move-race/before.md").exists()
    assert (settings.workspace_root / "move-race/after.md").read_text() == "base"
    with tarfile.open(manager.backup_root / snapshot.backup_id / "workspace.tar.gz") as archive:
        archived = archive.extractfile("move-race/after.md")
        assert archived is not None
        assert archived.read() == b"base"


def test_document_pipeline_serializes_revision_materialization_and_search(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = _create_text(client)
    service: DocumentService = client.app.state.services.documents
    original_write = service.workspace.write_atomic
    first_write_started = threading.Event()
    release_first_write = threading.Event()

    def delayed_write(path: str, content: str) -> str:
        if content == "first":
            first_write_started.set()
            assert release_first_write.wait(timeout=5)
        return original_write(path, content)

    monkeypatch.setattr(service.workspace, "write_atomic", delayed_write)

    with ThreadPoolExecutor(max_workers=2) as executor:
        first_future = executor.submit(
            client.patch,
            f"/api/v1/documents/{created['document_id']}",
            json={
                "expected_revision_id": created["current_revision_id"],
                "content": "first",
            },
            headers=headers("first-update"),
        )
        assert first_write_started.wait(timeout=5)
        first_revision = service.get_document(created["document_id"]).current_revision_id

        second_future = executor.submit(
            client.patch,
            f"/api/v1/documents/{created['document_id']}",
            json={"expected_revision_id": first_revision, "content": "second"},
            headers=headers("second-update"),
        )
        _wait_for_pipeline_attempt(service, created["document_id"])

        # The second mutation has reached the document boundary, but cannot commit
        # while the first revision still owns materialization and FTS synchronization.
        assert service.get_document(created["document_id"]).current_revision_id == first_revision
        release_first_write.set()
        assert first_future.result(timeout=5).status_code == 200
        second_response = second_future.result(timeout=5)

    assert second_response.status_code == 200
    final = second_response.json()
    assert final["materialization_state"] == "clean"
    assert final["file_hash"] == final["content_hash"]
    assert (settings.workspace_root / "race.md").read_text(encoding="utf-8") == "second"
    assert client.get("/api/v1/search", params={"q": "first"}).json() == []
    assert [
        item["document_id"] for item in client.get("/api/v1/search", params={"q": "second"}).json()
    ] == [created["document_id"]]


def test_create_pipeline_blocks_an_update_until_materialization_finishes(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    service: DocumentService = client.app.state.services.documents
    original_write = service.workspace.write_atomic
    create_write_started = threading.Event()
    release_create_write = threading.Event()

    def delayed_write(path: str, content: str) -> str:
        if content == "created":
            create_write_started.set()
            assert release_create_write.wait(timeout=5)
        return original_write(path, content)

    monkeypatch.setattr(service.workspace, "write_atomic", delayed_write)
    with ThreadPoolExecutor(max_workers=2) as executor:
        create_future = executor.submit(
            client.post,
            "/api/v1/documents",
            json={"title": "Create race", "content": "created", "path": "create-race.md"},
            headers=headers("create-race"),
        )
        assert create_write_started.wait(timeout=5)
        pending = service.list_documents()[0]
        update_future = executor.submit(
            client.patch,
            f"/api/v1/documents/{pending.document_id}",
            json={"expected_revision_id": pending.current_revision_id, "content": "updated"},
            headers=headers("update-after-create"),
        )
        _wait_for_pipeline_attempt(service, pending.document_id)
        assert service.get_document(pending.document_id).current_revision_id == (
            pending.current_revision_id
        )
        release_create_write.set()
        assert create_future.result(timeout=5).status_code == 201
        updated = update_future.result(timeout=5)

    assert updated.status_code == 200
    assert (settings.workspace_root / "create-race.md").read_text() == "updated"


@pytest.mark.parametrize("operation", ["restore", "move"])
def test_restore_and_move_pipelines_block_followup_updates(
    client: TestClient,
    settings,
    monkeypatch: pytest.MonkeyPatch,
    operation: str,
) -> None:
    created = _create_text(client, path=f"pipeline-{operation}.md")
    middle = client.patch(
        f"/api/v1/documents/{created['document_id']}",
        json={"expected_revision_id": created["current_revision_id"], "content": "middle"},
        headers=headers(f"middle-{operation}"),
    ).json()
    service: DocumentService = client.app.state.services.documents
    original_write = service.workspace.write_atomic
    pipeline_write_started = threading.Event()
    release_pipeline_write = threading.Event()

    def delayed_write(path: str, content: str) -> str:
        if (operation == "restore" and content == "base") or (
            operation == "move" and path == "pipeline-moved.md"
        ):
            pipeline_write_started.set()
            assert release_pipeline_write.wait(timeout=5)
        return original_write(path, content)

    monkeypatch.setattr(service.workspace, "write_atomic", delayed_write)
    with ThreadPoolExecutor(max_workers=2) as executor:
        if operation == "restore":
            pipeline_future = executor.submit(
                client.post,
                f"/api/v1/documents/{created['document_id']}/restore",
                json={
                    "expected_revision_id": middle["current_revision_id"],
                    "revision_id": created["current_revision_id"],
                },
                headers=headers("pipeline-restore"),
            )
        else:
            pipeline_future = executor.submit(
                client.post,
                f"/api/v1/documents/{created['document_id']}/move",
                json={
                    "expected_revision_id": middle["current_revision_id"],
                    "path": "pipeline-moved.md",
                },
                headers=headers("pipeline-move"),
            )
        assert pipeline_write_started.wait(timeout=5)
        pipeline_head = service.get_document(created["document_id"])
        followup_future = executor.submit(
            client.patch,
            f"/api/v1/documents/{created['document_id']}",
            json={
                "expected_revision_id": pipeline_head.current_revision_id,
                "content": "followup",
            },
            headers=headers(f"followup-{operation}"),
        )
        _wait_for_pipeline_attempt(service, created["document_id"])
        assert service.get_document(created["document_id"]).current_revision_id == (
            pipeline_head.current_revision_id
        )
        release_pipeline_write.set()
        assert pipeline_future.result(timeout=5).status_code == 200
        assert followup_future.result(timeout=5).status_code == 200

    expected_path = "pipeline-moved.md" if operation == "move" else f"pipeline-{operation}.md"
    assert (settings.workspace_root / expected_path).read_text() == "followup"


@pytest.mark.parametrize("operation", ["update", "move", "delete"])
def test_backup_excludes_in_flight_text_mutations(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    created = _create_text(client, path=f"{operation}/before.md")
    service: DocumentService = client.app.state.services.documents
    manager, executor, backup_future, release_archive = _start_paused_backup(client, monkeypatch)
    if operation == "update":
        mutation_future = executor.submit(
            client.patch,
            f"/api/v1/documents/{created['document_id']}",
            json={"expected_revision_id": created["current_revision_id"], "content": "after"},
            headers=headers("backup-race-update"),
        )
    elif operation == "move":
        mutation_future = executor.submit(
            client.post,
            f"/api/v1/documents/{created['document_id']}/move",
            json={
                "expected_revision_id": created["current_revision_id"],
                "path": "move/after.md",
            },
            headers=headers("backup-race-move"),
        )
    else:
        mutation_future = executor.submit(
            client.request,
            "DELETE",
            f"/api/v1/documents/{created['document_id']}",
            json={"expected_revision_id": created["current_revision_id"]},
            headers=headers("backup-race-delete"),
        )

    _wait_for_pipeline_attempt(service, created["document_id"], users=1)
    assert (
        service.get_document(created["document_id"]).current_revision_id
        == created["current_revision_id"]
    )
    release_archive.set()
    backup = backup_future.result(timeout=5)
    assert mutation_future.result(timeout=5).status_code == 200
    executor.shutdown()

    verification = manager.verify(backup.backup_id)
    assert verification.valid is True
    backup_dir = manager.backup_root / backup.backup_id
    with sqlite3.connect(backup_dir / "database.sqlite3") as snapshot:
        row = snapshot.execute(
            "SELECT path, deleted, content_hash FROM documents WHERE document_id = ?",
            (created["document_id"],),
        ).fetchone()
    assert row == (f"{operation}/before.md", 0, created["content_hash"])
    with tarfile.open(backup_dir / "workspace.tar.gz", "r:gz") as archive:
        archived = archive.extractfile(f"{operation}/before.md")
        assert archived is not None
        assert archived.read() == b"base"


def test_backup_barrier_and_pair_verification_cover_pdf_bytes(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    pdf = _pdf_bytes()
    imported = client.post(
        "/api/v1/pdfs",
        params={"title": "Existing PDF", "path": "pdf/existing.pdf"},
        content=pdf,
        headers={**headers("existing-pdf"), "Content-Type": "application/pdf"},
    )
    assert imported.status_code == 201
    manager, executor, backup_future, release_archive = _start_paused_backup(client, monkeypatch)
    pdf_service = client.app.state.services.pdf_research
    import_attempted = threading.Event()
    original_import = pdf_service.import_pdf

    def observed_import(**kwargs):
        import_attempted.set()
        return original_import(**kwargs)

    monkeypatch.setattr(pdf_service, "import_pdf", observed_import)
    new_pdf = executor.submit(
        client.post,
        "/api/v1/pdfs",
        params={"title": "Later PDF", "path": "pdf/later.pdf"},
        content=pdf,
        headers={**headers("later-pdf"), "Content-Type": "application/pdf"},
    )
    assert import_attempted.wait(timeout=5)
    assert not (manager.workspace_root / "pdf/later.pdf").exists()
    release_archive.set()
    backup = backup_future.result(timeout=5)
    assert new_pdf.result(timeout=5).status_code == 201
    executor.shutdown()
    assert manager.verify(backup.backup_id).valid is True

    # Re-signing artifact metadata cannot hide a database/workspace generation mismatch.
    backup_dir = manager.backup_root / backup.backup_id
    workspace_archive = backup_dir / "workspace.tar.gz"
    extracted_root = backup_dir / "tampered-workspace"
    with tarfile.open(workspace_archive, "r:gz") as archive:
        archive.extractall(extracted_root, filter="data")
    (extracted_root / "pdf/existing.pdf").write_bytes(b"%PDF-tampered")
    with tarfile.open(workspace_archive, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        for child in sorted(extracted_root.iterdir(), key=lambda item: item.name):
            archive.add(child, arcname=child.name, recursive=True)
    manifest_path = backup_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    workspace_artifact = next(
        artifact for artifact in manifest["artifacts"] if artifact["name"] == "workspace.tar.gz"
    )
    workspace_artifact["size_bytes"] = workspace_archive.stat().st_size
    workspace_artifact["sha256"] = hashlib.sha256(workspace_archive.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(
        ValidationError, match="Workspace backup does not match the database document head"
    ):
        manager.verify(backup.backup_id)


def test_backup_archive_skips_symlinks_and_traversal_targets(client: TestClient, settings) -> None:
    # Set up files inside workspace
    _create_text(client, path="valid.md")
    manager = client.app.state.services.backups.manager

    # Set up outside secret file and dir
    outside_dir = settings.workspace_root.parent / "outside_backup_test"
    outside_dir.mkdir(exist_ok=True)
    outside_file = outside_dir / "secret.txt"
    outside_file.write_text("secret payload", encoding="utf-8")

    # Add symlinks in workspace
    (settings.workspace_root / "linked_file.txt").symlink_to(outside_file)
    (settings.workspace_root / "linked_dir").symlink_to(outside_dir, target_is_directory=True)

    backup = manager.create()
    verification = manager.verify(backup.backup_id)
    assert verification.valid is True

    backup_dir = manager.backup_root / backup.backup_id
    with tarfile.open(backup_dir / "workspace.tar.gz", "r:gz") as archive:
        member_names = archive.getnames()
        assert "valid.md" in member_names
        assert "linked_file.txt" not in member_names
        assert "linked_dir" not in member_names
        assert "linked_dir/secret.txt" not in member_names

    shutil.rmtree(outside_dir, ignore_errors=True)


def test_backup_delete_uses_lifecycle_lock_and_syncs_parent(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    manager = client.app.state.services.backups.manager
    backup = manager.create()
    lock_owned = False
    synced = False
    original_rmtree = shutil.rmtree

    def observed_rmtree(path, *args, **kwargs):
        nonlocal lock_owned
        lock_owned = manager._create_lock.locked()
        return original_rmtree(path, *args, **kwargs)

    def observed_sync() -> None:
        nonlocal synced
        synced = True

    monkeypatch.setattr(shutil, "rmtree", observed_rmtree)
    monkeypatch.setattr(manager, "_fsync_backup_root", observed_sync)
    manager.delete(backup.backup_id)

    assert lock_owned is True
    assert synced is True


def test_backup_deletion_via_api(client: TestClient) -> None:
    # Create backup first
    create_res = client.post("/api/v1/backups", headers=headers("create-backup-for-del"))
    assert create_res.status_code == 201
    created_backup = create_res.json()
    backup_id = created_backup["backup_id"]

    # Ensure it is listed
    list_res = client.get("/api/v1/backups", headers=headers("list-backups-1"))
    assert list_res.status_code == 200
    assert any(b["backup_id"] == backup_id for b in list_res.json())

    # Delete backup
    del_res = client.delete(f"/api/v1/backups/{backup_id}", headers=headers("delete-backup-action"))
    assert del_res.status_code == 204

    # Ensure it is no longer listed
    list_after = client.get("/api/v1/backups", headers=headers("list-backups-2")).json()
    assert not any(b["backup_id"] == backup_id for b in list_after)


def test_concurrent_read_write_atomic_file_replacement(client: TestClient, settings) -> None:
    created = _create_text(client, path="concurrent_rw.md")
    doc_id = created["document_id"]
    stop_event = threading.Event()
    read_results: list[bytes] = []
    read_errors: list[str] = []

    def reader():
        while not stop_event.is_set():
            res = client.get(
                f"/api/v1/documents/{doc_id}/raw", headers=headers("concurrent-reader")
            )
            if res.status_code == 200:
                read_results.append(res.content)
            else:
                read_errors.append(f"Status {res.status_code}: {res.text}")

    reader_thread = threading.Thread(target=reader)
    reader_thread.start()

    current_rev = created["current_revision_id"]
    for i in range(15):
        update_res = client.patch(
            f"/api/v1/documents/{doc_id}",
            json={
                "expected_revision_id": current_rev,
                "content": f"content revision iteration {i} " + ("x" * 1000),
            },
            headers=headers(f"concurrent-writer-{i}"),
        )
        assert update_res.status_code == 200
        current_rev = update_res.json()["current_revision_id"]

    stop_event.set()
    reader_thread.join()

    assert not read_errors
    assert len(read_results) > 0
    # Verify every read content is complete, valid, and non-zero-byte
    for content in read_results:
        assert len(content) > 0
        assert content.startswith((b"base", b"content revision iteration"))

    # Verify no temporary staging files exist in workspace directory
    parent_dir = settings.workspace_root
    temp_files = [f for f in parent_dir.glob("*") if ".sangam-" in f.name]
    assert temp_files == []


def test_concurrent_folder_metadata_atomic_write_and_cleanup(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Create folder via API
    res = client.post(
        "/api/v1/folders",
        json={"path": "projects/active", "category": "initial", "tag_ids": []},
        headers=headers("create-folder-race"),
    )
    assert res.status_code == 201
    folder_id = res.json()["folder_id"]

    folder_dir = settings.workspace_root / "projects/active"
    manifest_file = folder_dir / ".sangam-folder.json"
    assert manifest_file.is_file()

    stop_event = threading.Event()
    read_results: list[bytes] = []
    read_errors: list[str] = []

    def reader():
        while not stop_event.is_set():
            if manifest_file.exists():
                try:
                    content = manifest_file.read_bytes()
                    read_results.append(content)
                # Collect every worker failure for assertion after joining the threads.
                except Exception as exc:  # noqa: BLE001
                    read_errors.append(str(exc))

    reader_thread = threading.Thread(target=reader)
    reader_thread.start()

    current_version = res.json()["metadata_version"]
    for i in range(10):
        update_res = client.patch(
            f"/api/v1/folders/{folder_id}",
            json={
                "expected_metadata_version": current_version,
                "category": f"cat-{i}",
                "tag_ids": [],
            },
            headers=headers(f"update-folder-meta-{i}"),
        )
        assert update_res.status_code == 200
        current_version = update_res.json()["metadata_version"]

    stop_event.set()
    reader_thread.join()

    assert not read_errors
    assert len(read_results) > 0
    # Confirm every read content was valid JSON and non-zero-byte
    for content in read_results:
        assert len(content) > 0
        parsed = json.loads(content.decode("utf-8"))
        assert parsed["folder_id"] == folder_id

    # Verify no temporary staging files left behind
    temp_files = list(folder_dir.glob(".sangam-folder-*"))
    assert temp_files == []

    # Test failure cleanup when writing folder metadata throws error
    def failing_write(*args, **kwargs):
        raise OSError("Simulated disk error during folder metadata write")

    monkeypatch.setattr(tempfile, "mkstemp", failing_write)
    with pytest.raises(OSError, match="Simulated disk error"):
        client.patch(
            f"/api/v1/folders/{folder_id}",
            json={
                "expected_metadata_version": current_version,
                "category": "cat-fail",
                "tag_ids": [],
            },
            headers=headers("update-folder-meta-fail"),
        )

    # Clean up verified: no leftover temporary files in folder directory
    temp_files_after_fail = list(folder_dir.glob(".sangam-folder-*"))
    assert temp_files_after_fail == []


@pytest.mark.parametrize(
    "malicious_member",
    ["../evil.txt", "/tmp/evil.txt", "../../etc/passwd", "sub/../../evil.txt"],
)
def test_restore_to_rejects_path_traversal_in_workspace_archive(
    client: TestClient, tmp_path: Path, malicious_member: str
) -> None:
    manager = client.app.state.services.backups.manager
    backup = manager.create()
    backup_dir = manager.backup_root / backup.backup_id
    workspace_archive = backup_dir / "workspace.tar.gz"

    # Create a fake extracted directory and inject a path traversal tar member
    extracted_root = backup_dir / "malicious-workspace"
    extracted_root.mkdir()
    (extracted_root / "safe.txt").write_text("safe content")

    with tarfile.open(workspace_archive, "w:gz", format=tarfile.PAX_FORMAT) as archive:
        archive.add(extracted_root / "safe.txt", arcname="safe.txt")
        # Add entry with dangerous member name
        tarinfo = tarfile.TarInfo(name=malicious_member)
        content = b"evil payload"
        tarinfo.size = len(content)
        archive.addfile(tarinfo, io.BytesIO(content))

    # Update manifest to match tampered workspace archive
    manifest_path = backup_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    workspace_artifact = next(
        artifact for artifact in manifest["artifacts"] if artifact["name"] == "workspace.tar.gz"
    )
    workspace_artifact["size_bytes"] = workspace_archive.stat().st_size
    workspace_artifact["sha256"] = hashlib.sha256(workspace_archive.read_bytes()).hexdigest()
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    restore_db_target = tmp_path / "restore_target" / "db.sqlite3"
    restore_ws_target = tmp_path / "restore_target" / "workspace"

    with pytest.raises(ValidationError, match="Workspace backup contains an unsafe archive member"):
        manager.restore_to(
            backup.backup_id,
            database_path=restore_db_target,
            workspace_root=restore_ws_target,
        )


def test_document_etag_and_if_none_match_headers(client: TestClient) -> None:
    # 1. Create document and check ETag on 201 Created
    res_create = client.post(
        "/api/v1/documents",
        json={"title": "ETag Doc", "content": "Initial ETag content", "path": "etag_test.md"},
        headers=headers("create-etag-doc"),
    )
    assert res_create.status_code == 201
    doc = res_create.json()
    doc_id = doc["document_id"]
    expected_etag = res_create.headers["ETag"]
    assert res_create.headers.get("ETag") == expected_etag

    # 2. GET document and check ETag header
    res_get = client.get(f"/api/v1/documents/{doc_id}", headers=headers("get-etag-doc"))
    assert res_get.status_code == 200
    assert res_get.headers.get("ETag") == expected_etag

    # 3. GET document with If-None-Match returning 304 Not Modified
    res_304 = client.get(
        f"/api/v1/documents/{doc_id}",
        headers={**headers("get-if-none-match"), "If-None-Match": expected_etag},
    )
    assert res_304.status_code == 304
    assert res_304.headers.get("ETag") == expected_etag

    # 4. GET raw with If-None-Match
    res_raw_304 = client.get(
        f"/api/v1/documents/{doc_id}/raw",
        headers={
            **headers("raw-if-none-match"),
            "If-None-Match": client.get(f"/api/v1/documents/{doc_id}/raw").headers["ETag"],
        },
    )
    assert res_raw_304.status_code == 304

    # 5. GET download with If-None-Match
    res_dl_304 = client.get(
        f"/api/v1/documents/{doc_id}/download",
        headers={
            **headers("dl-if-none-match"),
            "If-None-Match": client.get(f"/api/v1/documents/{doc_id}/download").headers["ETag"],
        },
    )
    assert res_dl_304.status_code == 304

    # 6. GET document with mismatched If-None-Match returns 200 OK
    res_200 = client.get(
        f"/api/v1/documents/{doc_id}",
        headers={**headers("get-if-none-match-diff"), "If-None-Match": '"other_rev"'},
    )
    assert res_200.status_code == 200


def test_document_if_match_conditional_update_and_conflict(client: TestClient) -> None:
    created = _create_text(client, path="if_match.md")
    doc_id = created["document_id"]
    rev_1 = created["current_revision_id"]
    etag_1 = client.get(f"/api/v1/documents/{doc_id}").headers["ETag"]

    # 1. Update using If-Match header without expected_revision_id in body
    update_1 = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={"content": "Updated via If-Match header"},
        headers={**headers("update-if-match-1"), "If-Match": etag_1},
    )
    assert update_1.status_code == 200
    rev_2 = update_1.json()["current_revision_id"]
    assert rev_2 != rev_1
    assert update_1.headers.get("ETag") == client.get(f"/api/v1/documents/{doc_id}").headers["ETag"]

    # HTTP precondition failures use 412 independently of body revision conflicts.
    stale_update = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={"content": "Stale edit attempt"},
        headers={**headers("update-if-match-stale"), "If-Match": etag_1},
    )
    assert stale_update.status_code == 412
    assert stale_update.json()["error"]["code"] == "precondition_failed"

    # A false supplied header is evaluated before the independent body guard.
    mismatched_update = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={"expected_revision_id": rev_2, "content": "Mismatched edit attempt"},
        headers={**headers("update-if-match-mismatch"), "If-Match": etag_1},
    )
    assert mismatched_update.status_code == 412

    # 4. Update using wildcard If-Match: "*"
    wildcard_update = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={"content": "Wildcard edit"},
        headers={**headers("update-if-match-wildcard"), "If-Match": "*"},
    )
    assert wildcard_update.status_code == 200
    assert wildcard_update.json()["content"] == "Wildcard edit"


def test_concurrent_race_conditional_updates_with_if_match(client: TestClient) -> None:
    created = _create_text(client, path="race_if_match.md")
    doc_id = created["document_id"]
    initial_etag = client.get(f"/api/v1/documents/{doc_id}").headers["ETag"]

    agent1_status = None
    agent2_status = None

    def agent1_update():
        nonlocal agent1_status
        res = client.patch(
            f"/api/v1/documents/{doc_id}",
            json={"content": "Content from Agent 1"},
            headers={**headers("agent-1-update"), "If-Match": initial_etag},
        )
        agent1_status = res.status_code

    def agent2_update():
        nonlocal agent2_status
        res = client.patch(
            f"/api/v1/documents/{doc_id}",
            json={"content": "Content from Agent 2"},
            headers={**headers("agent-2-update"), "If-Match": initial_etag},
        )
        agent2_status = res.status_code

    with ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(agent1_update)
        f2 = executor.submit(agent2_update)
        f1.result(timeout=5)
        f2.result(timeout=5)

    status_codes = sorted([agent1_status, agent2_status])
    # Exactly one succeeds; the stale HTTP precondition fails.
    assert status_codes == [200, 412], f"Unexpected status codes: {status_codes}"

    # Verify final document is consistent
    final_doc = client.get(f"/api/v1/documents/{doc_id}", headers=headers("get-final-race")).json()
    assert final_doc["content"] in ("Content from Agent 1", "Content from Agent 2")
