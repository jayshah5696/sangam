from __future__ import annotations

import concurrent.futures
import json
import sqlite3
import threading
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sangam.db import Database, utc_now
from sangam.errors import NotFoundError, ServiceUnavailableError, ValidationError
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


class AuditReservation:
    """Pre-admission ticket guaranteeing capacity in the audit commit ledger."""

    def __init__(self, service: ActivityService, estimated_bytes: int) -> None:
        self._service = service
        self._estimated_bytes = estimated_bytes
        self._transferred = False
        self._released = False

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
        try:
            self._service._record_with_reservation(
                reservation=self,
                principal=principal,
                action=action,
                resource_type=resource_type,
                outcome=outcome,
                resource_id=resource_id,
                path=path,
                error_code=error_code,
                revision_id=revision_id,
                details=details,
            )
        finally:
            self.release()

    def record_with_connection(
        self,
        connection: sqlite3.Connection,
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
        try:
            self._service.record_with_connection(
                connection,
                principal=principal,
                action=action,
                resource_type=resource_type,
                outcome=outcome,
                resource_id=resource_id,
                path=path,
                error_code=error_code,
                revision_id=revision_id,
                details=details,
            )
        finally:
            self.release()

    def release(self) -> None:
        if not self._transferred and not self._released:
            self._released = True
            self._service._release_reservation(self._estimated_bytes)

    def __enter__(self) -> AuditReservation:
        return self

    def __exit__(self, exc_type: object, exc_val: object, exc_tb: object) -> None:
        self.release()


class ActivityService:
    """Stores safe, reviewable request outcomes without request bodies or credentials."""

    def __init__(
        self,
        database: Database,
        *,
        max_queue_items: int = 5000,
        max_queue_bytes: int = 16 * 1024 * 1024,
        max_total_bytes: int | None = None,
        max_batch_size: int = 250,
    ) -> None:
        self.database = database
        self.max_queue_items = max_queue_items
        self.max_queue_bytes = max_queue_bytes
        self.max_total_bytes = (
            max_total_bytes if max_total_bytes is not None else max_queue_bytes * 2
        )
        self.max_batch_size = max_batch_size
        self._queue: list[_AuditEventItem] = []
        self._queue_bytes = 0
        self._admitted_items = 0
        self._admitted_bytes = 0
        self._committing_items = 0
        self._committing_bytes = 0
        self._active_producers = 0
        self._queue_lock = threading.Lock()
        self._queue_condition = threading.Condition(self._queue_lock)
        self._producers_done = threading.Condition(self._queue_lock)
        self._shutting_down = False
        self._uncertain_events: set[str] = set()
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

    def admit(self, estimated_bytes: int = 1024, timeout: float = 10.0) -> AuditReservation:
        start_time = time.monotonic()
        with self._queue_lock:
            while True:
                if self._shutting_down:
                    raise ServiceUnavailableError("Activity audit logging is shutting down")
                if not self._worker_healthy:
                    raise ServiceUnavailableError(
                        f"Audit persistence is unavailable: {self._worker_error}"
                    )

                has_capacity = self._admitted_items < self.max_queue_items and (
                    (self._admitted_bytes + estimated_bytes) <= self.max_total_bytes
                    or self._admitted_items == 0
                )
                if has_capacity:
                    self._admitted_items += 1
                    self._admitted_bytes += estimated_bytes
                    self._active_producers += 1
                    return AuditReservation(self, estimated_bytes=estimated_bytes)

                elapsed = time.monotonic() - start_time
                remaining = timeout - elapsed
                if remaining <= 0:
                    raise ServiceUnavailableError(
                        "Audit queue capacity exceeded: service overloaded"
                    )

                self._queue_condition.wait(remaining)

    def _persist_row_direct(self, row: tuple[object, ...]) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO operation_events(
                    event_id, operation_id, actor_id, token_id, action, resource_type,
                    resource_id, path, outcome, error_code, revision_id,
                    detail_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                row,
            )

    def _release_reservation(self, estimated_bytes: int) -> None:
        with self._queue_lock:
            self._admitted_items = max(0, self._admitted_items - 1)
            self._admitted_bytes = max(0, self._admitted_bytes - estimated_bytes)
            self._active_producers = max(0, self._active_producers - 1)
            if self._active_producers == 0:
                self._producers_done.notify_all()
            self._queue_condition.notify_all()

    def close(self, timeout: float = 35.0) -> None:
        deadline = time.monotonic() + timeout
        with self._queue_lock:
            self._shutting_down = True
            self._queue_condition.notify_all()

            while self._active_producers > 0:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._producers_done.wait(remaining)

        if self._worker_thread is not None and self._worker_thread.is_alive():
            with self._queue_lock:
                self._queue_condition.notify_all()
            remaining = max(1.0, deadline - time.monotonic())
            self._worker_thread.join(timeout=remaining)
            if self._worker_thread.is_alive():
                msg = (
                    "ActivityService shutdown timed out while worker was still "
                    "committing pending audit records"
                )
                raise RuntimeError(msg)

    def _commit_worker_loop(self) -> None:
        connection: sqlite3.Connection | None = None
        try:
            connection = self.database.connect()
        except Exception as error:
            self._worker_healthy = False
            self._worker_error = error
            return

        try:
            while True:
                batch: list[_AuditEventItem] = []
                with self._queue_lock:
                    while not self._queue:
                        if self._shutting_down and self._active_producers == 0:
                            return
                        self._queue_condition.wait(timeout=0.1)

                    drain_count = min(len(self._queue), self.max_batch_size)
                    batch = self._queue[:drain_count]
                    del self._queue[:drain_count]
                    batch_bytes = sum(item.size_bytes for item in batch)
                    self._queue_bytes = max(0, self._queue_bytes - batch_bytes)
                    self._committing_items = len(batch)
                    self._committing_bytes = batch_bytes

                if batch:
                    self._process_batch(connection, batch)
        finally:
            remaining: list[_AuditEventItem] = []
            with self._queue_lock:
                remaining = list(self._queue)
                self._queue.clear()

            if remaining and connection is not None:
                for i in range(0, len(remaining), self.max_batch_size):
                    chunk = remaining[i : i + self.max_batch_size]
                    self._process_batch(connection, chunk)

            if connection is not None:
                with suppress(Exception):
                    connection.close()

    @staticmethod
    def _is_recoverable_error(error: Exception) -> bool:
        if isinstance(error, sqlite3.OperationalError):
            msg = str(error).lower()
            if "busy" in msg or "locked" in msg:
                return True
        return False

    @staticmethod
    def _is_terminal_error(error: Exception) -> bool:
        if isinstance(error, sqlite3.DatabaseError):
            msg = str(error).lower()
            if "malformed" in msg or "corrupt" in msg or "not a database" in msg:
                return True
        return isinstance(error, (OSError, MemoryError))

    def _process_batch(self, connection: sqlite3.Connection, batch: list[_AuditEventItem]) -> None:
        max_retries = 5
        base_delay = 0.05
        last_error: Exception | None = None

        for attempt in range(max_retries):
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
                self._worker_healthy = True
                self._worker_error = None
                for item in batch:
                    if not item.future.done():
                        item.future.set_result(None)
                last_error = None
                break
            except Exception as error:
                with suppress(Exception):
                    connection.rollback()
                last_error = error

                if self._is_recoverable_error(error) and attempt < max_retries - 1:
                    time.sleep(base_delay * (2**attempt))
                    continue
                break

        if last_error is not None:
            self._worker_healthy = False
            self._worker_error = last_error

            for item in batch:
                if not item.future.done():
                    item.future.set_exception(last_error)

        batch_bytes = sum(item.size_bytes for item in batch)
        with self._queue_lock:
            self._committing_items = max(0, self._committing_items - len(batch))
            self._committing_bytes = max(0, self._committing_bytes - batch_bytes)
            self._queue_condition.notify_all()

    def _prepare_event_row(
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
    ) -> tuple[tuple[object, ...], int]:
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
        return row, size_bytes

    def record_with_connection(
        self,
        connection: sqlite3.Connection,
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
        row, _ = self._prepare_event_row(
            principal=principal,
            action=action,
            resource_type=resource_type,
            outcome=outcome,
            resource_id=resource_id,
            path=path,
            error_code=error_code,
            revision_id=revision_id,
            details=details,
        )
        connection.execute(
            """
            INSERT INTO operation_events(
                event_id, operation_id, actor_id, token_id, action, resource_type,
                resource_id, path, outcome, error_code, revision_id,
                detail_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            row,
        )

    def _estimate_payload_bytes(self, details: dict[str, object] | None) -> int:
        if not details:
            return 512
        size = 512
        for k, v in details.items():
            size += len(str(k).encode("utf-8")) + 16
            if isinstance(v, str):
                size += len(v.encode("utf-8"))
            elif isinstance(v, (bytes, bytearray)):
                size += len(v)
            elif isinstance(v, (list, tuple)):
                size += sum(len(str(x).encode("utf-8")) + 16 for x in v) + 32
            elif isinstance(v, dict):
                size += sum(
                    len(str(dk).encode("utf-8")) + len(str(dv).encode("utf-8")) + 32
                    for dk, dv in v.items()
                )
            else:
                size += 64
        return size

    def _record_with_reservation(
        self,
        *,
        reservation: AuditReservation,
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
        estimated_payload_size = self._estimate_payload_bytes(details)
        expansion = max(0, estimated_payload_size - reservation._estimated_bytes)
        deadline = time.monotonic() + 60.0

        with self._queue_lock:
            while (
                (
                    self._queue_bytes + self._committing_bytes + estimated_payload_size
                    > self.max_queue_bytes
                    or self._admitted_bytes + expansion > self.max_total_bytes
                )
                and (len(self._queue) > 0 or self._committing_items > 0)
            ):
                if not self._worker_healthy:
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._queue_condition.wait(min(remaining, 0.1))

        row, size_bytes = self._prepare_event_row(
            principal=principal,
            action=action,
            resource_type=resource_type,
            outcome=outcome,
            resource_id=resource_id,
            path=path,
            error_code=error_code,
            revision_id=revision_id,
            details=details,
        )

        item = _AuditEventItem(
            row=row,
            size_bytes=size_bytes,
            future=concurrent.futures.Future(),
        )

        with self._queue_lock:
            can_queue = self._worker_healthy and (
                self._queue_bytes + self._committing_bytes + size_bytes <= self.max_queue_bytes
                or (len(self._queue) == 0 and self._committing_items == 0)
            )
            if can_queue:
                self._admitted_bytes = max(
                    0, self._admitted_bytes - reservation._estimated_bytes
                )
                self._admitted_items = max(0, self._admitted_items - 1)
                self._queue.append(item)
                self._queue_bytes += size_bytes
                self._active_producers = max(0, self._active_producers - 1)
                reservation._transferred = True
                if self._active_producers == 0:
                    self._producers_done.notify_all()
                self._queue_condition.notify_all()

        if not can_queue:
            self._persist_row_direct(row)
            return

        try:
            item.future.result(timeout=60.0)
        except concurrent.futures.TimeoutError as err:
            with self._queue_lock:
                self._uncertain_events.add(row[0])
            raise ServiceUnavailableError(
                f"Audit event commit timed out; write outcome is uncertain (event_id={row[0]})"
            ) from err

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
        with self.admit() as reservation:
            reservation.record(
                principal=principal,
                action=action,
                resource_type=resource_type,
                outcome=outcome,
                resource_id=resource_id,
                path=path,
                error_code=error_code,
                revision_id=revision_id,
                details=details,
            )

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
