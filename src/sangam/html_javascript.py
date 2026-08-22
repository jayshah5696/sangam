from __future__ import annotations

from sangam.db import Database, utc_now
from sangam.errors import ConflictError
from sangam.schemas import HtmlJavascriptSettings


class HtmlJavascriptSettingsService:
    """Owns the workspace policy for executing saved HTML revisions."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def get(self) -> HtmlJavascriptSettings:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT enabled, version, updated_by, updated_at
                FROM html_javascript_settings WHERE id = 1
                """
            ).fetchone()
        if row is None:
            raise RuntimeError("HTML JavaScript settings were not initialized")
        return HtmlJavascriptSettings(
            enabled=bool(row["enabled"]),
            version=row["version"],
            updated_by=row["updated_by"],
            updated_at=row["updated_at"],
        )

    def update(
        self, *, expected_version: int, enabled: bool, actor_id: str
    ) -> HtmlJavascriptSettings:
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE html_javascript_settings
                SET enabled = ?, version = version + 1, updated_by = ?, updated_at = ?
                WHERE id = 1 AND version = ?
                """,
                (int(enabled), actor_id, utc_now(), expected_version),
            )
            if cursor.rowcount != 1:
                current = connection.execute(
                    "SELECT version FROM html_javascript_settings WHERE id = 1"
                ).fetchone()
                raise ConflictError(
                    "HTML JavaScript settings changed in another session",
                    details={
                        "expected_version": expected_version,
                        "current_version": current["version"] if current else None,
                    },
                )
        return self.get()
