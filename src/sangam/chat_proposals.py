from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from sangam.access import WorkspaceAccessService
from sangam.chat_evidence import ChatEvidenceRepository
from sangam.db import Database, utc_now
from sangam.errors import (
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
    validate_metadata_text,
)
from sangam.schemas import (
    ChatProposal,
    ChatProposalCitation,
    ChatProposalEvidence,
    ChatProposalSource,
)
from sangam.security import Principal


@dataclass(frozen=True)
class ReservedChatProposal:
    proposal: ChatProposal
    idempotency_key: str


class ChatProposalRepository:
    """Owner-scoped persistence for reviewable chat proposals."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def require_thread_owner(self, thread_id: str, principal: Principal) -> str:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT created_by FROM chat_threads WHERE thread_id = ?", (thread_id,)
            ).fetchone()
        if row is None or (row["created_by"] != principal.actor_id and not principal.administrator):
            raise NotFoundError(f"Chat thread not found: {thread_id}")
        return row["created_by"]

    def create(
        self,
        principal: Principal,
        *,
        proposal_id: str,
        thread_id: str,
        document_id: str,
        expected_revision_id: str,
        content: str,
        summary: str | None,
        context_id: str | None,
        run_id: str | None = None,
        rationale: str | None = None,
        judgment_needed: str | None = None,
        citations_json: str = "[]",
        sources_retrieved_json: str = "[]",
    ) -> ChatProposal:
        self.require_thread_owner(thread_id, principal)
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO chat_proposals(
                    proposal_id, thread_id, document_id, expected_revision_id,
                    content, summary, status, applied_revision_id, created_at, applied_at,
                    apply_idempotency_key, context_id, run_id, rationale, judgment_needed,
                    citations_json, sources_retrieved_json
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(proposal_id) DO NOTHING
                """,
                (
                    proposal_id,
                    thread_id,
                    document_id,
                    expected_revision_id,
                    content,
                    summary,
                    utc_now(),
                    context_id,
                    run_id,
                    rationale,
                    judgment_needed,
                    citations_json,
                    sources_retrieved_json,
                ),
            )
        return self.get_owned(principal, proposal_id)

    def update_content(
        self,
        principal: Principal,
        proposal_id: str,
        content: str,
    ) -> None:
        with self.database.transaction() as connection:
            self._owned_row(connection, principal, proposal_id)
            connection.execute(
                """
                UPDATE chat_proposals
                SET content = ?
                WHERE proposal_id = ? AND status = 'pending'
                """,
                (content, proposal_id),
            )

    def list_owned(
        self, principal: Principal, *, thread_id: str | None, document_id: str | None
    ) -> list[ChatProposal]:
        clauses = ["(thread.created_by = ? OR ?)"]
        params: list[object] = [principal.actor_id, int(principal.administrator)]
        if thread_id:
            clauses.append("proposal.thread_id = ?")
            params.append(thread_id)
        if document_id:
            clauses.append("proposal.document_id = ?")
            params.append(document_id)
        with self.database.connection() as connection:
            rows = connection.execute(
                f"""
                SELECT proposal.*, thread.created_by AS proposal_owner_id,
                    context.actor_id AS evidence_actor_id,
                    context.document_id AS evidence_document_id,
                    context.revision_id AS evidence_revision_id,
                    context.selection_text AS evidence_selected_text,
                    context.pdf_page_number AS evidence_pdf_page_number,
                    context.annotation_id AS evidence_annotation_id
                FROM chat_proposals AS proposal
                JOIN chat_threads AS thread ON thread.thread_id = proposal.thread_id
                LEFT JOIN chat_turn_contexts AS context ON context.context_id = proposal.context_id
                WHERE {" AND ".join(clauses)}
                ORDER BY proposal.created_at DESC
                """,
                params,
            ).fetchall()
        return [_proposal_from_row(row) for row in rows]

    def get_owned(self, principal: Principal, proposal_id: str) -> ChatProposal:
        with self.database.connection() as connection:
            row = self._owned_row(connection, principal, proposal_id)
        return _proposal_from_row(row)

    def reserve_apply(
        self, principal: Principal, proposal_id: str, idempotency_key: str
    ) -> ReservedChatProposal:
        with self.database.transaction() as connection:
            row = self._owned_row(connection, principal, proposal_id)
            proposal = _proposal_from_row(row)
            if proposal.status != "pending":
                raise ConflictError(f"The proposal is already {proposal.status}")
            reserved_key = row["apply_idempotency_key"] or idempotency_key
            if row["apply_idempotency_key"] is None:
                connection.execute(
                    """
                    UPDATE chat_proposals SET apply_idempotency_key = ?
                    WHERE proposal_id = ? AND apply_idempotency_key IS NULL
                    """,
                    (reserved_key, proposal_id),
                )
        return ReservedChatProposal(proposal=proposal, idempotency_key=reserved_key)

    def mark_applied(
        self, principal: Principal, proposal_id: str, applied_revision_id: str
    ) -> ChatProposal:
        with self.database.transaction() as connection:
            self._owned_row(connection, principal, proposal_id)
            connection.execute(
                """
                UPDATE chat_proposals
                SET status = 'applied', applied_revision_id = ?, applied_at = ?
                WHERE proposal_id = ? AND status = 'pending'
                """,
                (applied_revision_id, utc_now(), proposal_id),
            )
        return self.get_owned(principal, proposal_id)

    def release_apply_reservation(
        self, principal: Principal, proposal_id: str, idempotency_key: str
    ) -> ChatProposal:
        """Release a reservation when validation failed before a document commit.

        Ambiguous failures after a commit deliberately retain the reservation so a
        retry reuses the original document idempotency key. This method is only used
        for access, existence, and validation failures that occur before mutation.
        """
        with self.database.transaction() as connection:
            self._owned_row(connection, principal, proposal_id)
            connection.execute(
                """
                UPDATE chat_proposals SET apply_idempotency_key = NULL
                WHERE proposal_id = ? AND status = 'pending'
                    AND apply_idempotency_key = ?
                """,
                (proposal_id, idempotency_key),
            )
        return self.get_owned(principal, proposal_id)

    def mark_stale(self, principal: Principal, proposal_id: str) -> ChatProposal:
        with self.database.transaction() as connection:
            self._owned_row(connection, principal, proposal_id)
            connection.execute(
                """
                UPDATE chat_proposals SET status = 'stale'
                WHERE proposal_id = ? AND status = 'pending'
                """,
                (proposal_id,),
            )
        return self.get_owned(principal, proposal_id)

    def dismiss(self, principal: Principal, proposal_id: str, summary: str | None) -> ChatProposal:
        with self.database.transaction() as connection:
            row = self._owned_row(connection, principal, proposal_id)
            proposal = _proposal_from_row(row)
            if proposal.status not in ("pending", "stale"):
                raise ConflictError(f"The proposal is already {proposal.status}")
            # A stale proposal's apply has already terminated, so its reserved
            # idempotency key is spent and dismissing it is safe. Only a pending
            # proposal with a live reservation is still mid-apply and must not be
            # dismissed out from under the in-flight document update.
            if proposal.status == "pending" and row["apply_idempotency_key"] is not None:
                raise ConflictError("The proposal is already being applied")
            connection.execute(
                """
                UPDATE chat_proposals SET status = 'dismissed', summary = ?
                WHERE proposal_id = ? AND status IN ('pending', 'stale')
                """,
                (summary, proposal_id),
            )
        return self.get_owned(principal, proposal_id)

    @staticmethod
    def _owned_row(
        connection: sqlite3.Connection, principal: Principal, proposal_id: str
    ) -> sqlite3.Row:
        row = connection.execute(
            """
            SELECT proposal.*, thread.created_by AS proposal_owner_id,
                context.actor_id AS evidence_actor_id,
                context.document_id AS evidence_document_id,
                context.revision_id AS evidence_revision_id,
                context.selection_text AS evidence_selected_text,
                context.pdf_page_number AS evidence_pdf_page_number,
                context.annotation_id AS evidence_annotation_id
            FROM chat_proposals AS proposal
            JOIN chat_threads AS thread ON thread.thread_id = proposal.thread_id
            LEFT JOIN chat_turn_contexts AS context ON context.context_id = proposal.context_id
            WHERE proposal.proposal_id = ? AND (thread.created_by = ? OR ?)
            """,
            (proposal_id, principal.actor_id, int(principal.administrator)),
        ).fetchone()
        if row is None:
            raise NotFoundError(f"Chat proposal not found: {proposal_id}")
        return row


