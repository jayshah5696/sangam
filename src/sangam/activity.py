from __future__ import annotations

import json
import uuid

from sangam.db import Database, utc_now
from sangam.schemas import OperationEvent
from sangam.security import Principal


class ActivityService:
    """Stores safe, reviewable request outcomes without request bodies or credentials."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def record(
        self,
        *,
        principal: Principal,
        action: str,
        resource_type: str,
        outcome: str,
        resource_id: str | None = None,
        path: str | None = None,
        error_code: str | None = None,
        revision_id: str | None = None,
        details: dict[str, object] | None = None,
    ) -> None:
        safe_details = {
            key: value
            for key, value in (details or {}).items()
            if key
            in {
                "current_revision_id",
                "expected_revision_id",
                "current_metadata_version",
                "expected_metadata_version",
                "capability",
            }
        }
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO operation_events(
                    event_id, operation_id, actor_id, token_id, action, resource_type,
                    resource_id, path, outcome, error_code, revision_id,
                    detail_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    principal.operation_id,
                    principal.actor_id,
                    principal.token_id,
                    action,
                    resource_type,
                    resource_id,
                    path,
                    outcome,
                    error_code,
                    revision_id,
                    json.dumps(safe_details, sort_keys=True),
                    utc_now(),
                ),
            )

    def list_events(
        self,
        *,
        actor_id: str | None = None,
        actor_kind: str | None = None,
        outcome: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[OperationEvent]:
        conditions: list[str] = []
        parameters: list[object] = []
        if actor_id:
            conditions.append("e.actor_id = ?")
            parameters.append(actor_id)
        if actor_kind:
            conditions.append("a.identity_kind = ?")
            parameters.append(actor_kind)
        if outcome:
            conditions.append("e.outcome = ?")
            parameters.append(outcome)
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        parameters.extend((limit, offset))
        with self.database.connection() as connection:
            rows = connection.execute(
                f"""
                SELECT e.*, a.display_name AS actor_display_name,
                    a.identity_kind AS actor_kind, t.label AS token_label
                FROM operation_events e
                JOIN actors a ON a.actor_id = e.actor_id
                LEFT JOIN actor_tokens t ON t.token_id = e.token_id
                {where}
                ORDER BY e.created_at DESC, e.event_id DESC
                LIMIT ? OFFSET ?
                """,
                parameters,
            ).fetchall()
        return [
            OperationEvent(
                event_id=row["event_id"],
                operation_id=row["operation_id"],
                actor_id=row["actor_id"],
                actor_display_name=row["actor_display_name"],
                actor_kind=row["actor_kind"],
                token_id=row["token_id"],
                token_label=row["token_label"],
                action=row["action"],
                resource_type=row["resource_type"],
                resource_id=row["resource_id"],
                path=row["path"],
                outcome=row["outcome"],
                error_code=row["error_code"],
                revision_id=row["revision_id"],
                details=json.loads(row["detail_json"]),
                created_at=row["created_at"],
            )
            for row in rows
        ]
