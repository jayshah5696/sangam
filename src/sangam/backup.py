from __future__ import annotations

import hashlib
import os
import re
import shutil
import sqlite3
import tarfile
import tempfile
import uuid
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from sangam.db import Database, utc_now
from sangam.errors import NotFoundError, ValidationError
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
    ) -> None:
        self.database = database
        self.workspace_root = workspace_root
        self.backup_root = backup_root
        self.retention_count = retention_count
        self.backup_root.mkdir(parents=True, exist_ok=True)

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

    def create(self) -> BackupSet:
        now = datetime.now(UTC)
        backup_id = f"{now:%Y%m%dT%H%M%S%fZ}-{uuid.uuid4().hex[:8]}"
        staging = Path(tempfile.mkdtemp(prefix=".sangam-backup-", dir=self.backup_root))
        destination = self.backup_root / backup_id
        try:
            database_path = staging / "database.sqlite3"
            source = self.database.connect()
            target = sqlite3.connect(database_path)
            try:
                source.backup(target)
            finally:
                target.close()
                source.close()

            workspace_path = staging / "workspace.tar.gz"
            with tarfile.open(workspace_path, "w:gz", format=tarfile.PAX_FORMAT) as archive:
                for child in sorted(self.workspace_root.iterdir(), key=lambda item: item.name):
                    archive.add(child, arcname=child.name, recursive=True)

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
            integrity = snapshot.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise ValidationError(
                "Backup database integrity check failed", details={"result": integrity}
            )

        member_count = 0
        with tarfile.open(backup_dir / "workspace.tar.gz", "r:gz") as archive:
            for member in archive.getmembers():
                member_count += 1
                path = PurePosixPath(member.name)
                if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
                    raise ValidationError("Workspace backup contains an unsafe archive member")

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