class ChatProposalService:
    """Coordinates proposal review through Sangam's canonical document mutation path."""

    def __init__(
        self,
        *,
        repository: ChatProposalRepository,
        workspace: WorkspaceAccessService,
        evidence: ChatEvidenceRepository,
    ) -> None:
        self.repository = repository
        self.workspace = workspace
        self.evidence = evidence

    def create(
        self,
        principal: Principal,
        *,
        thread_id: str,
        document_id: str,
        expected_revision_id: str,
        content: str,
        summary: str,
        mode: Literal["full", "replace", "insert_before", "insert_after", "append"] = "full",
        anchor: str | None = None,
        replace_all: bool = False,
        context_id: str | None = None,
        run_id: str | None = None,
        rationale: str | None = None,
        judgment_needed: str | None = None,
        citations: list[dict[str, Any]] | None = None,
    ) -> ChatProposal:
        validate_metadata_text(summary, "Proposal summary")
        if rationale:
            validate_metadata_text(rationale, "Proposal rationale")
        if judgment_needed:
            validate_metadata_text(judgment_needed, "Proposal judgment")
        thread_owner = self.repository.require_thread_owner(thread_id, principal)
        if context_id is not None:
            context = self.evidence.get_turn_context(principal, context_id)
            if context.actor_id != thread_owner:
                raise ValidationError("Source context actor does not match the proposal thread")
            if context.thread_id not in {None, thread_id}:
                raise ValidationError("Source context does not match the proposal thread")
            if context.document_id is None or context.revision_id is None:
                raise ValidationError("Source context has no document evidence")
        resolved_content = self.resolve_content(
            principal,
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            mode=mode,
            content=content,
            anchor=anchor,
            replace_all=replace_all,
        )
        self.workspace.validate_proposed_update(
            principal,
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=resolved_content,
        )
        proposal_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                "sangam:"
                f"{thread_id}:{document_id}:{expected_revision_id}:"
                f"{hashlib.sha256(resolved_content.encode()).hexdigest()}",
            )
        )
        enriched_citations: list[dict[str, Any]] = []
        for raw_citation in citations or []:
            citation_doc_id = raw_citation.get("document_id")
            title = raw_citation.get("title")
            path = raw_citation.get("path")
            if citation_doc_id and (not title or path is None):
                try:
                    doc = self.workspace.get_document(principal, citation_doc_id)
                    title = title or doc.title
                    path = path if path is not None else doc.path
                except Exception:
                    pass
            enriched_citations.append(
                {
                    "document_id": citation_doc_id,
                    "revision_id": raw_citation.get("revision_id"),
                    "title": title,
                    "path": path,
                    "page_number": raw_citation.get("page_number"),
                    "annotation_id": raw_citation.get("annotation_id"),
                    "snippet": raw_citation.get("snippet", ""),
                    "location": raw_citation.get("location"),
                }
            )

        sources_retrieved: list[dict[str, Any]] = []
        if run_id:
            sources_retrieved = self.evidence.list_run_sources(run_id)

        proposal = self.repository.create(
            principal,
            proposal_id=proposal_id,
            thread_id=thread_id,
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=resolved_content,
            summary=_bounded_text(summary, 500),
            context_id=context_id,
            run_id=run_id,
            rationale=_bounded_text(rationale, 1000) if rationale else None,
            judgment_needed=_bounded_text(judgment_needed, 1000) if judgment_needed else None,
            citations_json=json.dumps(enriched_citations, sort_keys=True),
            sources_retrieved_json=json.dumps(sources_retrieved, sort_keys=True),
        )
        return self._visible_evidence(principal, proposal)

    def resolve_content(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        mode: Literal["full", "replace", "insert_before", "insert_after", "append"],
        content: str,
        anchor: str | None,
        replace_all: bool,
    ) -> str:
        """Resolve a patch-mode proposal into the resulting full document content."""
        if mode == "full":
            return content
        document = self.workspace.get_document(principal, document_id)
        if expected_revision_id == document.current_revision_id:
            document_content = document.content
        else:
            revision = next(
                (
                    item
                    for item in self.workspace.history(principal, document_id)
                    if item.revision_id == expected_revision_id
                ),
                None,
            )
            if revision is None:
                raise NotFoundError(f"Document revision not found: {expected_revision_id}")
            document_content = revision.content
        if mode == "append":
            boundary = "" if (document_content.endswith("\n") or content.startswith("\n")) else "\n"
            return document_content + boundary + content
        assert anchor is not None
        count = document_content.count(anchor)
        if count == 0:
            raise _patch_error(
                "anchor_not_found",
                "The anchor was not found in the document. The anchor must match the "
                f"document content exactly. Anchor start: {anchor[:80]!r}",
            )
        if mode == "replace":
            if count > 1 and not replace_all:
                raise _patch_error(
                    "anchor_not_unique",
                    f"The anchor matches {count} locations; provide a longer unique "
                    "anchor or set replace_all.",
                )
            return (
                document_content.replace(anchor, content)
                if replace_all
                else (document_content.replace(anchor, content, 1))
            )
        if count != 1:
            raise _patch_error(
                "anchor_not_unique",
                f"The anchor must match exactly one location for {mode}; it matches "
                f"{count} locations. Provide a longer unique anchor.",
            )
        if mode == "insert_before":
            return document_content.replace(anchor, content + anchor, 1)
        return document_content.replace(anchor, anchor + content, 1)

    def list(
        self, principal: Principal, *, thread_id: str | None, document_id: str | None
    ) -> list[ChatProposal]:
        return [
            self._visible_evidence(principal, proposal)
            for proposal in self.repository.list_owned(
                principal, thread_id=thread_id, document_id=document_id
            )
        ]

    def apply(
        self,
        principal: Principal,
        *,
        proposal_id: str,
        expected_revision_id: str,
        idempotency_key: str,
        content: str | None = None,
    ) -> ChatProposal:
        proposal = self.repository.get_owned(principal, proposal_id)
        if proposal.expected_revision_id != expected_revision_id:
            raise ConflictError("The proposal revision does not match the reviewed revision")
        reserved = self.repository.reserve_apply(principal, proposal_id, idempotency_key)
        proposal = reserved.proposal
        applied_content = content if content is not None else proposal.content
        if content is not None and content != proposal.content:
            self.workspace.validate_proposed_update(
                principal,
                document_id=proposal.document_id,
                expected_revision_id=expected_revision_id,
                content=applied_content,
            )
            self.repository.update_content(principal, proposal_id, applied_content)
        try:
            document = self.workspace.update_document(
                principal,
                document_id=proposal.document_id,
                expected_revision_id=expected_revision_id,
                content=applied_content,
                title=None,
                summary=proposal.summary,
                idempotency_key=reserved.idempotency_key,
            )
        except ConflictError:
            self.repository.mark_stale(principal, proposal_id)
            raise
        except (AuthorizationError, NotFoundError, ValidationError):
            self.repository.release_apply_reservation(
                principal, proposal_id, reserved.idempotency_key
            )
            raise
        return self._visible_evidence(
            principal,
            self.repository.mark_applied(principal, proposal_id, document.current_revision_id),
        )

    def dismiss(self, principal: Principal, proposal_id: str, reason: str | None) -> ChatProposal:
        validate_metadata_text(reason, "Dismissal reason")
        proposal = self.repository.get_owned(principal, proposal_id)
        summary = proposal.summary
        if reason:
            summary = f"{summary or 'Proposal'} — {_bounded_text(reason, 500)}"
        return self._visible_evidence(
            principal, self.repository.dismiss(principal, proposal_id, summary)
        )

    def _visible_evidence(self, principal: Principal, proposal: ChatProposal) -> ChatProposal:
        updates: dict[str, Any] = {}
        if proposal.evidence is not None:
            try:
                self.workspace.get_document(principal, proposal.evidence.document_id)
            except (AuthorizationError, NotFoundError):
                updates["evidence"] = None
                updates["evidence_status"] = "unavailable"
        if proposal.citations:
            visible_citations: list[ChatProposalCitation] = []
            has_redacted = False
            for cit in proposal.citations:
                try:
                    self.workspace.get_document(principal, cit.document_id)
                    visible_citations.append(cit)
                except (AuthorizationError, NotFoundError):
                    has_redacted = True
                    visible_citations.append(
                        cit.model_copy(
                            update={
                                "title": None,
                                "path": None,
                                "snippet": "",
                                "location": "Source document deleted or inaccessible",
                            }
                        )
                    )
            updates["citations"] = visible_citations
            if has_redacted:
                updates["evidence_status"] = "unavailable"
        if proposal.sources_retrieved:
            visible_sources: list[ChatProposalSource] = []
            for src in proposal.sources_retrieved:
                try:
                    self.workspace.get_document(principal, src.document_id)
                    visible_sources.append(src)
                except (AuthorizationError, NotFoundError):
                    pass
            updates["sources_retrieved"] = visible_sources
        if updates:
            return proposal.model_copy(update=updates)
        return proposal


