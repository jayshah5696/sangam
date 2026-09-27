from __future__ import annotations

import asyncio
import concurrent.futures
import contextlib
import json
from collections.abc import Callable
from typing import Any, Protocol, TypeVar

from chatkit.store import Store
from chatkit.types import Attachment, Page, ThreadItem, ThreadMetadata
from pydantic import TypeAdapter

from sangam.db import Database, utc_now
from sangam.errors import IntegrationError, NotFoundError, ServiceUnavailableError
from sangam.security import Principal


class OwnerContext(Protocol):
    @property
    def principal(self) -> Principal: ...

    @property
    def document_id(self) -> str | None: ...


TContext = TypeVar("TContext", bound=OwnerContext)
T = TypeVar("T")

_THREAD_ITEM_ADAPTER = TypeAdapter(ThreadItem)
_ATTACHMENT_ADAPTER = TypeAdapter(Attachment)
_CHAT_PAYLOAD_VERSION = 1


class BoundedThreadRunner:
    """Limits concurrent and queued thread executions, holding capacity until worker finishes."""

    def __init__(self, max_concurrency: int = 32, max_waiting: int = 64) -> None:
        self.max_concurrency = max_concurrency
        self.max_waiting = max_waiting
        self._active_workers = 0
        self._waiting_count = 0
        self._shutting_down = False
        self._active_futures: set[concurrent.futures.Future[Any]] = set()
        self._cond: asyncio.Condition | None = None
        self._executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=max_concurrency,
            thread_name_prefix="sangam-chat-store",
        )

    def _get_cond(self) -> asyncio.Condition:
        if self._cond is None:
            self._cond = asyncio.Condition()
        return self._cond

    async def run(self, func: Callable[..., T], *args: Any) -> T:
        cond = self._get_cond()
        async with cond:
            if self._shutting_down:
                raise ServiceUnavailableError("Chat persistence is shutting down")
            if self._waiting_count >= self.max_waiting:
                raise ServiceUnavailableError("Chat persistence queue limit exceeded")
            self._waiting_count += 1
            try:
                while self._active_workers >= self.max_concurrency:
                    if self._shutting_down:
                        raise ServiceUnavailableError("Chat persistence is shutting down")
                    await cond.wait()
                if self._shutting_down:
                    raise ServiceUnavailableError("Chat persistence is shutting down")
                self._active_workers += 1
            finally:
                self._waiting_count -= 1

        loop = asyncio.get_running_loop()

        def on_done(f: concurrent.futures.Future[Any]) -> None:
            def _cleanup() -> None:
                async def _coro() -> None:
                    c = self._get_cond()
                    async with c:
                        self._active_futures.discard(f)
                        self._active_workers = max(0, self._active_workers - 1)
                        c.notify_all()

                if not loop.is_closed():
                    asyncio.create_task(_coro())

            with contextlib.suppress(RuntimeError):
                loop.call_soon_threadsafe(_cleanup)

        async with cond:
            if self._shutting_down:
                self._active_workers = max(0, self._active_workers - 1)
                cond.notify_all()
                raise ServiceUnavailableError("Chat persistence is shutting down")

            try:
                fut = self._executor.submit(func, *args)
            except Exception:
                self._active_workers = max(0, self._active_workers - 1)
                cond.notify_all()
                raise

            self._active_futures.add(fut)
            fut.add_done_callback(on_done)

        return await asyncio.wrap_future(fut)

    async def close(self, timeout: float = 35.0) -> None:
        cond = self._get_cond()
        async with cond:
            self._shutting_down = True
            cond.notify_all()

        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        try:
            async with cond:
                while (self._active_futures or self._active_workers > 0) and loop.time() < deadline:
                    remaining = deadline - loop.time()
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(cond.wait(), timeout=min(remaining, 0.05))

                if self._active_futures or self._active_workers > 0:
                    remaining = len(self._active_futures)
                    raise RuntimeError(
                        f"ChatKitStore shutdown timed out with {remaining} operations "
                        f"and {self._active_workers} active workers still committing"
                    )
        finally:
            self._executor.shutdown(wait=False)


