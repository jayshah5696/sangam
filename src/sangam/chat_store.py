from __future__ import annotations

from typing import TypeVar

from chatkit.store import Store
from chatkit.types import Attachment, Page, ThreadItem, ThreadMetadata
from pydantic import TypeAdapter

from sangam.db import Database, utc_now
from sangam.errors import NotFoundError

TContext = TypeVar("TContext")

_THREAD_ITEM_ADAPTER = TypeAdapter(ThreadItem)
_ATTACHMENT_ADAPTER = TypeAdapter(Attachment)


class SQLiteChatKitStore(Store[TContext]):
    """Owner-scoped ChatKit persistence backed by Sangam's canonical SQLite database."""

    def __init__(self, database: Database) -> None:
        self.database = database

    @staticmethod
    def _actor_id(context: TContext) -> str:
        return context.principal.actor_id  # type: ignore[attr-defined]

    @staticmethod
    def _document_id(context: TContext) -> str | None:
        return context.document_id  # type: ignore[attr-defined]

    def _require_thread_owner(self, thread_id: str, context: TContext) -> None:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT created_by FROM chat_threads WHERE thread_id = ?", (thread_id,)
            ).fetchone()
        if row is None or row["created_by"] != self._actor_id(context):
            raise NotFoundError(f"Chat thread not found: {thread_id}")

    async def load_thread(self, thread_id: str, context: TContext) -> ThreadMetadata:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT created_by, data_json FROM chat_threads WHERE thread_id = ?",
                (thread_id,),
            ).fetchone()
        if row is None or row["created_by"] != self._actor_id(context):
            raise NotFoundError(f"Chat thread not found: {thread_id}")
        return ThreadMetadata.model_validate_json(row["data_json"])

    async def save_thread(self, thread: ThreadMetadata, context: TContext) -> None:
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
                    stored.model_dump_json(),
                    thread.created_at.isoformat(),
                    now,
                ),
            )

    async def load_thread_items(
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
            data=[_THREAD_ITEM_ADAPTER.validate_json(row["data_json"]) for row in visible],
            has_more=has_more,
            after=visible[-1]["item_id"] if has_more and visible else None,
        )

    async def load_threads(
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
            data=[ThreadMetadata.model_validate_json(row["data_json"]) for row in visible],
            has_more=has_more,
            after=visible[-1]["thread_id"] if has_more and visible else None,
        )

    async def add_thread_item(self, thread_id: str, item: ThreadItem, context: TContext) -> None:
        await self.save_item(thread_id, item, context)

    async def save_item(self, thread_id: str, item: ThreadItem, context: TContext) -> None:
        self._require_thread_owner(thread_id, context)
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO chat_thread_items(item_id, thread_id, data_json, created_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(item_id) DO UPDATE SET data_json = excluded.data_json
                """,
                (item.id, thread_id, item.model_dump_json(), item.created_at.isoformat()),
            )
            connection.execute(
                "UPDATE chat_threads SET updated_at = ? WHERE thread_id = ?",
                (utc_now(), thread_id),
            )

    async def load_item(self, thread_id: str, item_id: str, context: TContext) -> ThreadItem:
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
        return _THREAD_ITEM_ADAPTER.validate_json(row["data_json"])

    async def delete_thread(self, thread_id: str, context: TContext) -> None:
        self._require_thread_owner(thread_id, context)
        with self.database.transaction() as connection:
            connection.execute("DELETE FROM chat_threads WHERE thread_id = ?", (thread_id,))

    async def delete_thread_item(self, thread_id: str, item_id: str, context: TContext) -> None:
        self._require_thread_owner(thread_id, context)
        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM chat_thread_items WHERE thread_id = ? AND item_id = ?",
                (thread_id, item_id),
            )

    async def save_attachment(self, attachment: Attachment, context: TContext) -> None:
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
                (attachment.id, self._actor_id(context), attachment.model_dump_json(), utc_now()),
            )

    async def load_attachment(self, attachment_id: str, context: TContext) -> Attachment:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT created_by, data_json FROM chat_attachments WHERE attachment_id = ?
                """,
                (attachment_id,),
            ).fetchone()
        if row is None or row["created_by"] != self._actor_id(context):
            raise NotFoundError(f"Chat attachment not found: {attachment_id}")
        return _ATTACHMENT_ADAPTER.validate_json(row["data_json"])

    async def delete_attachment(self, attachment_id: str, context: TContext) -> None:
        attachment = await self.load_attachment(attachment_id, context)
        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM chat_attachments WHERE attachment_id = ?", (attachment.id,)
            )
