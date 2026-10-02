"""Named workspace searches that every device of the workspace owner can reopen."""

from __future__ import annotations

import sqlite3
import uuid

from sangam.access import Audited, writes
from sangam.authorization import AuthorizationPolicy
from sangam.db import Database, utc_now
from sangam.errors import NotFoundError, ValidationError, validate_metadata_text
from sangam.schemas import SavedView, SaveView, SearchFilters
from sangam.security import Principal


class SavedViewService:
    def __init__(self, *, database: Database, audited: Audited) -> None:
        self.database = database
        self._audited = audited

    def list(self, principal: Principal) -> list[SavedView]:
        AuthorizationPolicy.require_administrator(principal)
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM saved_views ORDER BY updated_at DESC, view_id"
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def save(self, principal: Principal, body: SaveView) -> SavedView:
        """Create a view, or replace the filters of the view with the same name."""
        AuthorizationPolicy.require_administrator(principal)
        name = validate_metadata_text(body.name.strip(), "Saved view name")
        if not name:
            raise ValidationError("Saved view name cannot be blank")
        filters = body.filters.model_copy(update={"query": body.filters.query.strip()})
        return self._audited(
            principal,
            writes("save_view", "saved_view"),
            lambda: self._save(principal, name, filters),
        )

    def _save(self, principal: Principal, name: str, filters: SearchFilters) -> SavedView:
        now = utc_now()
        with self.database.transaction() as connection:
            existing = connection.execute(
                "SELECT view_id FROM saved_views WHERE name = ?", (name,)
            ).fetchone()
            view_id = existing["view_id"] if existing else str(uuid.uuid4())
            connection.execute(
                """
                INSERT INTO saved_views(
                    view_id, name, filters_json, created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(view_id) DO UPDATE SET
                    name = excluded.name,
                    filters_json = excluded.filters_json,
                    updated_at = excluded.updated_at
                """,
                (view_id, name, filters.model_dump_json(), principal.actor_id, now, now),
            )
            self.database.set_audit_target(
                resource_id=view_id, details={"name": name, "replaced": existing is not None}
            )
            row = connection.execute(
                "SELECT * FROM saved_views WHERE view_id = ?", (view_id,)
            ).fetchone()
        return self._from_row(row)

    def delete(self, principal: Principal, view_id: str) -> None:
        AuthorizationPolicy.require_administrator(principal)
        self._audited(
            principal,
            writes("delete_view", "saved_view"),
            lambda: self._delete(view_id),
            resource_id=view_id,
        )

    def _delete(self, view_id: str) -> None:
        with self.database.transaction() as connection:
            deleted = connection.execute(
                "DELETE FROM saved_views WHERE view_id = ? RETURNING name", (view_id,)
            ).fetchone()
            if deleted is None:
                raise NotFoundError(f"Saved view not found: {view_id}")
            self.database.set_audit_target(resource_id=view_id, details={"name": deleted["name"]})

    @staticmethod
    def _from_row(row: sqlite3.Row) -> SavedView:
        return SavedView(
            view_id=row["view_id"],
            name=row["name"],
            filters=SearchFilters.model_validate_json(row["filters_json"]),
            created_by=row["created_by"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )
