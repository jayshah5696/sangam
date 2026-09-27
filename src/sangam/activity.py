from __future__ import annotations

import concurrent.futures
import json
import queue
import sqlite3
import threading
import uuid
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sangam.db import Database, utc_now
from sangam.errors import NotFoundError, ValidationError
from sangam.schemas import (
    ActivityActorSummary,
    ActivityBucket,
    ActivityDocumentSummary,
    ActivityOutcomeCounts,
    ActivityProblemAcknowledgement,
    ActivityProblemSummary,
    ActivityPublicationSummary,
    ActivitySummary,
    AgentAccessHealth,
    OperationEvent,
)
from sangam.security import Principal, sanitize_sensitive_data

EXPIRY_WARNING_DAYS = 7
RECENT_DENIED_DAYS = 1


@dataclass
class _AuditEventItem:
    row: tuple[
        str,
        str,
        str,
        str | None,
        str,
        str,
        str | None,
        str | None,
        str,
        str | None,
        str | None,
        str,
        str,
    ]
    size_bytes: int
    future: concurrent.futures.Future[None]


class ActivityService:
    """Stores safe, reviewable request outcomes without request bodies or credentials."""

    def __init__(
        self,
        database: Database,
        *,
        max_queue_items: int = 5000,
        max_queue_bytes: int = 16 * 1024 * 1024,
        max_batch_size: int = 250,
    ) -> None:
        self.database = database
        self.max_queue_items = max_queue_items
        self.max_queue_bytes = max_queue_bytes
        self.max_batch_size = max_batch_size
        self._queue: queue.Queue[_AuditEventItem] = queue.Queue()
        self._queue_bytes = 0
        self._queue_lock = threading.Lock()
        self._queue_not_full = threading.Condition(self._queue_lock)
        self._shutdown_event = threading.Event()
        self._worker_healthy = True
        self._worker_error: Exception | None = None
        self._worker_thread = threading.Thread(
            target=self._commit_worker_loop,
            name="sangam-audit-commit-worker",
            daemon=True,
        )
        self._worker_thread.start()

    def is_healthy(self) -> bool:
        return self._worker_healthy and (
            self._worker_thread is not None and self._worker_thread.is_alive()
        )

    def close(self, timeout: float = 5.0) -> None:
        self._shutdown_event.set()
        if self._worker_thread is not None and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=timeout)

    def _commit_worker_loop(self) -> None:
        connection: sqlite3.Connection | None = None
        try:
            connection = self.database.connect()
        except Exception as error:
            self._worker_healthy = False
            self._worker_error = error
            return

        try:
            while not self._shutdown_event.is_set():
                try:
                    item = self._queue.get(timeout=0.1)
                except queue.Empty:
                    continue

                batch = [item]
                while len(batch) < self.max_batch_size:
                    try:
                        batch.append(self._queue.get_nowait())
                    except queue.Empty:
                        break

                self._process_batch(connection, batch)
        finally:
            remaining: list[_AuditEventItem] = []
            while True:
                try:
                    remaining.append(self._queue.get_nowait())
                except queue.Empty:
                    break

            if remaining and connection is not None:
                for i in range(0, len(remaining), self.max_batch_size):
                    chunk = remaining[i : i + self.max_batch_size]
                    self._process_batch(connection, chunk)

            if connection is not None:
                with suppress(Exception):
                    connection.close()

    def _process_batch(self, connection: sqlite3.Connection, batch: list[_AuditEventItem]) -> None:
        try:
            connection.execute("BEGIN IMMEDIATE")
            connection.executemany(
                """
                INSERT INTO operation_events(
                    event_id, operation_id, actor_id, token_id, action, resource_type,
                    resource_id, path, outcome, error_code, revision_id,
                    detail_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [item.row for item in batch],
            )
            connection.commit()
            for item in batch:
                if not item.future.done():
                    item.future.set_result(None)
        except Exception as error:
            with suppress(Exception):
                connection.rollback()
            self._worker_healthy = False
            self._worker_error = error
            for item in batch:
                if not item.future.done():
                    item.future.set_exception(error)
        finally:
            batch_bytes = sum(item.size_bytes for item in batch)
            with self._queue_lock:
                self._queue_bytes = max(0, self._queue_bytes - batch_bytes)
                self._queue_not_full.notify_all()

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
            key: sanitize_sensitive_data(value)
            for key, value in (details or {}).items()
            if key
            in {
                "current_revision_id",
                "expected_revision_id",
                "current_metadata_version",
                "expected_metadata_version",
                "capability",
                "summary",
                "title",
                "source_path",
                "destination_path",
                "content_type",
                "category",
                "tag_ids",
                "patch",
                "patch_mode",
                "mode",
                "lines_added",
                "lines_removed",
                "diff",
            }
        }
        detail_json = json.dumps(safe_details, sort_keys=True)
        size_bytes = len(detail_json.encode("utf-8")) + 256
        row = (
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
            detail_json,
            utc_now(),
        )

        item = _AuditEventItem(
            row=row,
            size_bytes=size_bytes,
            future=concurrent.futures.Future(),
        )

        with self._queue_lock:
            while (
                self._queue.qsize() >= self.max_queue_items
                or (self._queue_bytes + size_bytes) > self.max_queue_bytes
            ):
                if self._shutdown_event.is_set():
                    raise RuntimeError("ActivityService is shutting down")
                if not self._worker_healthy:
                    raise RuntimeError(f"Audit commit worker is unhealthy: {self._worker_error}")
                if not self._queue_not_full.wait(timeout=10.0):
                    raise RuntimeError("Audit commit queue capacity exceeded")

            if not self._worker_healthy:
                raise RuntimeError(f"Audit commit worker is unhealthy: {self._worker_error}")
            self._queue_bytes += size_bytes
            self._queue.put(item)

        item.future.result(timeout=15.0)

    def acknowledge_problem(
        self, *, principal: Principal, event_id: str
    ) -> ActivityProblemAcknowledgement:
        now = utc_now()
        with self.database.transaction() as connection:
            event = connection.execute(
                "SELECT outcome FROM operation_events WHERE event_id = ?", (event_id,)
            ).fetchone()
            if event is None:
                raise NotFoundError(f"Activity event not found: {event_id}")
            if event["outcome"] not in {"denied", "conflict", "failed"}:
                raise ValidationError("Only events that need attention can be acknowledged")
            connection.execute(
                """
                INSERT INTO activity_problem_acknowledgements(
                    event_id, acknowledged_at, acknowledged_by
                ) VALUES (?, ?, ?)
                ON CONFLICT(event_id) DO UPDATE SET
                    acknowledged_at = excluded.acknowledged_at,
                    acknowledged_by = excluded.acknowledged_by
                """,
                (event_id, now, principal.actor_id),
            )
        return ActivityProblemAcknowledgement(
            event_id=event_id,
            acknowledged_at=now,
            acknowledged_by=principal.actor_id,
        )

    def restore_problem(self, *, event_id: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM activity_problem_acknowledgements WHERE event_id = ?", (event_id,)
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

    def export_json_lines(
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
    ) -> str:
        """Export audit events as a newline-delimited JSON (JSONL) string."""
        events = self.list_events(
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
            limit=limit,
            offset=offset,
        )
        lines = [json.dumps(event.model_dump(mode="json"), sort_keys=True) for event in events]
        return "\n".join(lines) + ("\n" if lines else "")

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
                WITH problem_groups AS (
                    SELECT CASE
                        WHEN e.outcome = 'denied' THEN 'access'
                        WHEN e.outcome = 'conflict' THEN 'conflict'
                        WHEN e.outcome = 'failed' AND e.resource_type = 'publication'
                            THEN 'publication'
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
                        COUNT(*) AS count, MIN(e.created_at) AS first_at,
                        MAX(e.created_at) AS latest_at, e.event_id AS latest_event_id
                    FROM operation_events e JOIN actors a ON a.actor_id = e.actor_id
                    LEFT JOIN actor_tokens t ON t.token_id = e.token_id
                    {where}{" AND" if where else "WHERE"}
                        e.outcome IN ('denied', 'conflict', 'failed')
                    GROUP BY category, e.actor_id, a.display_name, e.token_id, t.label,
                        e.action, e.resource_type, e.resource_id, e.path, e.error_code
                ), enriched AS (
                    SELECT problem_groups.*, acknowledgement.acknowledged_at,
                        acknowledgement.acknowledged_by,
                        acknowledgement.event_id IS NOT NULL AS acknowledged
                    FROM problem_groups
                    LEFT JOIN activity_problem_acknowledgements acknowledgement
                        ON acknowledgement.event_id = problem_groups.latest_event_id
                ), ranked AS (
                    SELECT enriched.*,
                        ROW_NUMBER() OVER (
                            PARTITION BY acknowledged ORDER BY latest_at DESC
                        ) AS state_rank,
                        COUNT(*) OVER (PARTITION BY acknowledged) AS state_count
                    FROM enriched
                )
                SELECT * FROM ranked WHERE state_rank <= ?
                ORDER BY acknowledged, latest_at DESC
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
            unacknowledged_denied_row = connection.execute(
                """
                WITH denied_groups AS (
                    SELECT e.event_id AS latest_event_id, MAX(e.created_at) AS latest_at
                    FROM operation_events e
                    WHERE e.outcome = 'denied' AND e.created_at >= ?
                    GROUP BY e.actor_id, e.token_id, e.action, e.resource_type,
                        e.resource_id, e.path, e.error_code
                )
                SELECT COUNT(*) AS count
                FROM denied_groups
                LEFT JOIN activity_problem_acknowledgements acknowledgement
                    ON acknowledgement.event_id = denied_groups.latest_event_id
                WHERE acknowledgement.event_id IS NULL
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
            attention_count=(health_row["expiring_soon_tokens"] or 0)
            + unacknowledged_denied_row["count"],
        )
        visible_problem_rows = [row for row in problem_rows if not row["acknowledged"]]
        acknowledged_problem_rows = [row for row in problem_rows if row["acknowledged"]]
        attention_count = visible_problem_rows[0]["state_count"] if visible_problem_rows else 0
        acknowledged_count = (
            acknowledged_problem_rows[0]["state_count"] if acknowledged_problem_rows else 0
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
                for row in visible_problem_rows[:list_limit]
            ],
            problems_truncated=attention_count > list_limit,
            acknowledged_problems=[
                ActivityProblemSummary.model_validate(dict(row))
                for row in acknowledged_problem_rows[:list_limit]
            ],
            acknowledged_problems_truncated=acknowledged_count > list_limit,
            attention_count=attention_count,
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
