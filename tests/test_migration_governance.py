from __future__ import annotations

from pathlib import Path

import pytest

from sangam.db import Database


def _write_migration(root: Path, name: str, sql: str) -> None:
    root.mkdir(exist_ok=True)
    (root / name).write_text(sql, encoding="utf-8")


def test_duplicate_migration_versions_are_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    migrations = tmp_path / "migrations"
    _write_migration(migrations, "001_first.sql", "CREATE TABLE first(value TEXT);\n")
    _write_migration(migrations, "001_second.sql", "CREATE TABLE second(value TEXT);\n")
    monkeypatch.setattr("sangam.db.resources.files", lambda _package: migrations)

    with pytest.raises(RuntimeError, match="Duplicate migration version 001"):
        Database(tmp_path / "sangam.sqlite3").initialize()


def test_applied_migration_checksum_drift_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    migrations = tmp_path / "migrations"
    _write_migration(migrations, "001_initial.sql", "CREATE TABLE example(value TEXT);\n")
    monkeypatch.setattr("sangam.db.resources.files", lambda _package: migrations)
    database = Database(tmp_path / "sangam.sqlite3")
    database.initialize()

    _write_migration(
        migrations,
        "001_initial.sql",
        "CREATE TABLE example(value TEXT);\n-- historical file was modified\n",
    )

    with pytest.raises(RuntimeError, match="checksum does not match"):
        database.initialize()


def test_database_with_unknown_newer_migration_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    migrations = tmp_path / "migrations"
    _write_migration(migrations, "001_initial.sql", "CREATE TABLE example(value TEXT);\n")
    monkeypatch.setattr("sangam.db.resources.files", lambda _package: migrations)
    database = Database(tmp_path / "sangam.sqlite3")
    database.initialize()
    with database.transaction() as connection:
        connection.execute(
            """
            INSERT INTO schema_migrations(version, name, checksum, applied_at)
            VALUES ('999', '999_future.sql', 'future', '2026-07-22T00:00:00+00:00')
            """
        )

    with pytest.raises(RuntimeError, match="unknown migrations: 999"):
        database.initialize()


def test_legacy_migration_rows_are_backfilled_with_metadata(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    migrations = tmp_path / "migrations"
    _write_migration(migrations, "001_initial.sql", "CREATE TABLE example(value TEXT);\n")
    monkeypatch.setattr("sangam.db.resources.files", lambda _package: migrations)
    database = Database(tmp_path / "sangam.sqlite3")
    with database.connection() as connection:
        connection.execute(
            """
            CREATE TABLE schema_migrations (
                version TEXT PRIMARY KEY,
                applied_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES ('001', 'legacy')"
        )
        connection.execute("CREATE TABLE example(value TEXT)")

    database.initialize()

    with database.connection() as connection:
        row = connection.execute(
            "SELECT name, checksum FROM schema_migrations WHERE version = '001'"
        ).fetchone()
    assert row["name"] == "001_initial.sql"
    assert len(row["checksum"]) == 64
