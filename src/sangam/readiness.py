from __future__ import annotations

import os
import tempfile
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path
from typing import Any

from sangam.backup_service import BackupService
from sangam.config import Settings
from sangam.db import Database


class ReadinessService:
    """Evaluate cheap, actionable process readiness checks for operators."""

    def __init__(
        self,
        *,
        database: Database,
        backups: BackupService,
        settings: Settings,
    ) -> None:
        self.database = database
        self.backups = backups
        self.settings = settings

    def check(
        self,
        *,
        startup_complete: bool,
        startup_reconciliation_error: Exception | None,
    ) -> dict[str, Any]:
        checks: dict[str, dict[str, Any]] = {}
        checks["database"] = self._database_check()
        checks["schema"] = self._schema_check()
        checks["writable_roots"] = self._writable_roots_check()
        checks["startup_reconciliation"] = {
            "ok": startup_complete and startup_reconciliation_error is None,
            "detail": (
                "complete"
                if startup_complete and startup_reconciliation_error is None
                else "failed"
                if startup_reconciliation_error is not None
                else "not_complete"
            ),
        }
        checks["pending_materializations"] = self._pending_materializations_check()
        checks["backup_freshness"] = self._backup_freshness_check()
        ready = all(check["ok"] for check in checks.values())
        return {"status": "ready" if ready else "degraded", "checks": checks}

    def _database_check(self) -> dict[str, Any]:
        try:
            with self.database.connection() as connection:
                connection.execute("SELECT 1").fetchone()
        except Exception as error:
            return {"ok": False, "detail": type(error).__name__}
        return {"ok": True, "detail": "reachable"}

    def _schema_check(self) -> dict[str, Any]:
        try:
            packaged = sorted(
                migration.name.split("_", 1)[0]
                for migration in resources.files("sangam.migrations").iterdir()
                if migration.name.endswith(".sql")
            )
            with self.database.connection() as connection:
                applied = [
                    row["version"]
                    for row in connection.execute(
                        "SELECT version FROM schema_migrations ORDER BY version"
                    ).fetchall()
                ]
        except Exception as error:
            return {"ok": False, "detail": type(error).__name__}
        if applied != packaged:
            return {
                "ok": False,
                "detail": "migration_mismatch",
                "applied_count": len(applied),
                "packaged_count": len(packaged),
            }
        return {"ok": True, "detail": "current", "version": packaged[-1] if packaged else None}

    def _writable_roots_check(self) -> dict[str, Any]:
        failures: list[str] = []
        for label, root in (
            ("database", self.settings.database_path.parent),
            ("workspace", self.settings.workspace_root),
            ("backup", self.settings.backup_root),
        ):
            if not self._probe_writable(root):
                failures.append(label)
        return {
            "ok": not failures,
            "detail": "writable" if not failures else "unwritable",
            "failed_roots": failures,
        }

    @staticmethod
    def _probe_writable(root: Path) -> bool:
        descriptor = -1
        probe_path: Path | None = None
        try:
            descriptor, raw_path = tempfile.mkstemp(prefix=".sangam-readiness-", dir=root)
            probe_path = Path(raw_path)
            os.write(descriptor, b"ready")
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = -1
            return True
        except OSError:
            return False
        finally:
            if descriptor >= 0:
                os.close(descriptor)
            if probe_path is not None:
                probe_path.unlink(missing_ok=True)

    def _pending_materializations_check(self) -> dict[str, Any]:
        try:
            with self.database.connection() as connection:
                count = connection.execute(
                    "SELECT count(*) FROM documents WHERE materialization_state = 'pending'"
                ).fetchone()[0]
        except Exception as error:
            return {"ok": False, "detail": type(error).__name__}
        return {"ok": count == 0, "detail": "none" if count == 0 else "pending", "count": count}

    def _backup_freshness_check(self) -> dict[str, Any]:
        if not self.settings.backups_enabled:
            return {"ok": True, "detail": "disabled"}
        try:
            backups = self.backups.list()
            if not backups:
                return {"ok": False, "detail": "missing"}
            latest = max(datetime.fromisoformat(backup.created_at) for backup in backups)
            if latest.tzinfo is None:
                latest = latest.replace(tzinfo=UTC)
            age_seconds = max(0, int((datetime.now(UTC) - latest).total_seconds()))
        except Exception as error:
            return {"ok": False, "detail": type(error).__name__}
        fresh = age_seconds <= self.settings.backup_readiness_max_age_seconds
        return {
            "ok": fresh,
            "detail": "fresh" if fresh else "stale",
            "age_seconds": age_seconds,
            "max_age_seconds": self.settings.backup_readiness_max_age_seconds,
        }
