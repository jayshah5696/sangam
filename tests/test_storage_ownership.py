from __future__ import annotations

import subprocess
import sys
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings
from sangam.pdf_research import PdfResearchService
from sangam.storage_ownership import StorageOwnershipError


def _start_owner(database: Path, workspace: Path, backup: Path) -> subprocess.Popen[str]:
    code = """
from pathlib import Path
import sys, time
from sangam.api import create_app
from sangam.config import Settings
app = create_app(Settings(database_path=Path(sys.argv[1]), workspace_root=Path(sys.argv[2]), backup_root=Path(sys.argv[3]), backups_enabled=False, frontend_dist=Path('/missing')))
print('ready', flush=True)
time.sleep(30)
"""
    process = subprocess.Popen(
        [sys.executable, "-c", code, str(database), str(workspace), str(backup)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert process.stdout is not None
    assert process.stdout.readline().strip() == "ready"
    return process


def _try_create_app(
    database: Path, workspace: Path, backup: Path
) -> subprocess.CompletedProcess[str]:
    code = """
from pathlib import Path
import sys
from sangam.api import create_app
from sangam.config import Settings
create_app(Settings(database_path=Path(sys.argv[1]), workspace_root=Path(sys.argv[2]), backup_root=Path(sys.argv[3]), backups_enabled=False, frontend_dist=Path('/missing')))
"""
    return subprocess.run(
        [sys.executable, "-c", code, str(database), str(workspace), str(backup)],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )


@pytest.mark.parametrize("shared_resource", ["database", "workspace"])
def test_second_process_cannot_initialize_shared_storage(
    tmp_path: Path, shared_resource: str
) -> None:
    database = tmp_path / "database" / "sangam.sqlite3"
    workspace = tmp_path / "workspace"
    backup = tmp_path / "backups"
    owner = _start_owner(database, workspace, backup)
    try:
        database_before = database.read_bytes()
        files_before = sorted(path.relative_to(workspace) for path in workspace.rglob("*"))
        other_database = database if shared_resource == "database" else tmp_path / "other.sqlite3"
        other_workspace = (
            workspace if shared_resource == "workspace" else tmp_path / "other-workspace"
        )

        contender = _try_create_app(other_database, other_workspace, tmp_path / "other-backups")

        assert contender.returncode != 0
        assert "already in use" in contender.stderr.lower()
        assert database.read_bytes() == database_before
        assert sorted(path.relative_to(workspace) for path in workspace.rglob("*")) == files_before
    finally:
        owner.terminate()
        owner.wait(timeout=10)


def test_storage_ownership_releases_after_owner_process_death(tmp_path: Path) -> None:
    database = tmp_path / "database" / "sangam.sqlite3"
    workspace = tmp_path / "workspace"
    backup = tmp_path / "backups"
    owner = _start_owner(database, workspace, backup)
    owner.kill()
    owner.wait(timeout=10)

    restarted = _try_create_app(database, workspace, backup)

    assert restarted.returncode == 0, restarted.stderr


def test_storage_ownership_releases_after_normal_app_shutdown(tmp_path: Path) -> None:
    settings = Settings(
        database_path=tmp_path / "database" / "sangam.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
        backups_enabled=False,
        frontend_dist=tmp_path / "missing-frontend",
    )

    with TestClient(create_app(settings)):
        pass
    with TestClient(create_app(settings)):
        pass


def test_storage_ownership_is_retained_if_extraction_outlives_shutdown(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = Settings(
        database_path=tmp_path / "database" / "sangam.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
        backups_enabled=False,
        pdf_extraction_shutdown_timeout_seconds=0.1,
        frontend_dist=tmp_path / "missing-frontend",
    )
    app = create_app(settings)
    app.state.services.pdf_research.import_pdf(
        title="Pending extraction",
        path="pending.pdf",
        content=b"%PDF-1.4\n%%EOF",
        supersedes_document_id=None,
        actor_id="human:jay",
        idempotency_key="pending-extraction",
    )
    started = threading.Event()
    release = threading.Event()

    def hold_extraction(
        _self: PdfResearchService,
        _document_id: str,
        cancel_event: threading.Event | None = None,
    ) -> bool:
        started.set()
        release.wait(timeout=5)
        return False

    monkeypatch.setattr(PdfResearchService, "extract_text", hold_extraction)
    try:
        with pytest.raises(RuntimeError, match="shutdown timed out"):
            with TestClient(app):
                assert started.wait(timeout=5)

        with pytest.raises(StorageOwnershipError, match="already in use"):
            create_app(settings)
    finally:
        release.set()


def test_storage_ownership_is_retained_if_backup_outlives_shutdown(
    tmp_path: Path,
) -> None:
    settings = Settings(
        database_path=tmp_path / "database" / "sangam.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
        backups_enabled=True,
        pdf_extraction_shutdown_timeout_seconds=0.1,
        frontend_dist=tmp_path / "missing-frontend",
    )
    app = create_app(settings)
    started = threading.Event()
    release = threading.Event()

    def hold_backup() -> None:
        started.set()
        release.wait(timeout=5)

    app.state.services.backups.create_if_due = hold_backup
    try:
        with pytest.raises(TimeoutError):
            with TestClient(app):
                assert started.wait(timeout=5)

        with pytest.raises(StorageOwnershipError, match="already in use"):
            create_app(settings)
    finally:
        release.set()


def test_independent_storage_instances_can_initialize_concurrently(tmp_path: Path) -> None:
    first = _start_owner(
        tmp_path / "first" / "database.sqlite3",
        tmp_path / "first" / "workspace",
        tmp_path / "first" / "backups",
    )
    second = None
    try:
        second = _start_owner(
            tmp_path / "second" / "database.sqlite3",
            tmp_path / "second" / "workspace",
            tmp_path / "second" / "backups",
        )
    finally:
        first.terminate()
        first.wait(timeout=10)
        if second is not None:
            second.terminate()
            second.wait(timeout=10)


def test_canonical_path_alias_cannot_bypass_storage_ownership(tmp_path: Path) -> None:
    database = tmp_path / "database" / "sangam.sqlite3"
    workspace = tmp_path / "workspace"
    backup = tmp_path / "backups"
    alias_database = tmp_path / "alias.sqlite3"
    owner = _start_owner(database, workspace, backup)
    try:
        alias_database.symlink_to(database)
        contender = _try_create_app(alias_database, workspace / ".." / "workspace", backup)

        assert contender.returncode != 0
        assert "already in use" in contender.stderr.lower()
    finally:
        owner.terminate()
        owner.wait(timeout=10)