def _patch_error(code: str, message: str) -> ValidationError:
    error = ValidationError(message)
    error.code = code
    return error


def _proposal_from_row(row: sqlite3.Row) -> ChatProposal:
    context_id = row["context_id"]
    evidence = None
    evidence_status = "not_recorded"
    if context_id is not None and row["evidence_actor_id"] == row["proposal_owner_id"]:
        evidence = ChatProposalEvidence(
            context_id=context_id,
            document_id=row["evidence_document_id"],
            revision_id=row["evidence_revision_id"],
            selected_text=row["evidence_selected_text"],
            pdf_page_number=row["evidence_pdf_page_number"],
            annotation_id=row["evidence_annotation_id"],
        )
        evidence_status = "recorded"
    elif context_id is not None:
        evidence_status = "unavailable"

    row_keys = row.keys()
    rationale = row["rationale"] if "rationale" in row_keys else None
    judgment_needed = row["judgment_needed"] if "judgment_needed" in row_keys else None

    citations: list[ChatProposalCitation] = []
    if "citations_json" in row_keys and row["citations_json"]:
        try:
            raw_citations = json.loads(row["citations_json"])
            citations = [ChatProposalCitation.model_validate(c) for c in raw_citations]
        except Exception:
            citations = []

    sources_retrieved: list[ChatProposalSource] = []
    if "sources_retrieved_json" in row_keys and row["sources_retrieved_json"]:
        try:
            raw_sources = json.loads(row["sources_retrieved_json"])
            sources_retrieved = [ChatProposalSource.model_validate(s) for s in raw_sources]
        except Exception:
            sources_retrieved = []

    return ChatProposal(
        proposal_id=row["proposal_id"],
        thread_id=row["thread_id"],
        document_id=row["document_id"],
        expected_revision_id=row["expected_revision_id"],
        content=row["content"],
        summary=row["summary"],
        status=row["status"],
        applied_revision_id=row["applied_revision_id"],
        created_at=row["created_at"],
        applied_at=row["applied_at"],
        evidence=evidence,
        evidence_status=evidence_status,
        rationale=rationale,
        judgment_needed=judgment_needed,
        citations=citations,
        sources_retrieved=sources_retrieved,
    )


def _bounded_text(value: str, limit: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value
    return encoded[:limit].decode("utf-8", errors="ignore") + "\n[truncated]"
