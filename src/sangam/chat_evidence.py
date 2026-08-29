from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass

from sangam.access import WorkspaceAccessService
from sangam.db import Database, utc_now
from sangam.errors import NotFoundError, ValidationError
from sangam.security import Principal


def selection_digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class TurnContextRecord:
    context_id: str
    actor_id: str
    thread_id: str | None
    user_item_id: str | None
    entry_point: str
    document_id: str | None
    revision_id: str | None
    pdf_page_number: int | None
    annotation_id: str | None
    selection_text: str
    selection_digest: str
    model_ref: str | None
    capability_manifest: tuple[dict[str, object], ...]
    created_at: str


class ChatEvidenceRepository:
    """Stores bounded turn context and metadata-only run evidence."""

    def __init__(self, database: Database, workspace: WorkspaceAccessService) -> None:
        self.database = database
        self.workspace = workspace

    def create_turn_context(
        self,
        principal: Principal,
        *,
        entry_point: str,
        document_id: str | None,
        revision_id: str | None,
        selected_text: str,
        pdf_page_number: int | None = None,
        annotation_id: str | None = None,
    ) -> TurnContextRecord:
        if entry_point not in {"workspace", "document"}:
            raise ValidationError("Unsupported chat entry point")
        if len(selected_text) > 20_000:
            raise ValidationError("Chat selection exceeds the 20,000 character limit")
        if selected_text and not document_id:
            raise ValidationError("Selected text requires a document context")
        if (pdf_page_number is not None or annotation_id is not None) and not document_id:
            raise ValidationError("PDF page and annotation context require a document")
        if annotation_id and pdf_page_number is None:
            raise ValidationError("An annotation context requires its PDF page")
        pinned_revision = None
        if document_id:
            document = self.workspace.get_document(principal, document_id)
            if pdf_page_number is not None and document.content_type != "application/pdf":
                raise ValidationError("PDF page context requires a PDF document")
            if annotation_id:
                annotations = self.workspace.list_annotations(
                    principal,
                    document_id,
                    page_number=pdf_page_number,
                    query="",
                    include_deleted=False,
                )
                if not any(item.annotation_id == annotation_id for item in annotations):
                    raise NotFoundError(f"PDF annotation not found: {annotation_id}")
            pinned_revision = revision_id or document.current_revision_id
            if pinned_revision != document.current_revision_id:
                revisions = {
                    item.revision_id for item in self.workspace.history(principal, document_id)
                }
                if pinned_revision not in revisions:
                    raise NotFoundError(
                        "The attached document revision no longer exists. "
                        "Return to the document and attach its current revision."
                    )
        elif revision_id:
            raise ValidationError("A revision requires a document context")
        context_id = f"ctx_{uuid.uuid4().hex}"
        now = utc_now()
        digest = selection_digest(selected_text)
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO chat_turn_contexts(
                    context_id, actor_id, entry_point, document_id, revision_id,
                    pdf_page_number, annotation_id, selection_text, selection_digest, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    context_id,
                    principal.actor_id,
                    entry_point,
                    document_id,
                    pinned_revision,
                    pdf_page_number,
                    annotation_id,
                    selected_text,
                    digest,
                    now,
                ),
            )
        return self.get_turn_context(principal, context_id)

    def get_turn_context(self, principal: Principal, context_id: str) -> TurnContextRecord:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM chat_turn_contexts WHERE context_id = ?", (context_id,)
            ).fetchone()
        if row is None or (row["actor_id"] != principal.actor_id and not principal.administrator):
            raise NotFoundError(f"Chat turn context not found: {context_id}")
        return self._context_from_row(row)

    def context_for_item(self, principal: Principal, user_item_id: str) -> TurnContextRecord | None:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM chat_turn_contexts WHERE user_item_id = ?", (user_item_id,)
            ).fetchone()
        if row is None:
            return None
        if row["actor_id"] != principal.actor_id and not principal.administrator:
            raise NotFoundError(f"Chat turn context not found for item: {user_item_id}")
        return self._context_from_row(row)

    def attach_turn_context(
        self,
        principal: Principal,
        *,
        context_id: str,
        thread_id: str,
        user_item_id: str,
        model_ref: str,
        capability_manifest: tuple[dict[str, object], ...],
    ) -> TurnContextRecord:
        existing = self.context_for_item(principal, user_item_id)
        if existing is not None:
            return existing
        manifest_json = json.dumps(capability_manifest, sort_keys=True, separators=(",", ":"))
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT actor_id, user_item_id FROM chat_turn_contexts WHERE context_id = ?",
                (context_id,),
            ).fetchone()
            if row is None or row["actor_id"] != principal.actor_id:
                raise NotFoundError(f"Chat turn context not found: {context_id}")
            if row["user_item_id"] not in {None, user_item_id}:
                raise ValidationError("Chat turn context is already attached to another turn")
            connection.execute(
                """
                UPDATE chat_turn_contexts
                SET thread_id = ?, user_item_id = ?, model_ref = ?,
                    capability_manifest_json = ?, attached_at = ?
                WHERE context_id = ?
                """,
                (thread_id, user_item_id, model_ref, manifest_json, utc_now(), context_id),
            )
        return self.get_turn_context(principal, context_id)

    def begin_run(
        self,
        principal: Principal,
        *,
        thread_id: str,
        user_item_id: str | None,
        context_id: str,
        connection_id: str,
        model_ref: str,
        capability_manifest: tuple[dict[str, object], ...],
    ) -> str:
        run_id = f"run_{uuid.uuid4().hex}"
        manifest_json = json.dumps(capability_manifest, sort_keys=True, separators=(",", ":"))
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO chat_runs(
                    run_id, thread_id, user_item_id, context_id, actor_id,
                    connection_id, model_ref, capability_manifest_json, status, started_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
                """,
                (
                    run_id,
                    thread_id,
                    user_item_id,
                    context_id,
                    principal.actor_id,
                    connection_id,
                    model_ref,
                    manifest_json,
                    utc_now(),
                ),
            )
        return run_id

    def complete_run(
        self,
        run_id: str,
        *,
        status: str,
        input_tokens: int | None = None,
        output_tokens: int | None = None,
        provider_correlation_id: str | None = None,
        error_class: str | None = None,
    ) -> None:
        if status not in {"completed", "failed", "cancelled"}:
            raise ValueError("Unsupported chat run completion status")
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE chat_runs
                SET status = ?, input_tokens = ?, output_tokens = ?,
                    provider_correlation_id = ?, error_class = ?, completed_at = ?
                WHERE run_id = ?
                """,
                (
                    status,
                    input_tokens,
                    output_tokens,
                    provider_correlation_id,
                    error_class,
                    utc_now(),
                    run_id,
                ),
            )

    def request_cancel(self, principal: Principal, *, thread_id: str) -> str | None:
        """Persist cancellation for the newest run owned by this principal."""
        with self.database.transaction() as connection:
            row = connection.execute(
                """
                SELECT r.run_id FROM chat_runs r
                WHERE r.thread_id = ? AND r.actor_id = ?
                  AND (
                    r.status = 'running'
                    OR EXISTS (
                      SELECT 1 FROM chat_effects e
                      WHERE e.run_id = r.run_id
                        AND e.status IN ('proposed', 'pending_approval', 'approved')
                    )
                  )
                ORDER BY r.started_at DESC LIMIT 1
                """,
                (thread_id, principal.actor_id),
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                "UPDATE chat_runs SET cancel_requested_at = COALESCE(cancel_requested_at, ?) "
                "WHERE run_id = ?",
                (utc_now(), row["run_id"]),
            )
            connection.execute(
                """
                UPDATE chat_effects
                SET status = 'cancelled', completed_at = ?
                WHERE run_id = ? AND status IN ('proposed', 'pending_approval', 'approved')
                """,
                (utc_now(), row["run_id"]),
            )
            return row["run_id"]

    def cancel_requested(self, run_id: str) -> bool:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT cancel_requested_at FROM chat_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
        return row is not None and row["cancel_requested_at"] is not None

    def record_tool(
        self,
        *,
        run_id: str,
        tool_call_id: str | None,
        capability_id: str,
        capability_version: int,
        effect_class: str,
        approval_policy: str,
        outcome: str,
        duration_ms: int,
        result_bytes: int,
        citation_count: int,
        error_class: str | None,
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO chat_run_tools(
                    event_id, run_id, tool_call_id, capability_id, capability_version,
                    effect_class, approval_policy, outcome, duration_ms, result_bytes,
                    citation_count, error_class, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    f"tool_{uuid.uuid4().hex}",
                    run_id,
                    tool_call_id,
                    capability_id,
                    capability_version,
                    effect_class,
                    approval_policy,
                    outcome,
                    duration_ms,
                    result_bytes,
                    citation_count,
                    error_class,
                    utc_now(),
                ),
            )

    @staticmethod
    def _context_from_row(row) -> TurnContextRecord:
        manifest = json.loads(row["capability_manifest_json"])
        return TurnContextRecord(
            context_id=row["context_id"],
            actor_id=row["actor_id"],
            thread_id=row["thread_id"],
            user_item_id=row["user_item_id"],
            entry_point=row["entry_point"],
            document_id=row["document_id"],
            revision_id=row["revision_id"],
            pdf_page_number=row["pdf_page_number"],
            annotation_id=row["annotation_id"],
            selection_text=row["selection_text"],
            selection_digest=row["selection_digest"],
            model_ref=row["model_ref"],
            capability_manifest=tuple(manifest),
            created_at=row["created_at"],
        )