class SQLiteChatKitStore(Store[TContext]):
    """Owner-scoped ChatKit persistence backed by Sangam's canonical SQLite database."""

    def __init__(
        self,
        database: Database,
        *,
        max_concurrency: int = 32,
        max_waiting: int = 64,
    ) -> None:
        self.database = database
        self._runner = BoundedThreadRunner(max_concurrency=max_concurrency, max_waiting=max_waiting)

    async def _run_bounded(self, func: Callable[..., T], *args: Any) -> T:
        return await self._runner.run(func, *args)

    async def close(self, timeout: float = 35.0) -> None:
        await self._runner.close(timeout=timeout)

    @staticmethod
    def _actor_id(context: TContext) -> str:
        return context.principal.actor_id

    @staticmethod
    def _document_id(context: TContext) -> str | None:
        return context.document_id

    def _require_thread_owner(self, thread_id: str, context: TContext) -> None:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT created_by FROM chat_threads WHERE thread_id = ?", (thread_id,)
            ).fetchone()
        if row is None or row["created_by"] != self._actor_id(context):
            raise NotFoundError(f"Chat thread not found: {thread_id}")

    def _load_thread_sync(self, thread_id: str, context: TContext) -> ThreadMetadata:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT created_by, data_json FROM chat_threads WHERE thread_id = ?",
                (thread_id,),
            ).fetchone()
        if row is None or row["created_by"] != self._actor_id(context):
            raise NotFoundError(f"Chat thread not found: {thread_id}")
        return ThreadMetadata.model_validate(_decode_payload(row["data_json"]))

    async def load_thread(self, thread_id: str, context: TContext) -> ThreadMetadata:
        return await self._run_bounded(self._load_thread_sync, thread_id, context)

    def _save_thread_sync(self, thread: ThreadMetadata, context: TContext) -> None:
        now = utc_now()
        metadata = dict(thread.metadata)
        document_id = self._document_id(context) or metadata.get("document_id")
        if document_id:
            metadata["document_id"] = document_id
        stored = thread.model_copy(update={"metadata": metadata})
        with self.database.transaction() as connection:
            existing = connection.execute(
                "SELECT created_by FROM chat_threads WHERE thread_id = ?", (thread.id,)
            ).fetchone()
            if existing is not None and existing["created_by"] != self._actor_id(context):
                raise NotFoundError(f"Chat thread not found: {thread.id}")
            connection.execute(
                """
                INSERT INTO chat_threads(
                    thread_id, created_by, document_id, data_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(thread_id) DO UPDATE SET
                    document_id = COALESCE(excluded.document_id, chat_threads.document_id),
                    data_json = excluded.data_json,
                    updated_at = excluded.updated_at
                """,
                (
                    thread.id,
                    self._actor_id(context),
                    document_id,
                    _encode_payload(stored),
                    thread.created_at.isoformat(),
                    now,
                ),
            )

    async def save_thread(self, thread: ThreadMetadata, context: TContext) -> None:
        await self._run_bounded(self._save_thread_sync, thread, context)

    def _load_thread_items_sync(
        self,
        thread_id: str,
        after: str | None,
        limit: int,
        order: str,
        context: TContext,
    ) -> Page[ThreadItem]:
        self._require_thread_owner(thread_id, context)
        direction = "ASC" if order == "asc" else "DESC"
        params: list[object] = [thread_id]
        cursor = ""
        if after:
            with self.database.connection() as connection:
                after_row = connection.execute(
                    """
                    SELECT created_at, item_id FROM chat_thread_items
                    WHERE thread_id = ? AND item_id = ?
                    """,
                    (thread_id, after),
                ).fetchone()
            if after_row is None:
                raise NotFoundError(f"Chat item not found: {after}")
            operator = ">" if order == "asc" else "<"
            cursor = f"AND (created_at, item_id) {operator} (?, ?)"
            params.extend((after_row["created_at"], after_row["item_id"]))
        params.append(limit + 1)
        with self.database.connection() as connection:
            rows = connection.execute(
                f"""
                SELECT item_id, data_json FROM chat_thread_items
                WHERE thread_id = ? {cursor}
                ORDER BY created_at {direction}, item_id {direction}
                LIMIT ?
                """,
                params,
            ).fetchall()
        has_more = len(rows) > limit
        visible = rows[:limit]
        return Page(
            data=[
                _THREAD_ITEM_ADAPTER.validate_python(_decode_payload(row["data_json"]))
                for row in visible
            ],
            has_more=has_more,
            after=visible[-1]["item_id"] if has_more and visible else None,
        )

    async def load_thread_items(
        self,
        thread_id: str,
        after: str | None,
        limit: int,
        order: str,
        context: TContext,
    ) -> Page[ThreadItem]:
        return await self._run_bounded(
            self._load_thread_items_sync, thread_id, after, limit, order, context
        )

    def _load_threads_sync(
        self,
        limit: int,
        after: str | None,
        order: str,
        context: TContext,
    ) -> Page[ThreadMetadata]:
        direction = "ASC" if order == "asc" else "DESC"
        params: list[object] = [self._actor_id(context)]
        cursor = ""
        if after:
            with self.database.connection() as connection:
                after_row = connection.execute(
                    """
                    SELECT updated_at, thread_id FROM chat_threads
                    WHERE created_by = ? AND thread_id = ?
                    """,
                    (self._actor_id(context), after),
                ).fetchone()
            if after_row is None:
                raise NotFoundError(f"Chat thread not found: {after}")
            operator = ">" if order == "asc" else "<"
            cursor = f"AND (updated_at, thread_id) {operator} (?, ?)"
            params.extend((after_row["updated_at"], after_row["thread_id"]))
        params.append(limit + 1)
        with self.database.connection() as connection:
            rows = connection.execute(
                f"""
                SELECT thread_id, data_json FROM chat_threads
                WHERE created_by = ? {cursor}
                ORDER BY updated_at {direction}, thread_id {direction}
                LIMIT ?
                """,
                params,
            ).fetchall()
        has_more = len(rows) > limit
        visible = rows[:limit]
        return Page(
            data=[
                ThreadMetadata.model_validate(_decode_payload(row["data_json"])) for row in visible
            ],
            has_more=has_more,
            after=visible[-1]["thread_id"] if has_more and visible else None,
        )

    async def load_threads(
        self,
        limit: int,
        after: str | None,
        order: str,
        context: TContext,
    ) -> Page[ThreadMetadata]:
        return await self._run_bounded(self._load_threads_sync, limit, after, order, context)

    async def add_thread_item(self, thread_id: str, item: ThreadItem, context: TContext) -> None:
        await self.save_item(thread_id, item, context)

    def _save_item_sync(self, thread_id: str, item: ThreadItem, context: TContext) -> None:
        self._require_thread_owner(thread_id, context)
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO chat_thread_items(item_id, thread_id, data_json, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(item_id) DO UPDATE SET data_json = excluded.data_json
                """,
                (item.id, thread_id, _encode_payload(item), item.created_at.isoformat()),
            )
            connection.execute(
                "UPDATE chat_threads SET updated_at = ? WHERE thread_id = ?",
                (utc_now(), thread_id),
            )

    async def save_item(self, thread_id: str, item: ThreadItem, context: TContext) -> None:
        await self._run_bounded(self._save_item_sync, thread_id, item, context)

    def _load_item_sync(self, thread_id: str, item_id: str, context: TContext) -> ThreadItem:
        self._require_thread_owner(thread_id, context)
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT data_json FROM chat_thread_items
                WHERE thread_id = ? AND item_id = ?
                """,
                (thread_id, item_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Chat item not found: {item_id}")
        return _THREAD_ITEM_ADAPTER.validate_python(_decode_payload(row["data_json"]))

    async def load_item(self, thread_id: str, item_id: str, context: TContext) -> ThreadItem:
        return await self._run_bounded(self._load_item_sync, thread_id, item_id, context)

    def _delete_thread_sync(self, thread_id: str, context: TContext) -> None:
        self._require_thread_owner(thread_id, context)
        with self.database.transaction() as connection:
            connection.execute("DELETE FROM chat_threads WHERE thread_id = ?", (thread_id,))

    async def delete_thread(self, thread_id: str, context: TContext) -> None:
        await self._run_bounded(self._delete_thread_sync, thread_id, context)

    def _delete_thread_item_sync(self, thread_id: str, item_id: str, context: TContext) -> None:
        self._require_thread_owner(thread_id, context)
        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM chat_thread_items WHERE thread_id = ? AND item_id = ?",
                (thread_id, item_id),
            )

    async def delete_thread_item(self, thread_id: str, item_id: str, context: TContext) -> None:
        await self._run_bounded(self._delete_thread_item_sync, thread_id, item_id, context)

    def _save_attachment_sync(self, attachment: Attachment, context: TContext) -> None:
        with self.database.transaction() as connection:
            existing = connection.execute(
                "SELECT created_by FROM chat_attachments WHERE attachment_id = ?",
                (attachment.id,),
            ).fetchone()
            if existing is not None and existing["created_by"] != self._actor_id(context):
                raise NotFoundError(f"Chat attachment not found: {attachment.id}")
            connection.execute(
                """
                INSERT INTO chat_attachments(attachment_id, created_by, data_json, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(attachment_id) DO UPDATE SET data_json = excluded.data_json
                """,
                (attachment.id, self._actor_id(context), _encode_payload(attachment), utc_now()),
            )

    async def save_attachment(self, attachment: Attachment, context: TContext) -> None:
        await self._run_bounded(self._save_attachment_sync, attachment, context)

    def _load_attachment_sync(self, attachment_id: str, context: TContext) -> Attachment:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT created_by, data_json FROM chat_attachments WHERE attachment_id = ?
                """,
                (attachment_id,),
            ).fetchone()
        if row is None or row["created_by"] != self._actor_id(context):
            raise NotFoundError(f"Chat attachment not found: {attachment_id}")
        return _ATTACHMENT_ADAPTER.validate_python(_decode_payload(row["data_json"]))

    async def load_attachment(self, attachment_id: str, context: TContext) -> Attachment:
        return await self._run_bounded(self._load_attachment_sync, attachment_id, context)

    def _delete_attachment_sync(self, attachment_id: str, context: TContext) -> None:
        attachment = self._load_attachment_sync(attachment_id, context)
        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM chat_attachments WHERE attachment_id = ?", (attachment.id,)
            )

    async def delete_attachment(self, attachment_id: str, context: TContext) -> None:
        await self._run_bounded(self._delete_attachment_sync, attachment_id, context)


def _encode_payload(value: Any) -> str:
    dumped = value.model_dump(mode="json") if hasattr(value, "model_dump") else value
    return json.dumps(
        {
            "schema_version": _CHAT_PAYLOAD_VERSION,
            "payload": dumped,
        },
        separators=(",", ":"),
    )


def _decode_payload(value: str) -> object:
    try:
        decoded = json.loads(value)
    except ValueError as error:
        raise IntegrationError("Stored ChatKit payload is not valid JSON") from error
    if not isinstance(decoded, dict) or "schema_version" not in decoded:
        return decoded
    if decoded.get("schema_version") != _CHAT_PAYLOAD_VERSION or "payload" not in decoded:
        raise IntegrationError(
            "Stored ChatKit payload uses an unsupported schema version",
            details={"schema_version": decoded.get("schema_version")},
        )
    return decoded["payload"]
