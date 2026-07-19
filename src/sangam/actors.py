from __future__ import annotations

import sqlite3

from sangam.errors import ValidationError


class ActorService:
    """Validates actor references inside an existing database transaction."""

    @staticmethod
    def require_known(connection: sqlite3.Connection, actor_id: str) -> None:
        if not connection.execute(
            "SELECT 1 FROM actors WHERE actor_id = ?", (actor_id,)
        ).fetchone():
            raise ValidationError(f"Unknown actor: {actor_id}")
