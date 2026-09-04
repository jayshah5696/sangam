from __future__ import annotations

import json
import uuid
from datetime import UTC, datetime, timedelta

from sangam.db import Database, utc_now
from sangam.errors import ValidationError
from sangam.schemas import (
    ActivityActorSummary,
    ActivityBucket,
    ActivityDocumentSummary,
    ActivityOutcomeCounts,
    ActivityProblemSummary,
    ActivityPublicationSummary,
    ActivitySummary,
    AgentAccessHealth,
    OperationEvent,
)
from sangam.security import Principal

EXPIRY_WARNING_DAYS = 7
RECENT_DENIED_DAYS = 1


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
        token_id: str | None = None,
        action: str | None = None,
        resource_type: str | None = None,
        resource_id: str | None = None,
        path: str | None = None,
        error_code: str | None = None,
        operation_id: str | None = None,
        attention: bool = False,
        since: str | None = None,
        until: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[OperationEvent]:
        conditions, parameters = self._filters(
            actor_id=actor_id,
            actor_kind=actor_kind,
            outcome=outcome,
            token_id=token_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            path=path,
            error_code=error_code,
            operation_id=operation_id,
            attention=attention,
            since=since,
            until=until,
        )
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

    def summarize(
        self,
        *,
        actor_id: str | None = None,
        actor_kind: str | None = None,
        outcome: str | None = None,
        token_id: str | None = None,
        action: str | None = None,
        resource_type: str | None = None,
        resource_id: str | None = None,
        path: str | None = None,
        error_code: str | None = None,
        operation_id: str | None = None,
        attention: bool = False,
        since: str | None = None,
        until: str | None = None,
    ) -> ActivitySummary:
        conditions, parameters = self._filters(
            actor_id=actor_id,
            actor_kind=actor_kind,
            outcome=outcome,
            token_id=token_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            path=path,
            error_code=error_code,
            operation_id=operation_id,
            attention=attention,
            since=since,
            until=until,
        )
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        change_actions = "'create','update','move','tag','delete','restore'"
        list_limit = 10
        normalized_since = self._normalize_boundary(since, name="since")
        normalized_until = self._normalize_boundary(until, name="until")
        bucket_format = (
            "%Y-%m-%dT%H:00:00Z"
            if self._use_hourly_buckets(normalized_since, normalized_until)
            else "%Y-%m-%dT00:00:00Z"
        )
        with self.database.connection() as connection:
            counts_row = connection.execute(
                f"""
                SELECT COUNT(*) AS total, COUNT(DISTINCT e.operation_id) AS operations,
                    COUNT(DISTINCT e.actor_id) AS active_actors,
                    COALESCE(SUM(e.outcome = 'accepted'), 0) AS accepted,
                    COALESCE(SUM(e.outcome = 'denied'), 0) AS denied,
                    COALESCE(SUM(e.outcome = 'conflict'), 0) AS conflict,
                    COALESCE(SUM(e.outcome = 'failed'), 0) AS failed
                FROM operation_events e JOIN actors a ON a.actor_id = e.actor_id
                {where}
                """,
                parameters,
            ).fetchone()
            bucket_rows = connection.execute(
                f"""
                SELECT strftime(?, e.created_at) AS bucket,
                    SUM(e.outcome = 'accepted') AS accepted,
                    SUM(e.outcome = 'denied') AS denied,
                    SUM(e.outcome = 'conflict') AS conflict,
                    SUM(e.outcome = 'failed') AS failed
                FROM operation_events e JOIN actors a ON a.actor_id = e.actor_id
                {where} GROUP BY bucket ORDER BY bucket LIMIT 120
                """,
                [bucket_format, *parameters],
            ).fetchall()
            actor_rows = connection.execute(
                f"""
                SELECT e.actor_id, a.display_name AS actor_display_name,
                    SUM(e.outcome = 'accepted'
                        AND e.resource_type = 'document'
                        AND e.action IN ({change_actions})) AS accepted_changes,
                    SUM(e.outcome = 'accepted'
                        AND e.resource_type = 'document'
                        AND e.action LIKE 'read%') AS reads,
                    SUM(e.outcome = 'denied') AS denied,
                    SUM(e.outcome = 'conflict') AS conflict,
                    SUM(e.outcome = 'failed') AS failed,
                    MAX(e.created_at) AS last_activity_at
                FROM operation_events e JOIN actors a ON a.actor_id = e.actor_id
                {where} GROUP BY e.actor_id, a.display_name
                ORDER BY accepted_changes + reads + denied + conflict + failed DESC,
                    last_activity_at DESC
                LIMIT ?
                """,
                [*parameters, list_limit + 1],
            ).fetchall()

            def document_rows(metric: str) -> list[object]:
                metric_condition = {
                    "changed": f"e.outcome = 'accepted' AND e.action IN ({change_actions})",
                    "read": "e.outcome = 'accepted' AND e.action LIKE 'read%'",
                    "problem": "e.outcome IN ('denied', 'conflict', 'failed')",
                }[metric]
                return connection.execute(
                    f"""
                    SELECT e.resource_id AS document_id, d.title, d.path AS current_path,
                        MAX(e.path) AS historical_path, COUNT(*) AS count
                    FROM operation_events e JOIN actors a ON a.actor_id = e.actor_id
                    LEFT JOIN documents d ON d.document_id = e.resource_id
                    {where}{" AND" if where else "WHERE"} e.resource_type = 'document'
                        AND e.resource_id IS NOT NULL AND {metric_condition}
                    GROUP BY e.resource_id, d.title, d.path
                    ORDER BY count DESC, MAX(e.created_at) DESC LIMIT ?
                    """,
                    [*parameters, list_limit + 1],
                ).fetchall()

            changed_rows = document_rows("changed")
            read_rows = document_rows("read")
            problem_document_rows = document_rows("problem")
            publication_rows = connection.execute(
                f"""
                SELECT e.resource_id AS publication_id, p.document_id, d.title AS document_title,
                    p.slug, p.active, p.access_policy, e.actor_id, e.action, e.outcome, e.created_at
                FROM operation_events e JOIN actors a ON a.actor_id = e.actor_id
                LEFT JOIN publications p
                    ON p.publication_id = e.resource_id OR p.document_id = e.resource_id
                LEFT JOIN documents d ON d.document_id = p.document_id
                {where}{" AND" if where else "WHERE"} e.resource_type = 'publication'
                ORDER BY e.created_at DESC, e.event_id DESC LIMIT ?
                """,
                [*parameters, list_limit + 1],
            ).fetchall()
            problem_rows = connection.execute(
                f"""
                SELECT CASE
                    WHEN e.outcome = 'denied' THEN 'access'
                    WHEN e.outcome = 'conflict' THEN 'conflict'
                    WHEN e.outcome = 'failed' AND e.resource_type = 'publication' THEN 'publication'
                    ELSE 'failure' END AS category,
                    e.actor_id, a.display_name AS actor_display_name, e.token_id,
                    t.label AS token_label, e.action, e.resource_type, e.resource_id,
                    e.path, e.error_code,
                    MAX(json_extract(e.detail_json, '$.capability')) AS capability,
                    MAX(json_extract(
                        e.detail_json, '$.current_revision_id'
                    )) AS current_revision_id,
                    MAX(json_extract(
                        e.detail_json, '$.expected_revision_id'
                    )) AS expected_revision_id,
                    COUNT(*) AS count, MIN(e.created_at) AS first_at, MAX(e.created_at) AS latest_at
                FROM operation_events e JOIN actors a ON a.actor_id = e.actor_id
                LEFT JOIN actor_tokens t ON t.token_id = e.token_id
                {where}{" AND" if where else "WHERE"} e.outcome IN ('denied', 'conflict', 'failed')
                GROUP BY category, e.actor_id, a.display_name, e.token_id, t.label, e.action,
                    e.resource_type, e.resource_id, e.path, e.error_code
                ORDER BY latest_at DESC LIMIT ?
                """,
                [*parameters, list_limit + 1],
            ).fetchall()
            now = datetime.now(UTC)
            warning_end = (
                (now + timedelta(days=EXPIRY_WARNING_DAYS)).isoformat().replace("+00:00", "Z")
            )
            now_text = now.isoformat().replace("+00:00", "Z")
            health_row = connection.execute(
                """
                SELECT SUM(revoked_at IS NULL
                        AND (expires_at IS NULL OR expires_at > ?)) AS active_tokens,
                    SUM(revoked_at IS NULL AND expires_at IS NOT NULL
                        AND expires_at <= ?) AS expired_tokens,
                    SUM(revoked_at IS NULL AND expires_at > ?
                        AND expires_at <= ?) AS expiring_soon_tokens
                FROM actor_tokens
                """,
                (now_text, now_text, now_text, warning_end),
            ).fetchone()
            denied_row = connection.execute(
                """
                SELECT COUNT(*) AS count, MAX(created_at) AS latest
                FROM operation_events WHERE outcome = 'denied' AND created_at >= ?
                """,
                ((now - timedelta(days=RECENT_DENIED_DAYS)).isoformat().replace("+00:00", "Z"),),
            ).fetchone()
            latest_row = connection.execute(
                """
                SELECT MAX(created_at) AS latest
                FROM operation_events WHERE actor_id LIKE 'agent:%'
                """
            ).fetchone()

        def documents(rows: list[object]) -> list[ActivityDocumentSummary]:
            return [ActivityDocumentSummary.model_validate(dict(row)) for row in rows[:list_limit]]

        health = AgentAccessHealth(
            active_tokens=health_row["active_tokens"] or 0,
            expired_tokens=health_row["expired_tokens"] or 0,
            expiring_soon_tokens=health_row["expiring_soon_tokens"] or 0,
            recent_denied=denied_row["count"],
            latest_activity_at=latest_row["latest"],
            attention_count=(health_row["expiring_soon_tokens"] or 0) + denied_row["count"],
        )
        return ActivitySummary(
            counts=ActivityOutcomeCounts(**dict(counts_row)),
            buckets=[
                ActivityBucket(
                    start=row["bucket"],
                    **{key: row[key] or 0 for key in ("accepted", "denied", "conflict", "failed")},
                )
                for row in bucket_rows
            ],
            actors=[
                ActivityActorSummary.model_validate(dict(row)) for row in actor_rows[:list_limit]
            ],
            actors_truncated=len(actor_rows) > list_limit,
            changed_documents=documents(changed_rows),
            read_documents=documents(read_rows),
            problem_documents=documents(problem_document_rows),
            documents_truncated=any(
                len(rows) > list_limit for rows in (changed_rows, read_rows, problem_document_rows)
            ),
            publications=[
                ActivityPublicationSummary.model_validate(dict(row))
                for row in publication_rows[:list_limit]
            ],
            publications_truncated=len(publication_rows) > list_limit,
            problems=[
                ActivityProblemSummary.model_validate(dict(row))
                for row in problem_rows[:list_limit]
            ],
            problems_truncated=len(problem_rows) > list_limit,
            access_health=health,
        )

    def _filters(
        self,
        *,
        actor_id: str | None,
        actor_kind: str | None,
        outcome: str | None,
        token_id: str | None,
        action: str | None,
        resource_type: str | None,
        resource_id: str | None,
        path: str | None,
        error_code: str | None,
        operation_id: str | None,
        attention: bool,
        since: str | None,
        until: str | None,
    ) -> tuple[list[str], list[object]]:
        conditions: list[str] = []
        parameters: list[object] = []
        for column, value in (
            ("e.actor_id", actor_id),
            ("a.identity_kind", actor_kind),
            ("e.outcome", outcome),
            ("e.token_id", token_id),
            ("e.action", action),
            ("e.resource_type", resource_type),
            ("e.resource_id", resource_id),
            ("e.error_code", error_code),
            ("e.operation_id", operation_id),
        ):
            if value:
                conditions.append(f"{column} = ?")
                parameters.append(value)
        if path:
            conditions.append("e.path LIKE ? ESCAPE '\\'")
            escaped = path.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            parameters.append(f"%{escaped}%")
        if attention:
            conditions.append("e.outcome != 'accepted'")
        normalized_since = self._normalize_boundary(since, name="since")
        normalized_until = self._normalize_boundary(until, name="until")
        if normalized_since and normalized_until and normalized_since > normalized_until:
            raise ValidationError("Activity start must not be after its end")
        if normalized_since:
            conditions.append("e.created_at >= ?")
            parameters.append(normalized_since)
        if normalized_until:
            conditions.append("e.created_at <= ?")
            parameters.append(normalized_until)
        return conditions, parameters

    @staticmethod
    def _use_hourly_buckets(since: str | None, until: str | None) -> bool:
        if since is None or until is None:
            return False
        start = datetime.fromisoformat(since.replace("Z", "+00:00"))
        end = datetime.fromisoformat(until.replace("Z", "+00:00"))
        return end - start <= timedelta(days=2)

    @staticmethod
    def _normalize_boundary(value: str | None, *, name: str) -> str | None:
        if value is None:
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValidationError(f"Activity {name} must be an ISO 8601 timestamp") from error
        if parsed.tzinfo is None:
            raise ValidationError(f"Activity {name} must include a timezone")
        return parsed.astimezone(UTC).isoformat(timespec="microseconds")
