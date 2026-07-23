from __future__ import annotations

import hashlib
import os
import re
import shutil
import sqlite3
import tarfile
import tempfile
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from sangam.db import Database, utc_now
from sangam.errors import NotFoundError, ValidationError
from sangam.mutations import MutationCoordinator
from sangam.schemas import BackupArtifact, BackupSet, BackupVerification

_BACKUP_ID = re.compile(r"^[0-9]{8}T[0-9]{12}Z-[0-9a-f]{8}$")
_ARTIFACT_NAMES = {"database.sqlite3", "workspace.tar.gz"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact(path: Path) -> BackupArtifact:
    return BackupArtifact(name=path.name, sha256=_sha256(path), size_bytes=path.stat().st_size)


def _write_manifest(path: Path, backup: BackupSet) -> None:
    temporary = path.with_suffix(".json.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        handle.write(backup.model_dump_json(indent=2) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


class BackupManager:
    """Creates verified, self-contained SQLite and workspace backup sets."""

    def __init__(
        self,
        *,
        database: Database,
        workspace_root: Path,
        backup_root: Path,
        retention_count: int,
        mutations: MutationCoordinator,
    ) -> None:
        self.database = database
        self.workspace_root = workspace_root
        self.backup_root = backup_root
        self.retention_count = retention_count
        self.mutations = mutations
        self.backup_root.mkdir(parents=True, exist_ok=True)
        self._create_lock = threading.Lock()

    @staticmethod
    def new_backup_id() -> str:
        now = datetime.now(UTC)
        return f"{now:%Y%m%dT%H%M%S%fZ}-{uuid.uuid4().hex[:8]}"

    def list(self) -> list[BackupSet]:
        backups: list[BackupSet] = []
        for candidate in sorted(self.backup_root.iterdir(), reverse=True):
            manifest = candidate / "manifest.json"
            if candidate.is_dir() and _BACKUP_ID.fullmatch(candidate.name) and manifest.is_file():
                try:
                    backups.append(
                        BackupSet.model_validate_json(manifest.read_text(encoding="utf-8"))
                    )
                except ValueError:
                    continue
        return backups

    def create_if_due(self) -> BackupSet | None:
        backups = self.list()
        today = datetime.now(UTC).date()
        if backups and datetime.fromisoformat(backups[0].created_at).date() >= today:
            return None
        return self.create()

    def create(self, *, backup_id: str | None = None) -> BackupSet:
        with self._create_lock:
            return self._create(backup_id=backup_id)

    def _create(self, *, backup_id: str | None) -> BackupSet:
        now = datetime.now(UTC)
        backup_id = backup_id or self.new_backup_id()
        if not _BACKUP_ID.fullmatch(backup_id):
            raise ValidationError("Backup ID is invalid")
        destination = self.backup_root / backup_id
        if destination.exists():
            self.verify(backup_id)
            return self.get(backup_id)
        staging = Path(tempfile.mkdtemp(prefix=".sangam-backup-", dir=self.backup_root))
        try:
            database_path = staging / "database.sqlite3"
            workspace_path = staging / "workspace.tar.gz"
            with self.mutations.backup():
                self._snapshot_database(database_path)
                self._archive_workspace(workspace_path)

            with sqlite3.connect(database_path) as snapshot:
                document_count = snapshot.execute(
                    "SELECT count(*) FROM documents WHERE deleted = 0"
                ).fetchone()[0]
                revision_count = snapshot.execute("SELECT count(*) FROM revisions").fetchone()[0]

            backup = BackupSet(
                backup_id=backup_id,
                created_at=now.isoformat(timespec="microseconds"),
                document_count=document_count,
                revision_count=revision_count,
                artifacts=[_artifact(database_path), _artifact(workspace_path)],
            )
            _write_manifest(staging / "manifest.json", backup)
            os.replace(staging, destination)
            backup_directory = os.open(self.backup_root, os.O_RDONLY)
            try:
                os.fsync(backup_directory)
            finally:
                os.close(backup_directory)
            self.verify(backup_id)
            self._apply_retention()
            return self.get(backup_id)
        except Exception:
            shutil.rmtree(staging, ignore_errors=True)
            shutil.rmtree(destination, ignore_errors=True)
            raise

    def _snapshot_database(self, destination: Path) -> None:
        source = self.database.connect()
        target = sqlite3.connect(destination)
        try:
            source.backup(target)
        finally:
            target.close()
            source.close()

    def _archive_workspace(self, destination: Path) -> None:
        with tarfile.open(destination, "w:gz", format=tarfile.PAX_FORMAT) as archive:
            for child in sorted(self.workspace_root.iterdir(), key=lambda item: item.name):
                archive.add(child, arcname=child.name, recursive=True)

    def get(self, backup_id: str) -> BackupSet:
        backup_dir = self._backup_dir(backup_id)
        manifest = backup_dir / "manifest.json"
        if not manifest.is_file():
            raise NotFoundError(f"Backup not found: {backup_id}")
        try:
            backup = BackupSet.model_validate_json(manifest.read_text(encoding="utf-8"))
        except ValueError as error:
            raise ValidationError("Backup manifest is invalid") from error
        if backup.backup_id != backup_id:
            raise ValidationError("Backup manifest ID does not match its directory")
        return backup

    def verify(self, backup_id: str) -> BackupVerification:
        backup = self.get(backup_id)
        backup_dir = self._backup_dir(backup_id)
        artifact_names = {artifact.name for artifact in backup.artifacts}
        if artifact_names != _ARTIFACT_NAMES or len(backup.artifacts) != len(_ARTIFACT_NAMES):
            raise ValidationError("Backup manifest has an invalid artifact inventory")
        for artifact in backup.artifacts:
            path = backup_dir / artifact.name
            if not path.is_file() or path.stat().st_size != artifact.size_bytes:
                raise ValidationError(
                    f"Backup artifact is missing or has the wrong size: {artifact.name}"
                )
            if _sha256(path) != artifact.sha256:
                raise ValidationError(f"Backup artifact checksum failed: {artifact.name}")

        with sqlite3.connect(backup_dir / "database.sqlite3") as snapshot:
            snapshot.row_factory = sqlite3.Row
            integrity = snapshot.execute("PRAGMA integrity_check").fetchone()[0]
            materialized = snapshot.execute(
                """
                SELECT d.document_id, d.path, d.content_hash, d.file_hash,
                    d.materialization_state, r.content_hash AS revision_hash
                FROM documents d
                JOIN revisions r ON r.revision_id = d.current_revision_id
                WHERE d.deleted = 0 AND d.path IS NOT NULL
                ORDER BY d.path
                """
            ).fetchall()
        if integrity != "ok":
            raise ValidationError(
                "Backup database integrity check failed", details={"result": integrity}
            )

        member_count = 0
        member_names: set[str] = set()
        archived_hashes: dict[str, str] = {}
        with tarfile.open(backup_dir / "workspace.tar.gz", "r:gz") as archive:
            for member in archive.getmembers():
                member_count += 1
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
                    raise ValidationError("Workspace backup contains an unsafe archive member")
                if member.name in member_names:
                    raise ValidationError("Workspace backup contains a duplicate archive member")
                member_names.add(member.name)
                if member.isfile():
                    extracted = archive.extractfile(member)
                    if extracted is None:
                        raise ValidationError("Workspace backup file could not be read")
                    digest = hashlib.sha256()
                    while chunk := extracted.read(1024 * 1024):
                        digest.update(chunk)
                    archived_hashes[member.name] = digest.hexdigest()

        for document in materialized:
            expected_hash = document["content_hash"]
            if (
                document["materialization_state"] != "clean"
                or document["file_hash"] != expected_hash
                or document["revision_hash"] != expected_hash
            ):
                raise ValidationError(
                    "Backup database contains a non-canonical materialized document",
                    details={"document_id": document["document_id"], "path": document["path"]},
                )
            if archived_hashes.get(document["path"]) != expected_hash:
                raise ValidationError(
                    "Workspace backup does not match the database document head",
                    details={"document_id": document["document_id"], "path": document["path"]},
                )

        verified_at = utc_now()
        verified = BackupVerification(
            backup_id=backup_id,
            valid=True,
            database_integrity=integrity,
            workspace_members=member_count,
            verified_at=verified_at,
        )
        updated = backup.model_copy(update={"verified_at": verified_at})
        _write_manifest(backup_dir / "manifest.json", updated)
        return verified

    def restore_to(self, backup_id: str, *, database_path: Path, workspace_root: Path) -> None:
        self.verify(backup_id)
        if database_path.exists() or (workspace_root.exists() and any(workspace_root.iterdir())):
            raise ValidationError("Restore targets must be empty and Sangam must be stopped")
        backup_dir = self._backup_dir(backup_id)
        database_path.parent.mkdir(parents=True, exist_ok=True)
        workspace_root.mkdir(parents=True, exist_ok=True)
        shutil.copy2(backup_dir / "database.sqlite3", database_path)
        with tarfile.open(backup_dir / "workspace.tar.gz", "r:gz") as archive:
            archive.extractall(workspace_root, filter="data")

    def _backup_dir(self, backup_id: str) -> Path:
        if not _BACKUP_ID.fullmatch(backup_id):
            raise NotFoundError(f"Backup not found: {backup_id}")
        return self.backup_root / backup_id

    def _apply_retention(self) -> None:
        for backup in self.list()[self.retention_count :]:
            shutil.rmtree(self.backup_root / backup.backup_id)
