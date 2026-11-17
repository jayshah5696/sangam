"""Server-owned chat turns with stable identities, bounded waits, and no inference replay."""

import asyncio
import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import quote
from uuid import uuid4

from chatkit.server import StreamingResult
from chatkit.types import (
    AssistantMessageItem,
    ErrorEvent,
    ThreadItemDoneEvent,
    ThreadMetadata,
    ThreadStreamEvent,
    UserMessageItem,
)
from pydantic import BaseModel, JsonValue, TypeAdapter

from sangam.access import reads, writes
from sangam.capabilities import Capability
from sangam.chat import SangamChatServer
from sangam.chat_context import ChatRequestContext
from sangam.chat_runtime import ChatAdmissionLease
from sangam.config import Settings
from sangam.db import utc_now
from sangam.errors import ConflictError, NotFoundError, ValidationError
from sangam.idempotency import request_hash
from sangam.mcp_models import (
    AssistantOperation,
    CancelAssistant,
    GetAssistant,
    ReadConversation,
    SubmitAssistant,
    WaitAssistant,
)
from sangam.security import IdentityService, Principal

logger = logging.getLogger(__name__)
_EVENT: TypeAdapter[ThreadStreamEvent] = TypeAdapter(ThreadStreamEvent)
_JSON = TypeAdapter(dict[str, JsonValue])


class ProposalReference(BaseModel):
    proposal_id: str
    document_id: str
    status: str
    applied_revision_id: str | None


class EffectReference(BaseModel):
    effect_id: str
    capability_id: str
    status: str
    resource_type: str | None
    resource_id: str | None
    revision_id: str | None


class AssistantResult(BaseModel):
    request_key: str
    conversation_id: str
    status: Literal[
        "running",
        "completed",
        "needs_review",
        "failed",
        "cancelled",
        "interrupted",
        "result_expired",
    ]
    run_id: str | None
    answer: str | None
    next_offset: int | None
    error: str | None
    proposals: list[ProposalReference]
    effects: list[EffectReference]
    artifacts_truncated: bool
    resource_uri: str
    check_operation: Literal["assistant.wait"] = "assistant.wait"
    poll_after_seconds: int = 1
    message: str


class ConversationItem(BaseModel):
    item_id: str
    role: Literal["user", "assistant"]
    text: str
    offset: int
    next_offset: int | None


class ConversationPage(BaseModel):
    conversation_id: str
    items: list[ConversationItem]
    next_cursor: str | None


