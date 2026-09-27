from __future__ import annotations

import hashlib
import re
import sqlite3
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path

_MIGRATION_NAME = re.compile(r"^(?P<version>[0-9]{3})_[a-z0-9_]+\.sql$")


@dataclass(frozen=True)
class Migration:
    version: str
    name: str
    sql: str
    checksum: str


def utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="microseconds")


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._local = threading.local()

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        active = getattr(self._local, "active_connection", None)
        if active is not None:
            yield active
            return

        connection = self.connect()
        try:
            yield connection
        finally:
            connection.close()

    def set_audit_target(
        self,
        *,
        resource_id: str | None = None,
        revision_id: str | None = None,
        path: str | None = None,
        details: dict[str, object] | None = None,
    ) -> None:
        target = getattr(self._local, "audit_target", None)
        if target is None:
            target = {}
            self._local.audit_target = target
        if resource_id is not None:
            target["resource_id"] = resource_id
        if revision_id is not None:
            target["revision_id"] = revision_id
        if path is not None:
            target["path"] = path
        if details is not None:
            target.setdefault("details", {}).update(details)

    def get_audit_target(self) -> dict[str, object]:
        return getattr(self._local, "audit_target", None) or {}

    def clear_audit_target(self) -> None:
        self._local.audit_target = None

    @contextmanager
    def commit_hook(self, callback: Callable[[sqlite3.Connection], None]) -> Iterator[None]:
        hooks = getattr(self._local, "commit_hooks", None)
        if hooks is None:
            hooks = []
            self._local.commit_hooks = hooks
        hooks.append(callback)
        try:
            yield
        finally:
            if callback in hooks:
                hooks.remove(callback)

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        active = getattr(self._local, "active_connection", None)
        if active is not None:
            depth = getattr(self._local, "transaction_depth", 1)
            self._local.transaction_depth = depth + 1
            try:
                yield active
            except Exception:
                self._local.rollback_required = True
                raise
            finally:
                self._local.transaction_depth = depth
            return

        connection = self.connect()
        self._local.active_connection = connection
        self._local.transaction_depth = 1
        self._local.rollback_required = False
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            if getattr(self._local, "rollback_required", False):
                raise RuntimeError("Transaction aborted due to error in nested transaction block")
            hooks = list(getattr(self._local, "commit_hooks", []))
            for hook in hooks:
                hook(connection)
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            self._local.active_connection = None
            self._local.transaction_depth = 0
            self._local.rollback_required = False
            self._local.audit_target = None
            connection.close()

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        migrations = self._migration_inventory()
        with self.connection() as connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version TEXT PRIMARY KEY,
                    name TEXT,
                    checksum TEXT,
                    applied_at TEXT NOT NULL
                )
                """
            )
            self._upgrade_migration_metadata(connection)
            applied_rows = {
                row["version"]: row
                for row in connection.execute(
                    "SELECT version, name, checksum FROM schema_migrations"
                ).fetchall()
            }
            packaged_versions = {migration.version for migration in migrations}
            unknown_versions = sorted(set(applied_rows) - packaged_versions)
            if unknown_versions:
                raise RuntimeError(
                    "Database schema is newer than this Sangam build or contains unknown "
                    f"migrations: {', '.join(unknown_versions)}"
                )

            for migration in migrations:
                applied = applied_rows.get(migration.version)
                if applied:
                    self._validate_applied_migration(connection, applied, migration)
                    continue
                rebuilds_referenced_tables = migration.sql.startswith("-- sangam:foreign-keys-off")
                try:
                    if rebuilds_referenced_tables:
                        connection.execute("PRAGMA foreign_keys = OFF")
                    connection.executescript("BEGIN IMMEDIATE;\n" + migration.sql)
                    connection.execute(
                        """
                        INSERT INTO schema_migrations(version, name, checksum, applied_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (migration.version, migration.name, migration.checksum, utc_now()),
                    )
                    if rebuilds_referenced_tables:
                        violations = connection.execute("PRAGMA foreign_key_check").fetchall()
                        if violations:
                            raise sqlite3.IntegrityError(
                                f"Migration {migration.version} left foreign key violations"
                            )
                    connection.commit()
                except Exception:
                    if connection.in_transaction:
                        connection.rollback()
                    raise
                finally:
                    if rebuilds_referenced_tables:
                        connection.execute("PRAGMA foreign_keys = ON")

    @staticmethod
    def _upgrade_migration_metadata(connection: sqlite3.Connection) -> None:
        columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(schema_migrations)")
        }
        if "name" not in columns:
            connection.execute("ALTER TABLE schema_migrations ADD COLUMN name TEXT")
        if "checksum" not in columns:
            connection.execute("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT")

    @staticmethod
    def _validate_applied_migration(
        connection: sqlite3.Connection, applied: sqlite3.Row, migration: Migration
    ) -> None:
        recorded_name = applied["name"]
        recorded_checksum = applied["checksum"]
        if recorded_name is not None and recorded_name != migration.name:
            raise RuntimeError(
                f"Applied migration {migration.version} name changed from "
                f"{recorded_name!r} to {migration.name!r}"
            )
        if recorded_checksum is not None and recorded_checksum != migration.checksum:
            raise RuntimeError(
                f"Applied migration {migration.version} checksum does not match the "
                "packaged migration"
            )
        if recorded_name is None or recorded_checksum is None:
            connection.execute(
                """
                UPDATE schema_migrations SET name = ?, checksum = ? WHERE version = ?
                """,
                (migration.name, migration.checksum, migration.version),
            )

    @staticmethod
    def _migration_inventory() -> list[Migration]:
        migration_root = resources.files("sangam.migrations")
        migrations: list[Migration] = []
        versions: dict[str, str] = {}
        for resource in sorted(migration_root.iterdir(), key=lambda item: item.name):
            if not resource.name.endswith(".sql"):
                continue
            matched = _MIGRATION_NAME.fullmatch(resource.name)
            if matched is None:
                raise RuntimeError(
                    f"Migration filename must match NNN_description.sql: {resource.name}"
                )
            version = matched.group("version")
            if previous := versions.get(version):
                raise RuntimeError(
                    f"Duplicate migration version {version}: {previous}, {resource.name}"
                )
            sql = resource.read_text(encoding="utf-8")
            versions[version] = resource.name
            migrations.append(
                Migration(
                    version=version,
                    name=resource.name,
                    sql=sql,
                    checksum=hashlib.sha256(sql.encode("utf-8")).hexdigest(),
                )
            )
        return migrations
