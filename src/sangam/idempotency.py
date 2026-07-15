from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from sangam.db import Database, utc_now
from sangam.errors import IdempotencyError


def request_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class MutationRecord:
    resource_type: str
    resource_id: str
    completed_at: str | None


class IdempotencyStore:
    """Maintains one actor-scoped key namespace across document and resource mutations."""

    def __init__(self, database: Database) -> None:
        self.database = database

    @staticmethod
    def ensure_document_key_available(
        connection: sqlite3.Connection, *, actor_id: str, key: str
    ) -> None:
        row = connection.execute(
            """
            SELECT 1 FROM mutation_idempotency_keys
            WHERE actor_id = ? AND idempotency_key = ?
            """,
            (actor_id, key),
        ).fetchone()
        if row:
            IdempotencyStore._raise_conflict(key)

    @staticmethod
    def mutation_record(
        connection: sqlite3.Connection,
        *,
        actor_id: str,
        key: str,
        operation: str,
        request_hash: str,
    ) -> MutationRecord | None:
        document_key = connection.execute(
            """
            SELECT 1 FROM idempotency_keys
            WHERE actor_id = ? AND idempotency_key = ?
            """,
            (actor_id, key),
        ).fetchone()
        if document_key:
            IdempotencyStore._raise_conflict(key)
        row = connection.execute(
            """
            SELECT operation, request_hash, resource_type, resource_id, completed_at
            FROM mutation_idempotency_keys
            WHERE actor_id = ? AND idempotency_key = ?
            """,
            (actor_id, key),
        ).fetchone()
        if row and (row["operation"] != operation or row["request_hash"] != request_hash):
            IdempotencyStore._raise_conflict(key)
        if row is None:
            return None
        return MutationRecord(
            resource_type=row["resource_type"],
            resource_id=row["resource_id"],
            completed_at=row["completed_at"],
        )

    @staticmethod
    def record_mutation(
        connection: sqlite3.Connection,
        *,
        actor_id: str,
        key: str,
        operation: str,
        request_hash: str,
        resource_type: str,
        resource_id: str,
        completed: bool = True,
    ) -> None:
        now = utc_now()
        connection.execute(
            """
            INSERT INTO mutation_idempotency_keys(
                actor_id, idempotency_key, operation, request_hash,
                resource_type, resource_id, completed_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                actor_id,
                key,
                operation,
                request_hash,
                resource_type,
                resource_id,
                now if completed else None,
                now,
            ),
        )

    def complete_mutation(self, *, actor_id: str, key: str, resource_id: str) -> None:
        with self.database.transaction() as connection:
            updated = connection.execute(
                """
                UPDATE mutation_idempotency_keys
                SET completed_at = ?
                WHERE actor_id = ? AND idempotency_key = ? AND resource_id = ?
                """,
                (utc_now(), actor_id, key, resource_id),
            )
            if updated.rowcount != 1:
                raise RuntimeError("Mutation idempotency reservation could not be completed")

    @staticmethod
    def _raise_conflict(key: str) -> None:
        raise IdempotencyError(
            "Idempotency key was already used for a different mutation",
            details={"idempotency_key": key},
        )