class AssistantRequests:
    def __init__(
        self, chat: SangamChatServer, identity: IdentityService, settings: Settings
    ) -> None:
        self.chat, self.identity, self.settings = chat, identity, settings
        self.database = chat.evidence.database
        self.tasks: dict[tuple[str, str], asyncio.Task[None]] = {}
        self.accepting: set[asyncio.Task[AssistantResult]] = set()
        self.closing = False

    def authority(self, principal: Principal, *, inference: bool = False) -> Principal:
        current = self.identity.reauthorize(principal)
        if inference:
            self.chat.workspace.policy.require(current, Capability.INFERENCE, None)
        return current

    def authorize_conversation(self, principal: Principal, conversation_id: str) -> None:
        """A known actor-owned thread can contain more sources than its opening document."""
        self.chat.continuity.authorize(principal, conversation_id)
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT document_id FROM chat_turn_contexts "
                "WHERE thread_id=? AND document_id IS NOT NULL "
                "UNION SELECT s.document_id FROM chat_run_sources s "
                "JOIN chat_runs r ON r.run_id=s.run_id WHERE r.thread_id=? "
                "UNION SELECT document_id FROM chat_proposals WHERE thread_id=? "
                "UNION SELECT r.document_id FROM chat_skill_reads s "
                "JOIN chat_turn_contexts c ON c.context_id=s.context_id "
                "JOIN revisions r ON r.revision_id IN (s.revision_id, s.resource_revision_id) "
                "WHERE c.thread_id=?",
                (conversation_id, conversation_id, conversation_id, conversation_id),
            ).fetchall()
            truncated = connection.execute(
                "SELECT 1 FROM chat_runs WHERE thread_id=? AND sources_truncated=1 LIMIT 1",
                (conversation_id,),
            ).fetchone()
        if truncated:
            # An incomplete source inventory cannot prove a narrowed read grant is sufficient.
            self.chat.workspace.policy.require(principal, Capability.READ, None)
        for row in rows:
            document = self.chat.workspace.documents.get_document(
                row["document_id"], include_deleted=True
            )
            self.chat.workspace.policy.require(principal, Capability.READ, document.path)

    def authorize(self, principal: Principal, request_key: str) -> None:
        principal = self.authority(principal)
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT conversation_id, document_id FROM assistant_requests "
                "WHERE actor_id=? AND request_key=?",
                (principal.actor_id, request_key),
            ).fetchone()
            thread = (
                connection.execute(
                    "SELECT 1 FROM chat_threads WHERE thread_id=?", (row["conversation_id"],)
                ).fetchone()
                if row
                else None
            )
        if row is None:
            raise NotFoundError("Assistant request not found.")
        if row["document_id"]:
            document = self.chat.workspace.documents.get_document(
                row["document_id"], include_deleted=True
            )
            self.chat.workspace.policy.require(principal, Capability.READ, document.path)
        if thread:
            self.authorize_conversation(principal, row["conversation_id"])

    def bind(
        self,
        principal: Principal,
        execution_key: str | None,
        reference: str,
        kind: Literal["request", "conversation"] = "request",
    ) -> None:
        if execution_key:
            with self.database.transaction() as connection:
                connection.execute(
                    "INSERT OR IGNORE INTO mcp_execution_chat_refs VALUES (?, ?, ?, ?)",
                    (principal.actor_id, execution_key, kind, reference),
                )

    def get(self, principal: Principal, query: GetAssistant) -> AssistantResult:
        return self.chat.workspace.audited(
            principal,
            reads("read", "assistant_request"),
            lambda: self._get(principal, query),
            resource_id=query.request_key,
        )

    def _get(self, principal: Principal, query: GetAssistant) -> AssistantResult:
        self.authorize(principal, query.request_key)
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM assistant_requests WHERE actor_id=? AND request_key=?",
                (principal.actor_id, query.request_key),
            ).fetchone()
            run = connection.execute(
                "SELECT run_id FROM chat_runs WHERE thread_id=? AND user_item_id=? "
                "ORDER BY started_at DESC LIMIT 1",
                (row["conversation_id"], row["user_item_id"]),
            ).fetchone()
            run_id = run["run_id"] if run else None
            proposals = connection.execute(
                "SELECT proposal_id,document_id,status,applied_revision_id "
                "FROM chat_proposals WHERE run_id=? LIMIT 21",
                (run_id,),
            ).fetchall()
            effects = connection.execute(
                "SELECT effect_id,capability_id,status,resource_type,resource_id "
                ",COALESCE(json_extract(result_json,'$.current_revision_id'), "
                "json_extract(result_json,'$.revision_id')) AS revision_id "
                "FROM chat_effects WHERE run_id=? LIMIT 21",
                (run_id,),
            ).fetchall()
            review = connection.execute(
                "SELECT 1 FROM chat_proposals WHERE run_id=? AND status IN ('pending','stale') "
                "UNION SELECT 1 FROM chat_effects WHERE run_id=? AND status IN "
                "('proposed','pending_approval','approved','executing') LIMIT 1",
                (run_id, run_id),
            ).fetchone()
            failed_effect = connection.execute(
                "SELECT 1 FROM chat_effects WHERE run_id=? AND status='failed' LIMIT 1", (run_id,)
            ).fetchone()
        status = row["status"]
        error = row["error"]
        answer = row["answer"]
        if row["finished_at"] and datetime.fromisoformat(row["finished_at"]) < datetime.now(
            UTC
        ) - timedelta(days=self.settings.mcp_result_retention_days):
            answer = None
        if status == "completed":
            if failed_effect:
                status, error = (
                    "failed",
                    "An assistant action failed. Inspect its effect reference.",
                )
            elif review:
                status = "needs_review"
            elif answer is None:
                status = "result_expired"
        end = query.offset + query.length
        message = {
            "running": "Assistant work is running. Check assistant.wait before reporting success. "
            "Do not resubmit.",
            "completed": "The assistant turn finished. Inspect saved revision/effect references "
            "before claiming a requested change was applied.",
            "needs_review": "The turn finished but a proposal or effect still needs review. "
            "The requested change is not confirmed as applied.",
            "failed": "Assistant work failed. Inspect known effects before deciding what work "
            "remains. Do not resubmit automatically.",
            "cancelled": "Cancellation settled. Previously committed changes remain. "
            "Inspect their references.",
            "interrupted": "The server interrupted this request. Inspect saved artifacts. "
            "Inference was not replayed.",
            "result_expired": "Answer retention expired. "
            "The request identity and artifact references remain.",
        }[status]
        return AssistantResult(
            request_key=query.request_key,
            conversation_id=row["conversation_id"],
            status=status,
            run_id=run_id,
            answer=answer[query.offset : end] if answer is not None else None,
            next_offset=end if answer is not None and end < len(answer) else None,
            error=error,
            proposals=[ProposalReference.model_validate(dict(item)) for item in proposals[:20]],
            effects=[EffectReference.model_validate(dict(item)) for item in effects[:20]],
            artifacts_truncated=len(proposals) > 20 or len(effects) > 20,
            resource_uri=f"sangam://assistant/{quote(query.request_key, safe='')}",
            message=message,
        )

    def preflight(self, principal: Principal, query: SubmitAssistant) -> None:
        if not query.message.strip():
            raise ValidationError("Assistant messages cannot be blank.")
        self.request_body(query, query.conversation_id or "thr_" + "0" * 32)
        runtime = self.chat.runtime_config()
        if not runtime.inference_enabled:
            raise ValidationError(runtime.message)
        if query.revision_id and not query.document_id:
            raise ValidationError("An exact revision requires an explicit document.")
        if query.document_id:
            document = self.chat.workspace.get_document(principal, query.document_id)
            if query.revision_id:
                self.chat.workspace.get_revision(principal, document.document_id, query.revision_id)
        if query.conversation_id:
            self.authorize_conversation(principal, query.conversation_id)

    def request_body(self, query: SubmitAssistant, conversation_id: str) -> bytes:
        body = json.dumps(
            {
                "type": "threads.add_user_message",
                "params": {
                    "thread_id": conversation_id,
                    "input": {
                        "content": [{"type": "input_text", "text": query.message}],
                        "attachments": [],
                        "inference_options": {},
                    },
                },
            }
        ).encode()
        if len(body) > self.chat.config.max_request_bytes:
            raise ValidationError("Assistant request exceeds the configured chat byte limit.")
        return body

    async def submit(
        self, principal: Principal, query: SubmitAssistant, execution_key: str | None
    ) -> AssistantResult:
        task = asyncio.create_task(self.accept(principal, query, execution_key))
        self.accepting.add(task)
        task.add_done_callback(self.accepted)
        # A disconnected execute does not abandon a committed acceptance record.
        return await asyncio.shield(task)

    def accepted(self, task: asyncio.Task[AssistantResult]) -> None:
        self.accepting.discard(task)
        # Retrieve errors even when the MCP caller disconnected during acceptance.
        if not task.cancelled() and (error := task.exception()) is not None:
            logger.info("Assistant acceptance failed (%s)", type(error).__name__)

    async def accept(
        self, principal: Principal, query: SubmitAssistant, execution_key: str | None
    ) -> AssistantResult:
        principal = await asyncio.to_thread(self.authority, principal, inference=True)
        fingerprint = request_hash(query.model_dump(exclude={"request_key", "wait_seconds"}))

        def previous() -> bool:
            with self.database.connection() as connection:
                row = connection.execute(
                    "SELECT request_hash FROM assistant_requests "
                    "WHERE actor_id=? AND request_key=?",
                    (principal.actor_id, query.request_key),
                ).fetchone()
            if row and row["request_hash"] != fingerprint:
                raise ConflictError("Assistant request key was used for different arguments.")
            return row is not None

        if await asyncio.to_thread(previous):
            await asyncio.to_thread(self.bind, principal, execution_key, query.request_key)
            return await self.wait(
                principal,
                WaitAssistant(request_key=query.request_key, wait_seconds=query.wait_seconds),
            )
        if self.closing:
            raise ValidationError("Assistant requests are shutting down. Retry the same key later.")
        await asyncio.to_thread(self.preflight, principal, query)
        lease = await self.chat.admission.acquire()
        if self.closing:
            await lease.release()
            raise ValidationError("Assistant requests are shutting down. Retry the same key later.")
        conversation_id = query.conversation_id or f"thr_{uuid4().hex}"

        def reserve() -> bool:
            with self.database.transaction() as connection:
                if previous():
                    self.bind(principal, execution_key, query.request_key)
                    return False
                if connection.execute(
                    "SELECT 1 FROM assistant_requests WHERE conversation_id=? AND status='running'",
                    (conversation_id,),
                ).fetchone():
                    raise ConflictError(
                        "This conversation already has a running assistant request."
                    )
                count = connection.execute(
                    "SELECT count(*) FROM assistant_requests WHERE actor_id=?",
                    (principal.actor_id,),
                ).fetchone()[0]
                if count >= self.settings.mcp_max_executions_per_actor:
                    raise ValidationError(
                        "Assistant request receipt quota reached. Existing identities are retained."
                    )
                connection.execute(
                    "INSERT INTO assistant_requests "
                    "(actor_id,request_key,request_hash,conversation_id,"
                    "document_id,status,created_at) "
                    "VALUES (?,?,?,?,?,'running',?)",
                    (
                        principal.actor_id,
                        query.request_key,
                        fingerprint,
                        conversation_id,
                        query.document_id,
                        utc_now(),
                    ),
                )
                self.bind(principal, execution_key, query.request_key)
                return True

        try:
            created = await asyncio.to_thread(
                self.chat.workspace.audited,
                principal,
                writes("submit", "assistant_request"),
                reserve,
                resource_id=query.request_key,
            )
            if created:
                task = asyncio.create_task(self.run(principal, query, conversation_id, lease))
                self.tasks[principal.actor_id, query.request_key] = task
                task.add_done_callback(
                    lambda _task: self.tasks.pop((principal.actor_id, query.request_key), None)
                )
            else:
                await lease.release()
        except BaseException:
            await lease.release()
            raise
        return await self.wait(
            principal, WaitAssistant(request_key=query.request_key, wait_seconds=query.wait_seconds)
        )

    def finish(
        self, principal: Principal, key: str, status: str, answer: str, error: str | None
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE assistant_requests SET status=?,answer=?,error=?,finished_at=? "
                "WHERE actor_id=? AND request_key=?",
                (status, answer, error, utc_now(), principal.actor_id, key),
            )

    async def run(
        self,
        principal: Principal,
        query: SubmitAssistant,
        conversation_id: str,
        lease: ChatAdmissionLease,
    ) -> None:
        answer: list[str] = []
        status, error = "completed", None
        try:
            principal = await asyncio.to_thread(self.authority, principal, inference=True)
            if query.conversation_id:
                await asyncio.to_thread(
                    self.authorize_conversation, principal, query.conversation_id
                )
            context = ChatRequestContext(
                principal=principal,
                document_id=query.document_id,
                requested_revision_id=query.revision_id,
                workspace_context=query.document_id is None,
            )
            if query.conversation_id is None:
                await self.chat.store.save_thread(
                    ThreadMetadata(id=conversation_id, created_at=datetime.now(UTC)), context
                )
            request = self.request_body(query, conversation_id)
            async with asyncio.timeout(self.chat.config.timeout_seconds):
                response = await self.chat.process(request, context)
                if not isinstance(response, StreamingResult):
                    raise ValidationError("The assistant did not return a turn stream.")
                async for frame in response:
                    event = _EVENT.validate_json(frame.removeprefix(b"data: ").strip())
                    if isinstance(event, ErrorEvent):
                        status, error = (
                            "failed",
                            "The assistant turn failed. Inspect its run reference.",
                        )
                    elif isinstance(event, ThreadItemDoneEvent):
                        if isinstance(event.item, UserMessageItem):
                            await asyncio.to_thread(
                                self.attach_item, principal, query.request_key, event.item.id
                            )
                        elif isinstance(event.item, AssistantMessageItem):
                            answer.append("".join(part.text for part in event.item.content))
        except asyncio.CancelledError:
            status = "interrupted" if self.closing else "cancelled"
        except Exception as failure:  # noqa: BLE001 - Persist every provider/stream failure as a terminal job.
            status, error = (
                "failed",
                "Assistant request failed. Inspect its run and saved artifact references.",
            )
            logger.warning(
                "Assistant request %s failed (%s)", query.request_key, type(failure).__name__
            )
        finally:
            try:
                await self.chat.admission.run_sync(
                    self.finish, principal, query.request_key, status, "\n".join(answer), error
                )
            finally:
                await lease.release()

    def attach_item(self, principal: Principal, key: str, item_id: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE assistant_requests SET user_item_id=? WHERE actor_id=? AND request_key=?",
                (item_id, principal.actor_id, key),
            )

    async def wait(self, principal: Principal, query: WaitAssistant) -> AssistantResult:
        await asyncio.to_thread(self.authorize, principal, query.request_key)
        task = self.tasks.get((principal.actor_id, query.request_key))
        if task and query.wait_seconds:
            # asyncio.wait observes the task without transferring cancellation ownership.
            await asyncio.wait({task}, timeout=query.wait_seconds)
        return await asyncio.to_thread(self.get, principal, query)

    async def conversation(self, principal: Principal, query: ReadConversation) -> ConversationPage:
        principal = await asyncio.to_thread(self.authority, principal)
        await asyncio.to_thread(self.authorize_conversation, principal, query.conversation_id)
        context = ChatRequestContext(principal=principal)
        if query.item_id:
            items = [await self.chat.store.load_item(query.conversation_id, query.item_id, context)]
            cursor = None
        else:
            page = await self.chat.store.load_thread_items(
                query.conversation_id, query.cursor, query.limit, "asc", context
            )
            items, cursor = page.data, page.after
        messages = []
        for item in items:
            if isinstance(item, (UserMessageItem, AssistantMessageItem)):
                text = "".join(part.text for part in item.content)
                end = query.offset + 1200
                messages.append(
                    ConversationItem(
                        item_id=item.id,
                        role="user" if isinstance(item, UserMessageItem) else "assistant",
                        text=text[query.offset : end],
                        offset=query.offset,
                        next_offset=end if end < len(text) else None,
                    )
                )
            elif query.item_id:
                raise NotFoundError("This conversation item is not a readable message.")
        principal = await asyncio.to_thread(self.authority, principal)
        await asyncio.to_thread(self.authorize_conversation, principal, query.conversation_id)
        return ConversationPage(
            conversation_id=query.conversation_id, items=messages, next_cursor=cursor
        )

    async def invoke(
        self, principal: Principal, query: AssistantOperation, execution_key: str
    ) -> dict[str, JsonValue]:
        if isinstance(query, SubmitAssistant):
            result: BaseModel = await self.submit(principal, query, execution_key)
        elif isinstance(query, ReadConversation):
            await asyncio.to_thread(
                self.bind, principal, execution_key, query.conversation_id, "conversation"
            )
            result = await self.conversation(principal, query)
        else:
            await asyncio.to_thread(self.authorize, principal, query.request_key)
            await asyncio.to_thread(self.bind, principal, execution_key, query.request_key)
            if isinstance(query, CancelAssistant):
                task = self.tasks.get((principal.actor_id, query.request_key))
                if task:
                    task.cancel()
                    await asyncio.shield(task)
                result = await asyncio.to_thread(
                    self.get, principal, GetAssistant(request_key=query.request_key)
                )
            elif isinstance(query, WaitAssistant):
                result = await self.wait(principal, query)
            else:
                result = await asyncio.to_thread(self.get, principal, query)
        return _JSON.validate_python(result.model_dump(mode="json"))

    def start(self) -> None:
        before = (
            datetime.now(UTC) - timedelta(days=self.settings.mcp_result_retention_days)
        ).isoformat()
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE assistant_requests SET status='interrupted',finished_at=? "
                "WHERE status='running'",
                (utc_now(),),
            )
            connection.execute(
                "UPDATE assistant_requests SET answer=NULL WHERE finished_at < ?", (before,)
            )

    async def close(self) -> None:
        self.closing = True
        # Release active slots before waiting for acceptance calls queued behind them.
        for task in list(self.tasks.values()):
            if not task.cancelling():
                task.cancel()
        if self.accepting:
            await asyncio.gather(*self.accepting, return_exceptions=True)
        tasks = list(self.tasks.values())
        for task in tasks:
            if not task.cancelling():
                task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
