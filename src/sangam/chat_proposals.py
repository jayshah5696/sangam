from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from dataclasses import dataclass, replace
from threading import Lock
from typing import Annotated, Literal

from pydantic import Field, TypeAdapter
from pydantic import ValidationError as PayloadValidationError

from sangam.access import WorkspaceAccessService
from sangam.chat_actions import ActionDigest, check_autonomy_allows, validate_action_ownership
from sangam.chat_capabilities import ProposalCitationInput
from sangam.chat_evidence import ChatEvidenceRepository
from sangam.db import Database, utc_now
from sangam.errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    IdempotencyError,
    NotFoundError,
    ValidationError,
    validate_metadata_text,
)
from sangam.idempotency import IdempotencyStore
from sangam.schemas import (
    ChatProposal,
    ChatProposalCitation,
    ChatProposalEvidence,
    ChatProposalSource,
    UpdateDocument,
)
from sangam.security import IdentityService, Principal
from sangam.service import append_fingerprint


@dataclass(frozen=True)
class ReservedChatProposal:
    proposal: ChatProposal
    idempotency_key: str
    recovering: bool


class ChatProposalRepository:
    """Owner-scoped persistence for reviewable chat proposals."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def require_thread_owner(self, thread_id: str, principal: Principal) -> str:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT created_by FROM chat_threads WHERE thread_id = ?", (thread_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Chat thread not found: {thread_id}")
        validate_action_ownership(principal, thread_owner=row["created_by"])
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
        model_opinion: str | None = None,
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
                     citations_json, sources_retrieved_json, model_opinion
                 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)
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
                    model_opinion,
                ),
            )
        return self.get_owned(principal, proposal_id)

    def cancel_pending(self, run_id: str) -> None:
        """Cancel proposals belonging to a cancelled run that are still pending."""
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE chat_proposals
                SET status = 'dismissed', summary = COALESCE(summary, 'Run cancelled')
                WHERE run_id = ? AND status = 'pending'
                """,
                (run_id,),
            )

    def list_owned(
        self, principal: Principal, *, thread_id: str | None, document_id: str | None
    ) -> list[ChatProposal]:
        clauses = ["(thread.created_by = ? OR context.actor_id = ? OR ?)"]
        params: list[object] = [
            principal.actor_id,
            principal.actor_id,
            int(principal.administrator),
        ]
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
        self, principal: Principal, proposal_id: str, idempotency_key: str, content: str
    ) -> ReservedChatProposal:
        with self.database.transaction() as connection:
            row = self._owned_row(connection, principal, proposal_id)
            proposal = _proposal_from_row(row)
            digest = ActionDigest.compute(content)
            ActionDigest.verify(
                row["apply_payload_digest"],
                digest,
                "Apply retry must contain the exact reserved wording",
            )
            if row["apply_actor_id"] is not None and row["apply_actor_id"] != principal.actor_id:
                raise ConflictError("Apply recovery must use the original reviewer's actor")
            if proposal.status not in {"pending", "applied"}:
                raise ConflictError(f"The proposal is already {proposal.status}")
            recovering = row["apply_idempotency_key"] is not None
            reserved_key = row["apply_idempotency_key"] or idempotency_key
            if row["apply_idempotency_key"] is None:
                connection.execute(
                    """
                    UPDATE chat_proposals SET apply_idempotency_key = ?,
                        apply_payload_digest = ?, reviewed_content = ?, apply_actor_id = ?
                    WHERE proposal_id = ? AND apply_idempotency_key IS NULL
                    """,
                    (reserved_key, digest, content, principal.actor_id, proposal_id),
                )
        return ReservedChatProposal(
            proposal=proposal, idempotency_key=reserved_key, recovering=recovering
        )

    def mark_applied(
        self, principal: Principal, proposal_id: str, applied_revision_id: str
    ) -> ChatProposal:
        with self.database.transaction() as connection:
            self._owned_row(connection, principal, proposal_id)
            connection.execute(
                """
                UPDATE chat_proposals
                SET status = 'applied', applied_revision_id = ?, applied_at = ?,
                    applied_content = reviewed_content
                WHERE proposal_id = ? AND status = 'pending'
                """,
                (applied_revision_id, utc_now(), proposal_id),
            )
        return self.get_owned(principal, proposal_id)

    def committed_revision(
        self, principal: Principal, proposal: ChatProposal, idempotency_key: str, content: str
    ) -> str | None:
        """Recover the immutable result, never the document's subsequently changed head."""
        fingerprint = append_fingerprint(
            document_id=proposal.document_id,
            expected_revision_id=proposal.expected_revision_id,
            content=content,
            title=None,
            path=None,
            operation="update",
            summary=proposal.summary,
            deleted=None,
        )
        with self.database.connection() as connection:
            record = IdempotencyStore.lookup(
                connection, actor_id=principal.actor_id, key=idempotency_key
            )
            if (
                record is None
                or record.operation != "update"
                or record.resource_id != proposal.document_id
                or record.request_hash != fingerprint
                or record.revision_id is None
            ):
                return None
            revision = connection.execute(
                "SELECT content, parent_revision_id FROM revisions WHERE revision_id = ?",
                (record.revision_id,),
            ).fetchone()
        if (
            revision is None
            or revision["content"] != content
            or revision["parent_revision_id"] != proposal.expected_revision_id
        ):
            return None
        return record.revision_id

    def release_apply_reservation(
        self, principal: Principal, proposal_id: str, idempotency_key: str
    ) -> ChatProposal:
        """Release a reservation when validation failed before a document commit.

        Ambiguous failures after a commit deliberately retain the reservation so a
        retry reuses the original document idempotency key. This method is only used
        after a known failure with no matching canonical mutation commit.
        """
        with self.database.transaction() as connection:
            self._owned_row(connection, principal, proposal_id)
            connection.execute(
                """
                UPDATE chat_proposals SET apply_idempotency_key = NULL,
                    apply_payload_digest = NULL, reviewed_content = NULL, apply_actor_id = NULL
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
            WHERE proposal.proposal_id = ? AND (thread.created_by = ? OR context.actor_id = ? OR ?)
            """,
            (proposal_id, principal.actor_id, principal.actor_id, int(principal.administrator)),
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
        identity: IdentityService,
    ) -> None:
        self.repository = repository
        self.workspace = workspace
        self.evidence = evidence
        self.identity = identity
        # Track active applies per proposal. The database payload binding
        # survives interruption; canonical document idempotency recovers its commit.
        self._apply_lock = Lock()
        self._applying: set[str] = set()

    def cancel_pending(self, run_id: str) -> None:
        self.repository.cancel_pending(run_id)

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
        model_opinion: str | None = None,
        citations: list[ProposalCitationInput] | list[dict[str, str | int | None]] | None = None,
    ) -> ChatProposal:
        principal = self.identity.reauthorize(principal)
        validate_metadata_text(summary, "Proposal summary")
        if rationale:
            validate_metadata_text(rationale, "Proposal rationale")
        if judgment_needed:
            validate_metadata_text(judgment_needed, "Proposal judgment")
        if model_opinion:
            validate_metadata_text(model_opinion, "Model opinion")
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
        if run_id:
            self.evidence.require_run_owner(principal, run_id, thread_id)
        enriched_citations = self._validated_citations(principal, citations or [])
        identity = json.dumps(
            [
                resolved_content,
                summary,
                rationale,
                judgment_needed,
                model_opinion,
                [citation.model_dump() for citation in enriched_citations],
            ],
            sort_keys=True,
        )
        proposal_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                "sangam:"
                f"{thread_id}:{run_id}:{document_id}:{expected_revision_id}:"
                f"{hashlib.sha256(identity.encode()).hexdigest()}",
            )
        )
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
            model_opinion=_bounded_text(model_opinion, 2000) if model_opinion else None,
            citations_json=TypeAdapter(list[ChatProposalCitation])
            .dump_json(enriched_citations)
            .decode(),
        )
        visible = self._visible_evidence(principal, proposal)
        if check_autonomy_allows(self.repository.database):
            try:
                return self.apply(
                    principal,
                    proposal_id=proposal.proposal_id,
                    expected_revision_id=expected_revision_id,
                    idempotency_key=f"yolo:{proposal.proposal_id}",
                    content=resolved_content,
                )
            except Exception:
                return visible
        return visible

    def _validated_citations(
        self,
        principal: Principal,
        citations: list[ProposalCitationInput] | list[dict[str, str | int | None]],
    ) -> list[ChatProposalCitation]:
        try:
            inputs = TypeAdapter(
                Annotated[list[ProposalCitationInput], Field(max_length=20)]
            ).validate_python(citations)
        except PayloadValidationError as error:
            raise ValidationError("Invalid proposal citations") from error
        result = []
        for citation in inputs:
            document = self.workspace.get_document(principal, citation.document_id)
            revision_id = citation.revision_id or document.current_revision_id
            revision = next(
                (
                    r
                    for r in self.workspace.history(principal, document.document_id)
                    if r.revision_id == revision_id
                ),
                None,
            )
            if revision is None:
                raise NotFoundError(f"Citation revision not found in document: {revision_id}")
            source_text = revision.content
            if citation.page_number is not None:
                if document.content_type != "application/pdf":
                    raise ValidationError("Citation page requires a PDF document")
                page = next(
                    (
                        p
                        for p in self.workspace.pdf_pages(principal, document.document_id)
                        if p.page_number == citation.page_number
                    ),
                    None,
                )
                if page is None:
                    raise NotFoundError(f"Citation PDF page not found: {citation.page_number}")
                source_text = page.text
            elif document.content_type == "application/pdf":
                raise ValidationError("PDF citations require an exact page")
            if citation.annotation_id:
                if citation.page_number is None:
                    raise ValidationError("Citation annotation requires its PDF page")
                annotations = self.workspace.list_annotations(
                    principal,
                    document.document_id,
                    page_number=citation.page_number,
                    query="",
                    include_deleted=False,
                )
                annotation = next(
                    (a for a in annotations if a.annotation_id == citation.annotation_id), None
                )
                if annotation is None:
                    raise NotFoundError("Citation annotation does not belong to this document/page")
                if citation.snippet and citation.snippet not in (annotation.selected_text or ""):
                    raise ValidationError("Citation quote does not match the annotation passage")
            if not citation.snippet or citation.snippet not in source_text:
                raise ValidationError("Citation must quote an exact passage in the pinned source")
            start = source_text.index(citation.snippet)
            if citation.quote_start is not None:
                encoded_source = source_text.encode("utf-16-le")
                if citation.quote_start > len(encoded_source) // 2:
                    raise ValidationError("Citation locator is outside the source")
                try:
                    start = len(encoded_source[: citation.quote_start * 2].decode("utf-16-le"))
                except UnicodeDecodeError as error:
                    raise ValidationError("Citation locator splits a Unicode character") from error
                if not source_text.startswith(citation.snippet, start):
                    raise ValidationError("Citation quote does not match its exact locator")
            elif not citation.annotation_id and source_text.find(citation.snippet, start + 1) != -1:
                raise ValidationError(
                    "Citation passage is ambiguous; quote a unique passage or supply quote_start"
                )
            end = start + len(citation.snippet)
            first_line = len(re.findall(r"\r\n|\r|\n", source_text[:start])) + 1
            last_line = first_line + len(re.findall(r"\r\n|\r|\n", citation.snippet))
            location = (
                f"Page {citation.page_number}"
                if citation.page_number is not None
                else f"Lines {first_line}–{last_line}"
            )
            result.append(
                ChatProposalCitation(
                    document_id=document.document_id,
                    revision_id=revision_id,
                    title=document.title,
                    path=document.path,
                    page_number=citation.page_number,
                    annotation_id=citation.annotation_id,
                    snippet=citation.snippet,
                    location=location,
                    # Browser/editor offsets use UTF-16 code units, including emoji.
                    quote_start=len(source_text[:start].encode("utf-16-le")) // 2,
                    quote_end=len(source_text[:end].encode("utf-16-le")) // 2,
                )
            )
        return result

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
            revision = self.workspace.get_revision(principal, document_id, expected_revision_id)
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

    def get(self, principal: Principal, proposal_id: str) -> ChatProposal:
        proposal = self.repository.get_owned(principal, proposal_id)
        return self._visible_evidence(principal, proposal)

    def apply(
        self,
        principal: Principal,
        *,
        proposal_id: str,
        expected_revision_id: str,
        idempotency_key: str,
        content: str | None = None,
    ) -> ChatProposal:
        with self._apply_lock:
            if proposal_id in self._applying:
                raise ConflictError(
                    "The proposal is already being applied; retry after it completes"
                )
            self._applying.add(proposal_id)
        try:
            proposal = self.repository.get_owned(principal, proposal_id)
            if proposal.expected_revision_id != expected_revision_id:
                raise ConflictError("The proposal revision does not match the reviewed revision")
            applied_content = content if content is not None else proposal.content
            reserved = self.repository.reserve_apply(
                principal, proposal_id, idempotency_key, applied_content
            )
            proposal = reserved.proposal
            try:
                principal = self.identity.reauthorize(principal)
                if not reserved.recovering:
                    self.workspace.validate_proposed_update(
                        principal,
                        document_id=proposal.document_id,
                        expected_revision_id=expected_revision_id,
                        content=applied_content,
                    )
                self.workspace.write_document(
                    replace(principal, via=f"chat-proposal:{proposal_id}"),
                    document_id=proposal.document_id,
                    action="update",
                    body=UpdateDocument(
                        expected_revision_id=expected_revision_id,
                        content=applied_content,
                        summary=proposal.summary,
                    ),
                    idempotency_key=reserved.idempotency_key,
                )
                revision_id = self.repository.committed_revision(
                    principal, proposal, reserved.idempotency_key, applied_content
                )
                if revision_id is None:
                    raise RuntimeError("Apply completion has no matching committed revision")
            except ConflictError:
                if (
                    self.repository.committed_revision(
                        principal, proposal, reserved.idempotency_key, applied_content
                    )
                    is None
                ):
                    self.repository.release_apply_reservation(
                        principal, proposal_id, reserved.idempotency_key
                    )
                    self.repository.mark_stale(principal, proposal_id)
                raise
            except (
                AuthenticationError,
                AuthorizationError,
                IdempotencyError,
                NotFoundError,
                ValidationError,
            ):
                if (
                    self.repository.committed_revision(
                        principal, proposal, reserved.idempotency_key, applied_content
                    )
                    is None
                ):
                    self.repository.release_apply_reservation(
                        principal, proposal_id, reserved.idempotency_key
                    )
                raise
            return self._visible_evidence(
                principal,
                self.repository.mark_applied(principal, proposal_id, revision_id),
            )
        finally:
            with self._apply_lock:
                self._applying.remove(proposal_id)

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
        principal = self.identity.reauthorize(principal)
        evidence = proposal.evidence
        evidence_status = proposal.evidence_status
        if proposal.evidence is not None:
            try:
                self._require_source_reference(
                    principal,
                    proposal.evidence.document_id,
                    proposal.evidence.revision_id,
                    proposal.evidence.pdf_page_number,
                    proposal.evidence.annotation_id,
                )
            except (AuthorizationError, NotFoundError):
                evidence = None
                evidence_status = "unavailable"
        visible_citations = proposal.citations
        if proposal.citations:
            visible_citations = []
            has_redacted = False
            for cit in proposal.citations:
                try:
                    self._require_source_reference(
                        principal,
                        cit.document_id,
                        cit.revision_id,
                        cit.page_number,
                        cit.annotation_id,
                        cit.snippet,
                    )
                    visible_citations.append(cit)
                except (AuthorizationError, NotFoundError):
                    has_redacted = True
                    visible_citations.append(
                        cit.model_copy(
                            update={
                                "title": None,
                                "path": None,
                                "snippet": "",
                                "location": "Source reference deleted, changed, or inaccessible",
                                "available": False,
                                "quote_start": None,
                                "quote_end": None,
                            }
                        )
                    )
            if has_redacted:
                evidence_status = "unavailable"
        sources = proposal.sources_retrieved
        truncated = proposal.sources_retrieved_truncated
        if proposal.run_id:
            self.evidence.require_run_owner(principal, proposal.run_id, proposal.thread_id)
            sources = self.evidence.list_run_sources(proposal.run_id)
            truncated = self.evidence.run_sources_truncated(proposal.run_id)
        visible_sources: list[ChatProposalSource] = []
        for src in sources:
            try:
                self._require_source_reference(
                    principal,
                    src.document_id,
                    src.revision_id,
                    src.page_number,
                    None,
                )
                visible_sources.append(src)
            except (AuthorizationError, NotFoundError):
                pass
        return proposal.model_copy(
            update={
                "evidence": evidence,
                "evidence_status": evidence_status,
                "citations": visible_citations,
                "sources_retrieved": visible_sources,
                "sources_retrieved_truncated": truncated,
            }
        )

    def _require_source_reference(
        self,
        principal: Principal,
        document_id: str,
        revision_id: str | None,
        page_number: int | None,
        annotation_id: str | None,
        snippet: str | None = None,
    ) -> None:
        self.workspace.get_document(principal, document_id)
        if revision_id:
            with self.repository.database.connection() as connection:
                exists = connection.execute(
                    "SELECT 1 FROM revisions WHERE document_id = ? AND revision_id = ?",
                    (document_id, revision_id),
                ).fetchone()
            if exists is None:
                raise NotFoundError("The recorded source revision is unavailable")
        if annotation_id:
            annotations = self.workspace.list_annotations(
                principal,
                document_id,
                page_number=page_number,
                query="",
                include_deleted=False,
            )
            annotation = next(
                (
                    a
                    for a in annotations
                    if a.annotation_id == annotation_id and a.page_number == page_number
                ),
                None,
            )
            if annotation is None or (snippet and snippet not in (annotation.selected_text or "")):
                raise NotFoundError("The recorded annotation passage is unavailable")


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
        citations = TypeAdapter(list[ChatProposalCitation]).validate_json(row["citations_json"])

    sources_retrieved: list[ChatProposalSource] = []
    if "sources_retrieved_json" in row_keys and row["sources_retrieved_json"]:
        sources_retrieved = TypeAdapter(list[ChatProposalSource]).validate_json(
            row["sources_retrieved_json"]
        )

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
        run_id=row["run_id"],
        applied_content=row["applied_content"],
        model_opinion=row["model_opinion"],
    )


def _bounded_text(value: str, limit: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value
    marker = " [truncated]"
    return encoded[: limit - len(marker)].decode("utf-8", errors="ignore") + marker
