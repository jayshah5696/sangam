from __future__ import annotations

import sqlite3
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
