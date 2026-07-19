from __future__ import annotations

import sqlite3
from importlib import resources
from pathlib import Path

import pytest

from sangam.db import Database


def test_initialize_is_idempotent(tmp_path: Path) -> None:
    database = Database(tmp_path / "nested" / "sangam.sqlite3")

    database.initialize()
    database.initialize()

    with database.connection() as connection:
        versions = connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        ).fetchall()
        indexes = {
            row["name"]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'index'"
            ).fetchall()
        }
    assert [row["version"] for row in versions] == [
        "001",
        "002",
        "003",
        "004",
        "005",
        "006",
        "007",
        "008",
    ]
    assert {
        "operation_events_revision_outcome_created_idx",
        "documents_deleted_updated_idx",
        "documents_category_idx",
        "document_trust_events_document_created_idx",
        "publication_events_publication_created_idx",
    } <= indexes


def test_failing_migration_rolls_back_the_whole_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    migrations = tmp_path / "migrations"
    migrations.mkdir()
    (migrations / "001_failing.sql").write_text(
        "CREATE TABLE partial_state(value TEXT);\n"
        "INSERT INTO partial_state(value) VALUES ('should roll back');\n"
        "THIS IS NOT SQL;\n",
        encoding="utf-8",
    )
    monkeypatch.setattr("sangam.db.resources.files", lambda _package: migrations)
    database = Database(tmp_path / "sangam.sqlite3")

    with pytest.raises(sqlite3.OperationalError):
        database.initialize()

    with database.connection() as connection:
        partial_table = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'partial_state'"
        ).fetchone()
        applied = connection.execute("SELECT version FROM schema_migrations").fetchall()
    assert partial_table is None
    assert applied == []


def test_publication_idempotency_migration_preserves_existing_keys(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    migration_source = resources.files("sangam.migrations")

    def stage_migrations(destination: Path, *, through: str) -> None:
        destination.mkdir()
        for migration in migration_source.iterdir():
            if migration.name.endswith(".sql") and migration.name.split("_", 1)[0] <= through:
                (destination / migration.name).write_text(
                    migration.read_text(encoding="utf-8"), encoding="utf-8"
                )

    phase_four_migrations = tmp_path / "phase-four-migrations"
    stage_migrations(phase_four_migrations, through="007")
    monkeypatch.setattr("sangam.db.resources.files", lambda _package: phase_four_migrations)
    database = Database(tmp_path / "sangam.sqlite3")
    database.initialize()
    created_at = "2026-07-18T12:00:00+00:00"
    with database.transaction() as connection:
        connection.execute(
            """
            INSERT INTO actors(actor_id, display_name, actor_type, identity_kind, created_at)
            VALUES ('human:test', 'Test Human', 'human', 'human', ?)
            """,
            (created_at,),
        )
        connection.execute(
            """
            INSERT INTO phase_four_idempotency_keys(
                actor_id, idempotency_key, operation, request_hash, resource_id, created_at
            ) VALUES ('human:test', 'existing-publication-key', 'publish', 'digest',
                'publication-id', ?)
            """,
            (created_at,),
        )

    current_migrations = tmp_path / "current-migrations"
    stage_migrations(current_migrations, through="008")
    monkeypatch.setattr("sangam.db.resources.files", lambda _package: current_migrations)
    database.initialize()

    with database.connection() as connection:
        migrated = connection.execute(
            """
            SELECT operation, request_hash, resource_type, resource_id, completed_at
            FROM mutation_idempotency_keys
            WHERE actor_id = 'human:test' AND idempotency_key = 'existing-publication-key'
            """
        ).fetchone()
        duplicate_table = connection.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'phase_four_idempotency_keys'
            """
        ).fetchone()
    assert tuple(migrated) == (
        "publish",
        "digest",
        "publication",
        "publication-id",
        created_at,
    )
    assert duplicate_table is None
