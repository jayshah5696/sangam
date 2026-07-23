from __future__ import annotations

import hashlib
import io
import json
import sqlite3
import tarfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from conftest import headers
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from sangam.errors import ValidationError
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


def test_document_pipeline_serializes_revision_materialization_and_search(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = _create_text(client)
    service: DocumentService = client.app.state.services.documents
    original_write = service.workspace.write_atomic
    first_write_started = threading.Event()
    release_first_write = threading.Event()
    second_attempted = threading.Event()

    def delayed_write(path: str, content: str) -> str:
        if content == "first":
            first_write_started.set()
            assert release_first_write.wait(timeout=5)
        return original_write(path, content)

    original_append = service._append_revision

    def observed_append(**kwargs):
        if kwargs["idempotency_key"] == "second-update":
            second_attempted.set()
        return original_append(**kwargs)

    monkeypatch.setattr(service.workspace, "write_atomic", delayed_write)
    monkeypatch.setattr(service, "_append_revision", observed_append)

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
        assert second_attempted.wait(timeout=5)

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
    update_attempted = threading.Event()

    def delayed_write(path: str, content: str) -> str:
        if content == "created":
            create_write_started.set()
            assert release_create_write.wait(timeout=5)
        return original_write(path, content)

    original_append = service._append_revision

    def observed_append(**kwargs):
        update_attempted.set()
        return original_append(**kwargs)

    monkeypatch.setattr(service.workspace, "write_atomic", delayed_write)
    monkeypatch.setattr(service, "_append_revision", observed_append)
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
        assert update_attempted.wait(timeout=5)
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
    followup_attempted = threading.Event()

    def delayed_write(path: str, content: str) -> str:
        if (operation == "restore" and content == "base") or (
            operation == "move" and path == "pipeline-moved.md"
        ):
            pipeline_write_started.set()
            assert release_pipeline_write.wait(timeout=5)
        return original_write(path, content)

    original_append = service._append_revision

    def observed_append(**kwargs):
        if kwargs["idempotency_key"] == f"followup-{operation}":
            followup_attempted.set()
        return original_append(**kwargs)

    monkeypatch.setattr(service.workspace, "write_atomic", delayed_write)
    monkeypatch.setattr(service, "_append_revision", observed_append)
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
        assert followup_attempted.wait(timeout=5)
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
    mutation_attempted = threading.Event()
    original_append = service._append_revision

    def observed_append(**kwargs):
        mutation_attempted.set()
        return original_append(**kwargs)

    monkeypatch.setattr(service, "_append_revision", observed_append)
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

    assert mutation_attempted.wait(timeout=5)
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
    original_import = pdf_service._import_pdf_locked

    def observed_import(**kwargs):
        import_attempted.set()
        return original_import(**kwargs)

    monkeypatch.setattr(pdf_service, "_import_pdf_locked", observed_import)
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
