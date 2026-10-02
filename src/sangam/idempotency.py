from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from sangam.conditions import conditional_fingerprint, validate_storage_condition
from sangam.db import Database, utc_now
from sangam.errors import IdempotencyError


def request_hash(payload: dict[str, Any]) -> str:
    conditional = conditional_fingerprint()
    if conditional is not None:
        return conditional
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class MutationRecord:
    resource_type: str
    resource_id: str
    completed_at: str | None


@dataclass(frozen=True)
class KeyRecord:
    """What one actor-scoped idempotency key already committed, in either table."""

    operation: str
    request_hash: str
    resource_id: str
    # Set for document revisions; resource mutations have no revision.
    revision_id: str | None
    completed: bool


class IdempotencyStore:
    """Maintains one actor-scoped key namespace across document and resource mutations."""

    def __init__(self, database: Database) -> None:
        self.database = database

    @staticmethod
    def lookup(connection: sqlite3.Connection, *, actor_id: str, key: str) -> KeyRecord | None:
        """Return the mutation this key already reserved or committed, if any."""
        row = connection.execute(
            """
            SELECT operation, request_hash, document_id AS resource_id, revision_id,
                1 AS completed
            FROM idempotency_keys WHERE actor_id = ? AND idempotency_key = ?
            UNION ALL
            SELECT operation, request_hash, resource_id, NULL AS revision_id,
                completed_at IS NOT NULL AS completed
            FROM mutation_idempotency_keys WHERE actor_id = ? AND idempotency_key = ?
            """,
            (actor_id, key, actor_id, key),
        ).fetchone()
        if row is None:
            return None
        return KeyRecord(
            operation=row["operation"],
            request_hash=row["request_hash"],
            resource_id=row["resource_id"],
            revision_id=row["revision_id"],
            completed=bool(row["completed"]),
        )

    def committed(self, *, actor_id: str, key: str, operation: str | None = None) -> bool:
        """Whether this key's mutation committed, optionally for one operation only."""
        with self.database.connection() as connection:
            record = self.lookup(connection, actor_id=actor_id, key=key)
        return (
            record is not None
            and record.completed
            and (operation is None or record.operation == operation)
        )

    @staticmethod
    def document_result(
        connection: sqlite3.Connection,
        *,
        actor_id: str,
        key: str,
        operation: str,
        request_hash: str,
    ) -> tuple[str, str] | None:
        """Return the (document, revision) a document write key already committed.

        A key reused for a different request is refused. When the key is new,
        any HTTP precondition bound to this request is evaluated on ``connection``.
        """
        IdempotencyStore.ensure_document_key_available(connection, actor_id=actor_id, key=key)
        row = connection.execute(
            """
            SELECT operation, request_hash, document_id, revision_id
            FROM idempotency_keys WHERE actor_id = ? AND idempotency_key = ?
            """,
            (actor_id, key),
        ).fetchone()
        if not row:
            validate_storage_condition(connection)
            return None
        if row["operation"] != operation or row["request_hash"] != request_hash:
            IdempotencyStore._raise_conflict(key)
        return row["document_id"], row["revision_id"]

    @staticmethod
    def record_document(
        connection: sqlite3.Connection,
        *,
        actor_id: str,
        key: str,
        operation: str,
        request_hash: str,
        document_id: str,
        revision_id: str,
    ) -> None:
        """Bind a document write key to the revision it committed, in the same transaction."""
        connection.execute(
            """
            INSERT INTO idempotency_keys(
                actor_id, idempotency_key, operation, request_hash,
                document_id, revision_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (actor_id, key, operation, request_hash, document_id, revision_id, utc_now()),
        )

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
            validate_storage_condition(connection)
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
