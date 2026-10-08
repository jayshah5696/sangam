from __future__ import annotations

import difflib
import json
import sqlite3
import uuid
from collections.abc import Callable, Iterator
from contextlib import suppress
from dataclasses import dataclass
from typing import TYPE_CHECKING, BinaryIO, Literal, Protocol, TypeVar

if TYPE_CHECKING:
    from sangam.comments import DocumentCommentService

from sangam.activity import ActivityService
from sangam.authorization import AuthorizationPolicy
from sangam.capabilities import Capability
from sangam.conditions import (
    ConditionalMutation,
    Preconditions,
    artifact_etag,
    conditional_mutation,
    document_etag,
)
from sangam.db import utc_now
from sangam.document_assets import DocumentAssetService, StoredAsset
from sangam.errors import (
    AuthorizationError,
    ConflictError,
    IdempotencyError,
    NotFoundError,
    SangamError,
    ServiceUnavailableError,
    ValidationError,
)
from sangam.idempotency import request_hash
from sangam.organization import WorkspaceOrganizationService
from sangam.pdf_research import PdfResearchService
from sangam.publication import PublicationService
from sangam.schemas import (
    Annotation,
    AnnotationEvent,
    AnnotationType,
    ApplyOrganizationPlan,
    CreateDocumentCommentRequest,
    DeleteDocument,
    Document,
    DocumentAsset,
    DocumentComment,
    DocumentSummary,
    DuplicateDocument,
    Folder,
    IssuedPublication,
    OrganizationCreateFolder,
    OrganizationCreateTag,
    OrganizationDocumentSnapshot,
    OrganizationDuplicateDocument,
    OrganizationFolderSnapshot,
    OrganizationMaterializeDocument,
    OrganizationMoveDocument,
    OrganizationMoveFolder,
    OrganizationPlanItemResult,
    OrganizationPlanResult,
    OrganizationRestoreDocument,
    OrganizationSnapshotPage,
    OrganizationTagSnapshot,
    OrganizationTrashDocument,
    OrganizationUpdateDocumentMetadata,
    OrganizationUpdateFolderMetadata,
    PathMutation,
    PdfPage,
    PdfRect,
    PdfSearchResult,
    Publication,
    PublicationRevision,
    PublishedEvidenceItem,
    ResolveDocumentCommentRequest,
    RestoreDocument,
    Revision,
    RevisionDiff,
    RevisionPage,
    Tag,
    TrustedPreviewGrant,
    UpdateDocument,
    UpdateDocumentMetadata,
    UpdateDocumentTrust,
)
from sangam.security import Principal, path_matches, sanitize_sensitive_text
from sangam.service import DocumentService, default_duplicate_path
from sangam.workspace import canonicalize_document_path

T = TypeVar("T")


@dataclass(frozen=True)
class Action:
    """What the activity ledger calls an operation, and whether it changes state."""

    name: str
    resource_type: str
    mutation: bool


def reads(name: str, resource_type: str) -> Action:
    """Declare an operation that never changes workspace state."""
    return Action(name, resource_type, mutation=False)


def writes(name: str, resource_type: str) -> Action:
    """Declare an operation whose acceptance must reach the activity ledger."""
    return Action(name, resource_type, mutation=True)


def _plan_resource_type(kind: str) -> Literal["document", "folder", "tag"]:
    if kind == "create_tag":
        return "tag"
    return "document" if "document" in kind else "folder"


def _plan_resource_id(result: Document | Folder | Tag) -> str:
    if isinstance(result, Document):
        return result.document_id
    return result.tag_id if isinstance(result, Tag) else result.folder_id


class Audited(Protocol):
    """``WorkspaceAccessService.audited``, for services that run their own transactions."""

    def __call__(
        self,
        principal: Principal,
        action: Action,
        operation: Callable[[], T],
        *,
        resource_id: str | None = None,
        path: str | None = None,
        details: dict[str, object] | None = None,
        estimated_bytes: int | None = None,
        subject: Callable[[T], str] | None = None,
    ) -> T: ...


DocumentWriteAction = Literal[
    "update", "duplicate", "tag", "materialize", "move", "delete", "restore", "trust"
]
DocumentWriteBody = (
    UpdateDocument
    | DuplicateDocument
    | UpdateDocumentMetadata
    | PathMutation
    | DeleteDocument
    | RestoreDocument
    | UpdateDocumentTrust
)
# The capability each document write needs on the document's current path.
# Trust changes are administrator-only and have no workspace capability.
_DOCUMENT_WRITE_CAPABILITY: dict[DocumentWriteAction, Capability | None] = {
    "update": Capability.UPDATE,
    "duplicate": Capability.READ,
    "tag": Capability.TAG,
    "materialize": Capability.MOVE,
    "move": Capability.MOVE,
    "delete": Capability.DELETE,
    "restore": Capability.RESTORE,
    "trust": None,
}


def detect_line_ending(text: str) -> str:
    if "\r\n" in text:
        return "crlf"
    if "\n" in text:
        return "lf"
    if "\r" in text:
        return "cr"
    return "none"


def compute_document_diff(
    old_content: str,
    new_content: str,
    fromfile: str = "before",
    tofile: str = "current",
) -> tuple[str, int, int, dict[str, object]]:
    if old_content == new_content:
        return (
            "",
            0,
            0,
            {
                "line_ending": detect_line_ending(new_content),
                "final_newline": new_content.endswith("\n") or new_content.endswith("\r"),
            },
        )

    a_lines = old_content.splitlines(keepends=True)
    b_lines = new_content.splitlines(keepends=True)

    raw_diff = list(
        difflib.unified_diff(
            a_lines,
            b_lines,
            fromfile=fromfile,
            tofile=tofile,
            lineterm="",
        )
    )
    if not raw_diff:
        return (
            "",
            0,
            0,
            {
                "line_ending": detect_line_ending(new_content),
                "final_newline": new_content.endswith("\n") or new_content.endswith("\r"),
            },
        )

    formatted_lines: list[str] = []
    lines_added = 0
    lines_removed = 0
    in_hunks = False

    for idx, line in enumerate(raw_diff):
        if idx < 2 and (line.startswith("---") or line.startswith("+++")):
            formatted_lines.append(line + "\n")
            continue

        if line.startswith("@@") and "@@" in line[2:]:
            in_hunks = True
            formatted_lines.append(line + "\n")
            continue

        if not in_hunks:
            formatted_lines.append(line + "\n")
            continue

        has_newline = line.endswith("\n") or line.endswith("\r")
        clean_line = (
            line[:-1]
            if line.endswith("\n")
            else (line[:-2] + "\r" if line.endswith("\r\n") else line)
        )

        if line.startswith("+"):
            lines_added += 1
            formatted_lines.append(clean_line + "\n")
            if not has_newline:
                formatted_lines.append("\\ No newline at end of file\n")
        elif line.startswith("-"):
            lines_removed += 1
            formatted_lines.append(clean_line + "\n")
            if not has_newline:
                formatted_lines.append("\\ No newline at end of file\n")
        elif line.startswith(" "):
            formatted_lines.append(clean_line + "\n")
            if not has_newline:
                formatted_lines.append("\\ No newline at end of file\n")
        else:
            formatted_lines.append(line + "\n")

    metadata: dict[str, object] = {
        "line_ending": detect_line_ending(new_content),
        "final_newline": new_content.endswith("\n") or new_content.endswith("\r"),
    }
    diff = "".join(formatted_lines)
    safe_old = sanitize_sensitive_text(old_content)
    safe_new = sanitize_sensitive_text(new_content)
    if safe_old != old_content or safe_new != new_content:
        # Redact before diffing so a hunk inside a PEM block cannot lose its
        # identifying delimiters. Counts still describe the actual edit.
        diff = compute_document_diff(safe_old, safe_new, fromfile, tofile)[0] or "[REDACTED]\n"
    return diff, lines_added, lines_removed, metadata


class _RetryHttpMutation(Exception):
    """Restart admission or lock selection before any storage side effect."""

    def __init__(self, estimated_bytes: int, replay_document_id: str | None = None) -> None:
        self.estimated_bytes = estimated_bytes
        self.replay_document_id = replay_document_id


class WorkspaceAccessService:
    """Public workspace boundary that authenticates policy before domain services run."""

    def http_document_read(
        self,
        principal: Principal,
        *,
        document_id: str,
        if_match: str | None,
        if_none_match: str | None,
        artifact: bool = False,
    ) -> tuple[Document, bytes | None, str, bool]:
        def operation() -> tuple[Document, bytes | None, str, bool]:
            document = self.documents.get_document(document_id)
            self.policy.require(principal, Capability.READ, document.path)
            content = None
            if artifact:
                content = (
                    self.pdf_research.pdf_bytes(document_id)[1]
                    if document.content_type == "application/pdf"
                    else document.content.encode("utf-8")
                )
                etag = artifact_etag(content, document.content_type)
            else:
                etag = document_etag(document)
            changed = Preconditions.parse(if_match, if_none_match).evaluate(etag, read=True)
            return document, content, etag, changed

        return self.audited(
            principal, reads("read", "document"), operation, resource_id=document_id
        )

    def write_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        action: DocumentWriteAction,
        body: DocumentWriteBody,
        idempotency_key: str,
        if_match: str | None = None,
        if_none_match: str | None = None,
    ) -> Document:
        """Apply one revision-aware document write for HTTP, chat, and organization plans.

        Authorizes the document's fresh path (and the destination of a move,
        materialization, or duplicate), requires an expected revision unless HTTP
        conditions are given, and ledgers the change with its diff. A replayed
        idempotency key returns the committed result without running storage again.
        """
        payload = body.model_dump()
        details = {
            "action_type": action,
            **{key: value for key, value in payload.items() if value is not None},
        }
        admitted_bound = self.activity.estimate_payload_bytes(details) + 2048
        locked_document_ids = {document_id}

        def store(expected_revision_id: str) -> Document:
            return self._store_document_write(
                principal,
                document_id=document_id,
                action=action,
                body=body,
                expected_revision_id=expected_revision_id,
                idempotency_key=idempotency_key,
            )

        def authorized() -> Document:
            with self.documents.mutations.documents(*locked_document_ids):
                current = self.documents.get_document(document_id, include_deleted=True)
                capability = _DOCUMENT_WRITE_CAPABILITY[action]
                if capability is None:
                    if not principal.administrator:
                        raise AuthorizationError("Document trust requires administrator access")
                else:
                    self.policy.require(principal, capability, current.path)
                if action in {"move", "materialize", "duplicate"}:
                    details["source_path"] = current.path
                    destination = payload.get("path")
                    if action == "duplicate" and destination is None:
                        destination = default_duplicate_path(current)
                    self._authorize_destination_path(
                        principal,
                        capability=Capability.CREATE if action == "duplicate" else Capability.MOVE,
                        path=destination,
                    )
                    details["destination_path"] = destination
                    details["target_file"] = destination or current.path
                elif current.path is not None:
                    details["target_file"] = current.path
                conditions = Preconditions.parse(if_match, if_none_match)
                has_conditions = if_match is not None or if_none_match is not None
                expected = payload.get("expected_revision_id")
                if action not in {"trust", "tag"} and expected is None and not has_conditions:
                    raise ValidationError(
                        "expected_revision_id in body or HTTP condition is required"
                    )

                if isinstance(body, (UpdateDocument, DuplicateDocument, RestoreDocument)):
                    if isinstance(body, RestoreDocument):
                        details["current_revision_id"] = body.revision_id
                        content = self.documents.revision_content(document_id, body.revision_id)
                    elif isinstance(body, UpdateDocument):
                        content = body.content
                    else:
                        content = current.content
                    diff, added, removed, meta = compute_document_diff(
                        "" if action == "duplicate" else current.content,
                        content,
                        fromfile=current.current_revision_id,
                        tofile="current",
                    )
                    details.update(diff=diff, lines_added=added, lines_removed=removed, **meta)

                needed_bound = self.activity.estimate_payload_bytes(details)
                if needed_bound > admitted_bound:
                    # Do not expand an audit reservation inside a transaction,
                    # or wait for capacity while retaining document locks.
                    raise _RetryHttpMutation(needed_bound + 2048)

                if not has_conditions and action != "duplicate":
                    return store(expected or current.current_revision_id)
                fingerprint = request_hash(
                    {
                        "document_id": document_id,
                        "action": action,
                        "payload": payload,
                        "if_match": if_match,
                        "if_none_match": if_none_match,
                    }
                )
                # Replay precedes precondition evaluation, but never authorization.
                with self.documents.database.connection() as connection:
                    replay = self.documents.idempotency.lookup(
                        connection, actor_id=principal.actor_id, key=idempotency_key
                    )
                    if replay:
                        legacy_duplicate = (
                            action == "duplicate"
                            and not has_conditions
                            and replay.request_hash != fingerprint
                            and replay.operation == "create"
                            and replay.revision_id is not None
                            and isinstance(body, DuplicateDocument)
                            and self.documents.legacy_duplicate_replay_matches(
                                connection,
                                actor_id=principal.actor_id,
                                source_document_id=document_id,
                                expected_revision_id=body.expected_revision_id,
                                title=body.title,
                                path=body.path,
                                result_document_id=replay.resource_id,
                                result_revision_id=replay.revision_id,
                                stored_request_hash=replay.request_hash,
                            )
                        )
                        if replay.request_hash != fingerprint and not legacy_duplicate:
                            raise IdempotencyError(
                                "Idempotency key was already used for a different mutation"
                            )
                        if replay.resource_id not in locked_document_ids:
                            # Re-enter with all locks in one order. Never acquire
                            # an arbitrary replay target while holding its source.
                            raise _RetryHttpMutation(admitted_bound, replay.resource_id)
                        with self.documents.mutations.document(replay.resource_id):
                            result = self.documents.get_document(
                                replay.resource_id, include_deleted=True
                            )
                            if action == "duplicate":
                                self.policy.require(principal, Capability.CREATE, result.path)
                            return self.documents.finish_replayed_write(result.document_id)

                def validate(connection: sqlite3.Connection) -> None:
                    snapshot = self.documents.get_document_in_connection(connection, document_id)
                    conditions.evaluate(document_etag(snapshot))

                # Validate before any filesystem side effect, then again in the
                # committing storage transaction through its replay lookup.
                with self.documents.database.connection() as connection:
                    validate(connection)
                with conditional_mutation(ConditionalMutation(fingerprint, validate)):
                    return store(expected or current.current_revision_id)

        while True:
            try:
                return self.audited(
                    principal,
                    writes(action, "document"),
                    authorized,
                    resource_id=document_id,
                    details=details,
                    estimated_bytes=admitted_bound,
                )
            except _RetryHttpMutation as retry:
                admitted_bound = max(admitted_bound, retry.estimated_bytes)
                if retry.replay_document_id is not None:
                    locked_document_ids.add(retry.replay_document_id)

    def _store_document_write(
        self,
        principal: Principal,
        *,
        document_id: str,
        action: DocumentWriteAction,
        body: DocumentWriteBody,
        expected_revision_id: str,
        idempotency_key: str,
    ) -> Document:
        """Map one authorized document write onto its storage operation."""
        documents = self.documents
        actor_id = principal.actor_id
        if action == "update" and isinstance(body, UpdateDocument):
            return documents.update_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                content=body.content,
                title=body.title,
                summary=body.summary,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        if action == "duplicate" and isinstance(body, DuplicateDocument):
            return documents.duplicate_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                title=body.title,
                path=body.path,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        if action == "tag" and isinstance(body, UpdateDocumentMetadata):
            return documents.update_document_metadata(
                document_id=document_id,
                expected_metadata_version=body.expected_metadata_version,
                category=body.category,
                tag_ids=body.tag_ids,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        if action in {"move", "materialize"} and isinstance(body, PathMutation):
            write = documents.move_document if action == "move" else documents.materialize_document
            return write(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                path=body.path,
                summary=body.summary,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        if action == "delete" and isinstance(body, DeleteDocument):
            return documents.delete_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                summary=body.summary,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        if action == "restore" and isinstance(body, RestoreDocument):
            return documents.restore_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                revision_id=body.revision_id,
                summary=body.summary,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        if action == "trust" and isinstance(body, UpdateDocumentTrust):
            return documents.update_trust(
                document_id=document_id,
                expected_trust_version=body.expected_trust_version,
                trust_level=body.trust_level,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        raise ValidationError("Unsupported conditional document operation")

    def __init__(
        self,
        *,
        documents: DocumentService,
        organization: WorkspaceOrganizationService,
        policy: AuthorizationPolicy,
        activity: ActivityService,
        publications: PublicationService,
        pdf_research: PdfResearchService,
        assets: DocumentAssetService,
        comments: DocumentCommentService | None = None,
    ) -> None:
        self.documents = documents
        self.organization = organization
        self.policy = policy
        self.activity = activity
        self.publications = publications
        self.pdf_research = pdf_research
        self.assets = assets
        self.comments = comments

    def validate_proposed_update(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        content: str,
    ) -> Document:
        """Authorize and validate a reviewable update without mutating the document."""
        current = self.documents.get_document(document_id)
        self.policy.require(principal, Capability.UPDATE, current.path)
        if current.content_type == "application/pdf":
            raise ValidationError("PDF source bytes cannot be updated through chat")
        if current.current_revision_id != expected_revision_id:
            raise ConflictError(
                "The document changed before the proposal was created",
                details={"current_revision_id": current.current_revision_id},
            )
        self.documents.validate_proposed_content(content)
        return current

    def import_pdf(
        self,
        principal: Principal,
        *,
        title: str,
        path: str,
        content: bytes | BinaryIO,
        supersedes_document_id: str | None,
        idempotency_key: str,
    ) -> Document:
        def operation() -> Document:
            authorized_path = self._authorize_destination_path(
                principal, capability=Capability.CREATE, path=path
            )
            if authorized_path is None:
                raise AuthorizationError("PDF imports require a materialized workspace path")
            if supersedes_document_id:
                previous = self.documents.get_document(supersedes_document_id)
                self.policy.require(principal, Capability.READ, previous.path)
            return self.pdf_research.import_pdf(
                title=title,
                path=authorized_path,
                content=content,
                supersedes_document_id=supersedes_document_id,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        details: dict[str, object] = {
            "action_type": "import",
            "target_file": path,
            "title": title,
            "content_type": "application/pdf",
        }
        if supersedes_document_id:
            details["supersedes_document_id"] = supersedes_document_id
        return self.audited(
            principal, writes("import", "pdf_document"), operation, path=path, details=details
        )

    def pdf_bytes(self, principal: Principal, document_id: str) -> tuple[Document, bytes]:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("read_pdf", "document"),
            current=current,
            operation=lambda: self.pdf_research.pdf_bytes(document_id),
        )

    def pdf_stream_info(self, principal: Principal, document_id: str) -> tuple[Document, int]:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("read_pdf", "document"),
            current=current,
            operation=lambda: self.pdf_research.pdf_stream_info(document_id),
        )

    def pdf_stream(
        self,
        principal: Principal,
        document_id: str,
        *,
        start: int = 0,
        end: int | None = None,
    ) -> Iterator[bytes]:
        current = self.documents.get_document(document_id)
        self.policy.require(principal, Capability.READ, current.path)
        return self.pdf_research.pdf_stream(document_id, start=start, end=end)

    def pdf_pages(self, principal: Principal, document_id: str) -> list[PdfPage]:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("read_pdf_text", "document"),
            current=current,
            operation=lambda: self.pdf_research.pages(document_id),
        )

    def search_pdf_pages(
        self, principal: Principal, document_id: str, query: str
    ) -> list[PdfSearchResult]:
        current = self.documents.get_document(document_id)

        def operation() -> list[PdfSearchResult]:
            self.policy.require(principal, Capability.READ, current.path)
            self.policy.require(principal, Capability.SEARCH, current.path)
            return self.pdf_research.search_pages(document_id, query)

        return self.audited(
            principal,
            reads("search_pdf", "pdf_document"),
            operation,
            resource_id=document_id,
            path=current.path,
        )

    def list_annotations(
        self,
        principal: Principal,
        document_id: str,
        *,
        page_number: int | None,
        query: str,
        include_deleted: bool,
    ) -> list[Annotation]:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("list_annotations", "document"),
            current=current,
            operation=lambda: self.pdf_research.list_annotations(
                document_id,
                page_number=page_number,
                query=query,
                include_deleted=include_deleted,
            ),
        )

    def create_annotation(
        self,
        principal: Principal,
        *,
        document_id: str,
        page_number: int,
        annotation_type: AnnotationType,
        selected_text: str | None,
        note: str | None,
        geometry: list[PdfRect],
        tags: list[str],
        color: str,
        idempotency_key: str,
    ) -> Annotation:
        current = self.documents.get_document(document_id)
        details: dict[str, object] = {
            "annotation_type": str(annotation_type),
            "page_number": page_number,
            "color": color,
            "tags": tags,
        }
        if note:
            details["note"] = note
        return self._document_operation(
            principal,
            capability=Capability.UPDATE,
            action=writes("annotate", "document"),
            current=current,
            operation=lambda: self.pdf_research.create_annotation(
                document_id=document_id,
                page_number=page_number,
                annotation_type=annotation_type,
                selected_text=selected_text,
                note=note,
                geometry=geometry,
                tags=tags,
                color=color,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
            details=details,
        )

    def update_annotation(
        self,
        principal: Principal,
        *,
        annotation_id: str,
        expected_version: int,
        selected_text: str | None,
        note: str | None,
        geometry: list[PdfRect],
        tags: list[str],
        color: str,
        idempotency_key: str,
    ) -> Annotation:
        annotation = self.pdf_research.get_annotation(annotation_id)
        current = self.documents.get_document(annotation.document_id)
        details: dict[str, object] = {
            "annotation_type": str(annotation.annotation_type),
            "page_number": annotation.page_number,
            "color": color,
            "tags": tags,
        }
        if note:
            details["note"] = note
        return self._document_operation(
            principal,
            capability=Capability.UPDATE,
            action=writes("annotate", "document"),
            current=current,
            operation=lambda: self.pdf_research.update_annotation(
                annotation_id=annotation_id,
                expected_version=expected_version,
                selected_text=selected_text,
                note=note,
                geometry=geometry,
                tags=tags,
                color=color,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
            details=details,
        )

    def delete_annotation(
        self,
        principal: Principal,
        *,
        annotation_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> Annotation:
        annotation = self.pdf_research.get_annotation(annotation_id)
        current = self.documents.get_document(annotation.document_id)
        details: dict[str, object] = {
            "annotation_type": str(annotation.annotation_type),
            "page_number": annotation.page_number,
        }
        return self._document_operation(
            principal,
            capability=Capability.UPDATE,
            action=writes("annotate", "document"),
            current=current,
            operation=lambda: self.pdf_research.delete_annotation(
                annotation_id=annotation_id,
                expected_version=expected_version,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
            details=details,
        )

    def annotation_history(self, principal: Principal, annotation_id: str) -> list[AnnotationEvent]:
        annotation = self.pdf_research.get_annotation(annotation_id, include_deleted=True)
        current = self.documents.get_document(annotation.document_id)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("annotation_history", "document"),
            current=current,
            operation=lambda: self.pdf_research.annotation_history(annotation_id),
        )

    def list_comments(
        self,
        principal: Principal,
        document_id: str,
        *,
        include_resolved: bool = True,
    ) -> list[DocumentComment]:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("list_comments", "document"),
            current=current,
            operation=lambda: []
            if self.comments is None
            else self.comments.list_comments(document_id, include_resolved=include_resolved),
        )

    def get_comment(
        self,
        principal: Principal,
        document_id: str,
        comment_id: str,
    ) -> DocumentComment:
        current = self.documents.get_document(document_id)

        def operation() -> DocumentComment:
            if self.comments is None:
                raise NotFoundError(f"Comment not found: {comment_id}")
            comment = self.comments.get_comment(comment_id)
            if comment.document_id != document_id:
                raise NotFoundError(f"Comment not found: {comment_id}")
            return comment

        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("get_comment", "document"),
            current=current,
            operation=operation,
        )

    def create_comment(
        self,
        principal: Principal,
        document_id: str,
        request: CreateDocumentCommentRequest,
        *,
        idempotency_key: str | None = None,
    ) -> DocumentComment:
        if self.comments is None:
            raise ServiceUnavailableError("Document comments are not configured")
        current = self.documents.get_document(document_id)
        details: dict[str, object] = {
            "revision_id": request.revision_id,
            "exact": request.exact,
            "start": request.start,
            "end": request.end,
        }
        return self._document_operation(
            principal,
            capability=Capability.UPDATE,
            action=writes("comment", "document"),
            current=current,
            operation=lambda: self.comments.create_comment(
                document_id=document_id,
                request=request,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
            details=details,
        )

    def resolve_comment(
        self,
        principal: Principal,
        document_id: str,
        comment_id: str,
        request: ResolveDocumentCommentRequest,
    ) -> DocumentComment:
        if self.comments is None:
            raise ServiceUnavailableError("Document comments are not configured")
        current = self.documents.get_document(document_id)
        comment = self.comments.get_comment(comment_id)
        if comment.document_id != document_id:
            raise NotFoundError(f"Comment not found: {comment_id}")
        details: dict[str, object] = {
            "comment_id": comment_id,
            "resolved": request.resolved,
            "expected_version": request.expected_version,
        }
        return self._document_operation(
            principal,
            capability=Capability.UPDATE,
            action=writes("resolve_comment", "document"),
            current=current,
            operation=lambda: self.comments.resolve_comment(
                comment_id=comment_id,
                resolved=request.resolved,
                expected_version=request.expected_version,
                actor_id=principal.actor_id,
            ),
            details=details,
        )

    def list_documents(
        self,
        principal: Principal,
        *,
        include_deleted: bool = False,
        limit: int = 100,
        offset: int = 0,
    ) -> list[DocumentSummary]:
        def operation() -> list[DocumentSummary]:
            return self.documents.list_document_summaries(
                include_deleted=include_deleted,
                path_prefixes=self.policy.allowed_prefixes(principal, Capability.READ),
                limit=limit,
                offset=offset,
            )

        return self.audited(principal, reads("list", "document"), operation)

    def search_documents(
        self,
        principal: Principal,
        *,
        query: str,
        tag_id: str | None,
        category: str | None,
        actor_id: str | None,
        sort: str,
        content_type: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[DocumentSummary]:
        def operation() -> list[DocumentSummary]:
            return self.documents.search_documents(
                query=query,
                tag_id=tag_id,
                category=category,
                actor_id=actor_id,
                content_type=content_type,
                sort=sort,
                path_prefixes=self.policy.allowed_prefixes(
                    principal, Capability.READ, Capability.SEARCH
                ),
                limit=limit,
                offset=offset,
            )

        return self.audited(principal, reads("search", "document"), operation)

    def get_document_backlinks(
        self,
        principal: Principal,
        *,
        document_id: str,
        limit: int = 50,
    ) -> list[DocumentSummary]:
        def operation() -> list[DocumentSummary]:
            target = self.documents.get_document(document_id)
            self.policy.require(principal, Capability.READ, target.path)
            return self.documents.get_backlinks(
                document_id,
                path_prefixes=self.policy.allowed_prefixes(principal, Capability.READ),
                limit=limit,
            )

        return self.audited(
            principal, reads("read", "document"), operation, resource_id=document_id
        )

    def get_document(
        self, principal: Principal, document_id: str, *, include_deleted: bool = False
    ) -> Document:
        document = self.documents.get_document(document_id, include_deleted=include_deleted)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("read", "document"),
            current=document,
            operation=lambda: document,
        )

    def create_document(
        self,
        principal: Principal,
        *,
        title: str,
        content: str,
        path: str | None,
        content_type: str = "text/markdown",
        idempotency_key: str,
    ) -> Document:
        def operation() -> Document:
            authorized_path = self._authorize_destination_path(
                principal, capability=Capability.CREATE, path=path
            )
            return self.documents.create_document(
                title=title,
                content=content,
                path=authorized_path,
                content_type=content_type,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        diff_text, lines_added, lines_removed, meta = compute_document_diff(
            "",
            content,
            fromfile="empty",
            tofile="current",
        )
        details: dict[str, object] = {
            "action_type": "create",
            "title": title,
            "content_type": content_type,
            "diff": diff_text,
            "lines_added": lines_added,
            "lines_removed": lines_removed,
            **meta,
        }
        if path is not None:
            details["target_file"] = path
        return self.audited(
            principal, writes("create", "document"), operation, path=path, details=details
        )

    def attach_document_asset(
        self,
        principal: Principal,
        *,
        document_id: str,
        filename: str,
        media_type: str,
        content: bytes,
    ) -> DocumentAsset:
        """Store an image beside a document the principal may update."""
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.UPDATE,
            action=writes("attach_asset", "document"),
            current=current,
            operation=lambda: self.assets.store(
                document=current, filename=filename, media_type=media_type, content=content
            ),
            details={"filename": filename, "media_type": media_type, "size_bytes": len(content)},
        )

    def read_document_asset(
        self, principal: Principal, *, document_id: str, reference: str
    ) -> StoredAsset:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("read", "document"),
            current=current,
            operation=lambda: self.assets.read(document=current, reference=reference),
        )

    def issue_trusted_preview(
        self,
        principal: Principal,
        *,
        document_id: str,
        revision_id: str,
    ) -> TrustedPreviewGrant:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("issue_trusted_preview", "document"),
            current=current,
            operation=lambda: self.publications.issue_trusted_preview(
                document_id=document_id, revision_id=revision_id
            ),
            details={"revision_id": revision_id},
        )

    def create_publication(
        self,
        principal: Principal,
        *,
        document_id: str,
        slug: str,
        access_policy: str,
        idempotency_key: str,
        revision_id: str | None = None,
        evidence: list[PublishedEvidenceItem] | None = None,
    ) -> IssuedPublication:
        current = self.documents.get_document(document_id)

        def operation() -> IssuedPublication:
            self.policy.require(principal, Capability.PUBLISH, current.path)
            return self.publications.create(
                document_id=document_id,
                slug=slug,
                access_policy=access_policy,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
                revision_id=revision_id,
                evidence=evidence,
            )

        details: dict[str, object] = {
            "slug": slug,
            "access_policy": access_policy,
            "revision_id": revision_id or current.current_revision_id,
        }
        return self.audited(
            principal,
            writes("publish", "publication"),
            operation,
            resource_id=document_id,
            path=current.path,
            details=details,
        )

    def preflight_create_document(
        self,
        principal: Principal,
        *,
        title: str,
        content: str,
        content_type: str,
        path: str | None,
    ) -> None:
        self._authorize_destination_path(principal, capability=Capability.CREATE, path=path)
        self.documents._validate_content_size(content)
        normalized_path = self.documents._normalize_path(path) if path is not None else None
        if content_type not in {"text/markdown", "text/html"}:
            raise ValidationError("Unsupported text document content type")
        self.documents._validate_path_type(normalized_path, content_type)
        if normalized_path is not None:
            with self.documents.database.connection() as connection:
                row = connection.execute(
                    "SELECT 1 FROM documents WHERE path = ? AND deleted = 0",
                    (normalized_path,),
                ).fetchone()
                if row is not None:
                    raise ConflictError(f"Destination document already exists: {normalized_path}")
                folder_row = connection.execute(
                    "SELECT 1 FROM folders WHERE path = ?",
                    (normalized_path,),
                ).fetchone()
                if folder_row is not None:
                    raise ConflictError(f"Destination folder already exists: {normalized_path}")

    def preflight_publish_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        revision_id: str,
        slug: str,
        access_policy: str,
    ) -> None:
        current = self.documents.get_document(document_id)
        if current.deleted:
            raise ConflictError(f"Document no longer exists: {document_id}")
        self.policy.require(principal, Capability.PUBLISH, current.path)
        if current.content_type == "application/pdf":
            raise ValidationError("PDF documents cannot be published")
        if current.current_revision_id != revision_id:
            raise ConflictError(
                "The document changed before publication approval",
                details={"current_revision_id": current.current_revision_id},
            )
        self.publications._normalize_slug(slug)

    def document_publication(self, principal: Principal, document_id: str) -> Publication | None:
        """The publication of a document, for someone who may publish it."""
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.PUBLISH,
            action=reads("read_publication", "publication"),
            current=current,
            operation=lambda: self.publications.get_document_publication(document_id),
        )

    def preflight_update_publication(
        self, principal: Principal, *, publication_id: str, expected_version: int
    ) -> Publication:
        """Refuse an unpublish or update request that could not run as written."""
        publication = self.publications.get_publication(publication_id)
        current = self.documents.get_document(publication.document_id)
        self.policy.require(principal, Capability.PUBLISH, current.path)
        if publication.version != expected_version:
            raise ConflictError(
                "The publication changed since it was read",
                details={"current_version": publication.version},
            )
        return publication

    def update_publication(
        self,
        principal: Principal,
        *,
        publication_id: str,
        expected_version: int,
        slug: str,
        access_policy: str,
        idempotency_key: str,
        revision_id: str | None = None,
        evidence: list[PublishedEvidenceItem] | None = None,
    ) -> IssuedPublication:
        publication = self.publications.get_publication(publication_id)
        current = self.documents.get_document(publication.document_id)

        def operation() -> IssuedPublication:
            self.policy.require(principal, Capability.PUBLISH, current.path)
            return self.publications.update(
                publication_id=publication_id,
                expected_version=expected_version,
                slug=slug,
                access_policy=access_policy,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
                revision_id=revision_id,
                evidence=evidence,
            )

        details: dict[str, object] = {
            "expected_metadata_version": expected_version,
            "slug": slug,
            "access_policy": access_policy,
            "revision_id": revision_id or publication.revision_id,
        }
        return self.audited(
            principal,
            writes("publish", "publication"),
            operation,
            resource_id=publication_id,
            path=current.path,
            details=details,
        )

    def unpublish(
        self,
        principal: Principal,
        *,
        publication_id: str,
        expected_version: int,
        idempotency_key: str,
    ) -> Publication:
        publication = self.publications.get_publication(publication_id)
        current = self.documents.get_document(publication.document_id)

        def operation() -> Publication:
            self.policy.require(principal, Capability.PUBLISH, current.path)
            return self.publications.unpublish(
                publication_id=publication_id,
                expected_version=expected_version,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        details: dict[str, object] = {"expected_metadata_version": expected_version}
        return self.audited(
            principal,
            writes("unpublish", "publication"),
            operation,
            resource_id=publication_id,
            path=current.path,
            details=details,
        )

    def expose_publication_revision(
        self,
        principal: Principal,
        *,
        publication_id: str,
        revision_id: str,
        idempotency_key: str,
    ) -> PublicationRevision:
        publication = self.publications.get_publication(publication_id)
        current = self.documents.get_document(publication.document_id)

        def operation() -> PublicationRevision:
            self.policy.require(principal, Capability.PUBLISH, current.path)
            return self.publications.expose_revision(
                publication_id=publication_id,
                revision_id=revision_id,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        details: dict[str, object] = {"revision_id": revision_id}
        return self.audited(
            principal,
            writes("expose_revision", "publication"),
            operation,
            resource_id=publication_id,
            path=current.path,
            details=details,
        )

    def rotate_publication_token(
        self,
        principal: Principal,
        *,
        publication_id: str,
        idempotency_key: str,
    ) -> IssuedPublication:
        publication = self.publications.get_publication(publication_id)
        current = self.documents.get_document(publication.document_id)

        def operation() -> IssuedPublication:
            self.policy.require(principal, Capability.PUBLISH, current.path)
            return self.publications.rotate_token(
                publication_id=publication_id,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        return self.audited(
            principal,
            writes("rotate_token", "publication"),
            operation,
            resource_id=publication_id,
            path=current.path,
        )

    def history(self, principal: Principal, document_id: str) -> list[Revision]:
        current = self.documents.get_document(document_id, include_deleted=True)

        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("history", "document"),
            current=current,
            operation=lambda: self.documents.history(document_id),
        )

    def revision_page(
        self,
        principal: Principal,
        document_id: str,
        *,
        limit: int,
        cursor: str | None,
    ) -> RevisionPage:
        current = self.documents.get_document(document_id, include_deleted=True)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("revision_page", "document"),
            current=current,
            operation=lambda: self.documents.revision_page(document_id, limit=limit, cursor=cursor),
        )

    def get_revision(self, principal: Principal, document_id: str, revision_id: str) -> Revision:
        current = self.documents.get_document(document_id, include_deleted=True)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("read_revision", "document"),
            current=current,
            operation=lambda: self.documents.get_revision(document_id, revision_id),
        )

    def revision_diff(
        self,
        principal: Principal,
        *,
        document_id: str,
        from_revision_id: str,
        to_revision_id: str | None,
    ) -> RevisionDiff:
        current = self.documents.get_document(document_id, include_deleted=True)

        return self._document_operation(
            principal,
            capability=Capability.READ,
            action=reads("diff", "document"),
            current=current,
            operation=lambda: self.documents.revision_diff(
                document_id=document_id,
                from_revision_id=from_revision_id,
                to_revision_id=to_revision_id,
            ),
        )

    def inspect_workspace_organization(
        self,
        principal: Principal,
        *,
        item_type: str | None,
        path_prefix: str | None,
        offset: int,
        limit: int,
    ) -> OrganizationSnapshotPage:
        return self.audited(
            principal,
            reads("list_organization", "workspace"),
            lambda: self._inspect_workspace_organization(
                principal, item_type=item_type, path_prefix=path_prefix, offset=offset, limit=limit
            ),
        )

    def _inspect_workspace_organization(
        self,
        principal: Principal,
        *,
        item_type: str | None,
        path_prefix: str | None,
        offset: int,
        limit: int,
    ) -> OrganizationSnapshotPage:
        """Return a bounded, path-authorized organization snapshot."""
        if item_type not in {None, "document", "folder", "tag"}:
            raise ValidationError("Unknown organization item type")
        normalized_prefix = (
            self.organization.normalize_folder_path(path_prefix) if path_prefix else None
        )
        allowed = self.policy.allowed_prefixes(principal, Capability.READ)
        document_prefixes = allowed
        if normalized_prefix is not None:
            document_prefixes = (
                (normalized_prefix,)
                if allowed is None
                else tuple(
                    normalized_prefix if path_matches(prefix, normalized_prefix) else prefix
                    for prefix in allowed
                    if path_matches(prefix, normalized_prefix)
                    or path_matches(normalized_prefix, prefix)
                )
            )
        items: list[
            OrganizationDocumentSnapshot | OrganizationFolderSnapshot | OrganizationTagSnapshot
        ] = []
        source_limit = offset + limit + 1
        if item_type in {None, "document"}:
            documents = self.documents.search_documents(
                path_prefixes=document_prefixes,
                sort="path",
                limit=source_limit,
                offset=0,
            )
            items.extend(
                OrganizationDocumentSnapshot(
                    document_id=document.document_id,
                    title=document.title,
                    content_type=document.content_type,
                    path=document.path,
                    current_revision_id=document.current_revision_id,
                    metadata_version=document.metadata_version,
                    category=document.category,
                    tags=document.tags,
                    deleted=document.deleted,
                )
                for document in documents
                if normalized_prefix is None or path_matches(normalized_prefix, document.path)
            )
        if item_type in {None, "folder"}:
            for folder in self._visible_folders(principal):
                if allowed == () or (
                    allowed is not None
                    and not any(
                        path_matches(prefix, folder.path) or path_matches(folder.path, prefix)
                        for prefix in allowed
                    )
                ):
                    continue
                if normalized_prefix is not None and not path_matches(
                    normalized_prefix, folder.path
                ):
                    continue
                items.append(
                    OrganizationFolderSnapshot(
                        folder_id=folder.folder_id,
                        path=folder.path,
                        metadata_version=folder.metadata_version,
                        category=folder.category,
                        tags=folder.tags,
                        descendant_document_count=folder.document_count,
                    )
                )
        if item_type in {None, "tag"} and allowed is None:
            items.extend(
                OrganizationTagSnapshot(tag_id=tag.tag_id, name=tag.name, color=tag.color)
                for tag in self.organization.list_tags()
            )

        def item_key(
            item: OrganizationDocumentSnapshot
            | OrganizationFolderSnapshot
            | OrganizationTagSnapshot,
        ) -> tuple[str, str, str]:
            if isinstance(item, OrganizationDocumentSnapshot):
                return item.kind, item.path or "", item.document_id
            if isinstance(item, OrganizationFolderSnapshot):
                return item.kind, item.path, item.folder_id
            return item.kind, item.name, item.tag_id

        items.sort(key=item_key)
        page = items[offset : offset + limit]
        return OrganizationSnapshotPage(
            items=page,
            offset=offset,
            limit=limit,
            next_offset=offset + limit if offset + limit < len(items) else None,
        )

    def apply_workspace_organization_plan(
        self,
        principal: Principal,
        *,
        plan: ApplyOrganizationPlan,
        idempotency_key: str,
    ) -> OrganizationPlanResult:
        """Preflight and execute a resumable, bounded organization plan."""
        normalized = self._normalize_organization_plan(plan)
        payload = normalized.model_dump(mode="json")
        digest = request_hash(payload)
        database = self.organization.database
        next_operation = 0
        results: list[OrganizationPlanItemResult] = []
        with database.transaction() as connection:
            existing = connection.execute(
                """
                SELECT argument_digest, result_json, status, next_operation
                FROM organization_plan_executions
                WHERE actor_id = ? AND idempotency_key = ?
                """,
                (principal.actor_id, idempotency_key),
            ).fetchone()
            if existing:
                if existing["argument_digest"] != digest:
                    raise ConflictError(
                        "The organization idempotency key was used for a different plan"
                    )
                if existing["result_json"] and existing["status"] != "running":
                    return OrganizationPlanResult.model_validate_json(existing["result_json"])
                if existing["result_json"]:
                    partial = OrganizationPlanResult.model_validate_json(existing["result_json"])
                    results = list(partial.items)
                next_operation = existing["next_operation"]
            else:
                self._preflight_organization_plan(principal, normalized)
                now = utc_now()
                connection.execute(
                    """
                    INSERT INTO organization_plan_executions(
                        execution_id, actor_id, idempotency_key, argument_digest,
                        normalized_plan_json, status, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
                    """,
                    (
                        f"org_{uuid.uuid4().hex}",
                        principal.actor_id,
                        idempotency_key,
                        digest,
                        json.dumps(payload, sort_keys=True, separators=(",", ":")),
                        now,
                        now,
                    ),
                )

        for index, operation in enumerate(
            normalized.operations[next_operation:], start=next_operation
        ):
            child_key = f"{idempotency_key}:{index}"
            try:
                if not self.documents.idempotency.committed(
                    actor_id=principal.actor_id, key=child_key
                ):
                    self._preflight_organization_plan(
                        principal,
                        ApplyOrganizationPlan(operations=[operation]),
                    )
                result = self._execute_organization_operation(
                    principal, operation=operation, idempotency_key=child_key
                )
            except SangamError as error:
                status = "conflicted" if isinstance(error, ConflictError) else "failed"
                results.append(
                    OrganizationPlanItemResult(
                        index=index,
                        kind=operation.kind,
                        status=status,
                        resource_type=_plan_resource_type(operation.kind),
                        resource_id=getattr(
                            operation, "document_id", getattr(operation, "folder_id", None)
                        ),
                        operation_key=child_key,
                        message=error.message,
                    )
                )
                for skipped_index, skipped in enumerate(
                    normalized.operations[index + 1 :], start=index + 1
                ):
                    results.append(
                        OrganizationPlanItemResult(
                            index=skipped_index,
                            kind=skipped.kind,
                            status="skipped",
                            resource_type=_plan_resource_type(skipped.kind),
                            resource_id=getattr(
                                skipped,
                                "document_id",
                                getattr(skipped, "folder_id", None),
                            ),
                            operation_key=f"{idempotency_key}:{skipped_index}",
                            message="Not attempted after an earlier operation failed",
                        )
                    )
                break
            results.append(
                OrganizationPlanItemResult(
                    index=index,
                    kind=operation.kind,
                    status="completed",
                    resource_type=_plan_resource_type(operation.kind),
                    resource_id=_plan_resource_id(result),
                    path=None if isinstance(result, Tag) else result.path,
                    operation_key=child_key,
                    message="Completed",
                )
            )
            progress = OrganizationPlanResult(
                status="partial",
                argument_digest=digest,
                completed=len(results),
                skipped=0,
                conflicted=0,
                failed=0,
                items=results,
            )
            with database.transaction() as connection:
                connection.execute(
                    """
                    UPDATE organization_plan_executions
                    SET result_json = ?, next_operation = ?, updated_at = ?
                    WHERE actor_id = ? AND idempotency_key = ?
                    """,
                    (
                        progress.model_dump_json(),
                        index + 1,
                        utc_now(),
                        principal.actor_id,
                        idempotency_key,
                    ),
                )
        completed = sum(item.status == "completed" for item in results)
        conflicted = sum(item.status == "conflicted" for item in results)
        failed = sum(item.status == "failed" for item in results)
        skipped = sum(item.status == "skipped" for item in results)
        status = (
            "completed"
            if completed == len(normalized.operations)
            else "partial"
            if completed
            else "failed"
        )
        response = OrganizationPlanResult(
            status=status,
            argument_digest=digest,
            completed=completed,
            skipped=skipped,
            conflicted=conflicted,
            failed=failed,
            items=results,
        )
        with database.transaction() as connection:
            connection.execute(
                """
                UPDATE organization_plan_executions
                SET status = ?, result_json = ?, next_operation = ?, updated_at = ?
                WHERE actor_id = ? AND idempotency_key = ?
                """,
                (
                    status,
                    response.model_dump_json(),
                    completed,
                    utc_now(),
                    principal.actor_id,
                    idempotency_key,
                ),
            )
        return response

    def organization_plan_started(self, *, actor_id: str, idempotency_key: str) -> bool:
        """Whether a plan under this key was admitted, so a retry resumes it."""
        with self.organization.database.connection() as connection:
            return (
                connection.execute(
                    "SELECT 1 FROM organization_plan_executions "
                    "WHERE actor_id = ? AND idempotency_key = ?",
                    (actor_id, idempotency_key),
                ).fetchone()
                is not None
            )

    def list_tags(self, principal: Principal) -> list[Tag]:
        def operation() -> list[Tag]:
            self._require_global_read(principal)
            return self.organization.list_tags()

        return self.audited(principal, reads("list_tags", "tag"), operation)

    def list_folders(self, principal: Principal) -> list[Folder]:
        return self.audited(
            principal, reads("list_folders", "folder"), lambda: self._visible_folders(principal)
        )

    def _visible_folders(self, principal: Principal) -> list[Folder]:
        allowed = self.policy.allowed_prefixes(principal, Capability.READ)
        if allowed == ():
            return []
        folders = self.organization.list_folders()
        if allowed is None:
            return folders
        visible: list[Folder] = []
        with self.documents.database.connection() as connection:
            for folder in folders:
                if any(path_matches(prefix, folder.path) for prefix in allowed):
                    visible.append(folder)
                elif any(path_matches(folder.path, prefix) for prefix in allowed):
                    clauses = ["d.deleted = 0"]
                    parameters: list[object] = []
                    self.documents._add_path_filter(
                        clauses,
                        parameters,
                        tuple(prefix for prefix in allowed if path_matches(folder.path, prefix)),
                    )
                    count = connection.execute(
                        "SELECT COUNT(*) FROM documents d WHERE " + " AND ".join(clauses),
                        parameters,
                    ).fetchone()[0]
                    visible.append(
                        folder.model_copy(
                            update={
                                "category": None,
                                "tags": [],
                                "metadata_version": 0,
                                "document_count": count,
                                "created_at": "",
                                "updated_at": "",
                            }
                        )
                    )
        return visible

    def create_tag(
        self, principal: Principal, *, name: str, color: str, idempotency_key: str
    ) -> Tag:
        def operation() -> Tag:
            self.policy.require_administrator(principal)
            return self.organization.create_tag(
                name=name,
                color=color,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        return self.audited(principal, writes("create", "tag"), operation)

    def create_folder(
        self,
        principal: Principal,
        *,
        path: str,
        category: str | None,
        tag_ids: list[str],
        idempotency_key: str,
    ) -> Folder:
        def operation() -> Folder:
            normalized_path = self.organization.normalize_folder_path(path)
            self.policy.require(principal, Capability.CREATE, normalized_path)
            return self.organization.create_folder(
                path=normalized_path,
                category=category,
                tag_ids=tag_ids,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        details: dict[str, object] = {"tag_ids": tag_ids}
        if category:
            details["category"] = category
        return self.audited(
            principal, writes("create", "folder"), operation, path=path, details=details
        )

    def update_folder_metadata(
        self,
        principal: Principal,
        *,
        folder_id: str,
        expected_metadata_version: int,
        category: str | None,
        tag_ids: list[str],
        idempotency_key: str,
    ) -> Folder:
        def operation() -> Folder:
            folder = next(
                (item for item in self.organization.list_folders() if item.folder_id == folder_id),
                None,
            )
            if folder is None:
                raise ConflictError(f"Folder no longer exists: {folder_id}")
            self.policy.require(principal, Capability.TAG, folder.path)
            return self.organization.update_folder_metadata(
                folder_id=folder_id,
                expected_metadata_version=expected_metadata_version,
                category=category,
                tag_ids=tag_ids,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        details: dict[str, object] = {
            "expected_metadata_version": expected_metadata_version,
            "tag_ids": tag_ids,
        }
        if category:
            details["category"] = category
        return self.audited(
            principal, writes("tag", "folder"), operation, resource_id=folder_id, details=details
        )

    def move_folder(
        self,
        principal: Principal,
        *,
        folder_id: str,
        path: str,
        idempotency_key: str,
    ) -> Folder:
        def operation() -> Folder:
            folder = next(
                (item for item in self.organization.list_folders() if item.folder_id == folder_id),
                None,
            )
            if folder is None:
                raise ConflictError(f"Folder no longer exists: {folder_id}")
            destination = self.organization.normalize_folder_path(path)
            self.policy.require(principal, Capability.MOVE, folder.path)
            self.policy.require(principal, Capability.MOVE, destination)
            return self.organization.rename_folder(
                folder_id=folder_id,
                destination_path=destination,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        return self.audited(
            principal, writes("move", "folder"), operation, resource_id=folder_id, path=path
        )

    def _normalize_organization_plan(self, plan: ApplyOrganizationPlan) -> ApplyOrganizationPlan:
        operations: list[dict[str, object]] = []
        for operation in plan.operations:
            data = operation.model_dump(mode="json")
            if isinstance(
                operation,
                (OrganizationCreateFolder, OrganizationMoveFolder),
            ):
                path_key = "path" if operation.kind == "create_folder" else "destination_path"
                data[path_key] = self.organization.normalize_folder_path(str(data[path_key]))
            if isinstance(operation, OrganizationMoveFolder):
                data["expected_source_path"] = self.organization.normalize_folder_path(
                    operation.expected_source_path
                )
            if isinstance(operation, (OrganizationMoveDocument, OrganizationMaterializeDocument)):
                if isinstance(operation, OrganizationMoveDocument):
                    data["expected_source_path"] = canonicalize_document_path(
                        operation.expected_source_path
                    )
                data["destination_path"] = canonicalize_document_path(operation.destination_path)
            if isinstance(operation, OrganizationTrashDocument):
                data["expected_source_path"] = canonicalize_document_path(
                    operation.expected_source_path
                )
            if isinstance(operation, OrganizationDuplicateDocument) and operation.destination_path:
                data["destination_path"] = canonicalize_document_path(operation.destination_path)
            if "tag_ids" in data:
                data["tag_ids"] = sorted(set(data["tag_ids"]))
            if "expected_tag_ids" in data:
                data["expected_tag_ids"] = sorted(set(data["expected_tag_ids"]))
            if "category" in data:
                category = data["category"]
                data["category"] = (
                    str(category).strip() if category and str(category).strip() else None
                )
            operations.append(data)
        return ApplyOrganizationPlan.model_validate({"operations": operations})

    def preflight_organization_plan(
        self, principal: Principal, plan: ApplyOrganizationPlan
    ) -> None:
        documents = {item.document_id: item for item in self.documents.list_documents()}
        folders = {item.folder_id: item for item in self.organization.list_folders()}
        tag_ids = {item.tag_id for item in self.organization.list_tags()}
        existing_document_paths = {
            item.path: item.document_id
            for item in documents.values()
            if item.path and not item.deleted
        }
        existing_folder_paths = {item.path: item.folder_id for item in folders.values()}
        planned_destinations: set[str] = set()
        for operation in plan.operations:
            if isinstance(operation, OrganizationCreateFolder):
                normalized_folder = self.organization.normalize_folder_path(operation.path)
                self.policy.require(principal, Capability.CREATE, normalized_folder)
                if normalized_folder in existing_folder_paths:
                    raise ConflictError(f"Destination folder already exists: {normalized_folder}")
                if normalized_folder in existing_document_paths:
                    raise ConflictError(f"Destination document already exists: {normalized_folder}")
                destination = normalized_folder
            elif isinstance(operation, OrganizationMoveDocument):
                document = documents.get(operation.document_id)
                if document is None or document.deleted:
                    raise ConflictError(f"Document no longer exists: {operation.document_id}")
                if document.path != operation.expected_source_path:
                    raise ConflictError(
                        "Document source path changed",
                        details={
                            "document_id": operation.document_id,
                            "current_path": document.path,
                        },
                    )
                if document.current_revision_id != operation.expected_revision_id:
                    raise ConflictError(
                        "Document revision changed",
                        details={
                            "document_id": operation.document_id,
                            "current_revision_id": document.current_revision_id,
                        },
                    )
                normalized_destination = self.documents.normalize_document_path(
                    operation.destination_path
                )
                if normalized_destination == document.path:
                    raise ValidationError("An organization plan cannot contain a no-op move")
                self.documents._validate_path_type(normalized_destination, document.content_type)
                self.policy.require(principal, Capability.MOVE, document.path)
                self.policy.require(principal, Capability.MOVE, normalized_destination)
                owner = existing_document_paths.get(normalized_destination)
                if owner is not None and owner != operation.document_id:
                    raise ConflictError(
                        f"Destination document already exists: {normalized_destination}"
                    )
                if normalized_destination in existing_folder_paths:
                    raise ConflictError(
                        f"Destination folder already exists: {normalized_destination}"
                    )
                destination = normalized_destination
            elif isinstance(operation, OrganizationMaterializeDocument):
                document = documents.get(operation.document_id)
                if document is None or document.deleted:
                    raise ConflictError(f"Document no longer exists: {operation.document_id}")
                if document.path is not None:
                    raise ConflictError(
                        "Document is already materialized",
                        details={
                            "document_id": operation.document_id,
                            "current_path": document.path,
                        },
                    )
                if document.current_revision_id != operation.expected_revision_id:
                    raise ConflictError(
                        "Document revision changed",
                        details={
                            "document_id": operation.document_id,
                            "current_revision_id": document.current_revision_id,
                        },
                    )
                if document.content_type == "application/pdf":
                    raise ValidationError("PDFs are materialized when they are imported")
                normalized_destination = self.documents.normalize_document_path(
                    operation.destination_path
                )
                self.documents._validate_path_type(normalized_destination, document.content_type)
                self.policy.require(principal, Capability.MOVE, None)
                self.policy.require(principal, Capability.MOVE, normalized_destination)
                owner = existing_document_paths.get(normalized_destination)
                if owner is not None and owner != operation.document_id:
                    raise ConflictError(
                        f"Destination document already exists: {normalized_destination}"
                    )
                if normalized_destination in existing_folder_paths:
                    raise ConflictError(
                        f"Destination folder already exists: {normalized_destination}"
                    )
                destination = normalized_destination
            elif isinstance(operation, OrganizationTrashDocument):
                document = documents.get(operation.document_id)
                if document is None or document.deleted:
                    raise ConflictError(f"Document no longer exists: {operation.document_id}")
                if document.path != operation.expected_source_path:
                    raise ConflictError(
                        "Document source path changed",
                        details={
                            "document_id": operation.document_id,
                            "current_path": document.path,
                        },
                    )
                if document.current_revision_id != operation.expected_revision_id:
                    raise ConflictError(
                        "Document revision changed",
                        details={
                            "document_id": operation.document_id,
                            "current_revision_id": document.current_revision_id,
                        },
                    )
                self.policy.require(principal, Capability.DELETE, document.path)
                destination = ""
            elif isinstance(operation, OrganizationCreateTag):
                self.policy.require_administrator(principal)
                clash = next(
                    (
                        tag
                        for tag in self.organization.list_tags()
                        if tag.name.casefold() == " ".join(operation.name.split()).casefold()
                    ),
                    None,
                )
                if clash is not None:
                    raise ConflictError(
                        f"Tag already exists: {clash.name}",
                        details={"tag_id": clash.tag_id},
                    )
                destination = ""
            elif isinstance(operation, OrganizationRestoreDocument):
                try:
                    document = self.documents.get_document(
                        operation.document_id, include_deleted=True
                    )
                except NotFoundError as error:
                    raise ConflictError(
                        f"Document no longer exists: {operation.document_id}"
                    ) from error
                if document.current_revision_id != operation.expected_revision_id:
                    raise ConflictError(
                        "Document revision changed",
                        details={
                            "document_id": operation.document_id,
                            "current_revision_id": document.current_revision_id,
                        },
                    )
                self.policy.require(principal, Capability.RESTORE, document.path)
                if document.content_type == "application/pdf":
                    if not document.deleted:
                        raise ValidationError(
                            "Immutable PDF source bytes cannot be restored as text revisions"
                        )
                else:
                    self.documents.revision_content(operation.document_id, operation.revision_id)
                destination = ""
                if document.deleted and document.path:
                    owner = existing_document_paths.get(document.path)
                    if owner is not None and owner != operation.document_id:
                        raise ConflictError(f"Destination document already exists: {document.path}")
                    if document.path in existing_folder_paths:
                        raise ConflictError(f"Destination folder already exists: {document.path}")
                    destination = document.path
            elif isinstance(operation, OrganizationDuplicateDocument):
                document = documents.get(operation.document_id)
                if document is None or document.deleted:
                    raise ConflictError(f"Document no longer exists: {operation.document_id}")
                if document.current_revision_id != operation.expected_revision_id:
                    raise ConflictError(
                        "Document revision changed",
                        details={
                            "document_id": operation.document_id,
                            "current_revision_id": document.current_revision_id,
                        },
                    )
                self.policy.require(principal, Capability.READ, document.path)
                target = operation.destination_path or default_duplicate_path(document)
                destination = ""
                if target:
                    destination = self.documents.normalize_document_path(target)
                    self.documents._validate_path_type(destination, document.content_type)
                    if destination in existing_document_paths:
                        raise ConflictError(f"Destination document already exists: {destination}")
                    if destination in existing_folder_paths:
                        raise ConflictError(f"Destination folder already exists: {destination}")
                self.policy.require(principal, Capability.CREATE, destination or None)
            elif isinstance(operation, OrganizationMoveFolder):
                folder = folders.get(operation.folder_id)
                if folder is None:
                    raise ConflictError(f"Folder no longer exists: {operation.folder_id}")
                if folder.path != operation.expected_source_path:
                    raise ConflictError(
                        "Folder source path changed",
                        details={"folder_id": operation.folder_id, "current_path": folder.path},
                    )
                if folder.document_count != operation.expected_descendant_documents:
                    raise ConflictError(
                        "Folder contents changed",
                        details={
                            "folder_id": operation.folder_id,
                            "current_descendant_documents": folder.document_count,
                        },
                    )
                normalized_destination = self.organization.normalize_folder_path(
                    operation.destination_path
                )
                if normalized_destination == folder.path:
                    raise ValidationError("An organization plan cannot contain a no-op move")
                if path_matches(folder.path, normalized_destination):
                    raise ValidationError("A folder cannot be moved inside itself")
                self.policy.require(principal, Capability.MOVE, folder.path)
                self.policy.require(principal, Capability.MOVE, normalized_destination)
                owner = existing_folder_paths.get(normalized_destination)
                if owner is not None and owner != operation.folder_id:
                    raise ConflictError(
                        f"Destination folder already exists: {normalized_destination}"
                    )
                if normalized_destination in existing_document_paths:
                    raise ConflictError(
                        f"Destination document already exists: {normalized_destination}"
                    )
                destination = normalized_destination
            elif isinstance(operation, OrganizationUpdateDocumentMetadata):
                document = documents.get(operation.document_id)
                if document is None:
                    raise ConflictError(f"Document no longer exists: {operation.document_id}")
                if document.metadata_version != operation.expected_metadata_version:
                    raise ConflictError("Document metadata changed")
                if (
                    document.category != operation.expected_category
                    or sorted(tag.tag_id for tag in document.tags) != operation.expected_tag_ids
                ):
                    raise ConflictError("Document metadata no longer matches the reviewed plan")
                if (
                    operation.category == operation.expected_category
                    and operation.tag_ids == operation.expected_tag_ids
                ):
                    raise ValidationError(
                        "An organization plan cannot contain a no-op metadata update"
                    )
                self.policy.require(principal, Capability.TAG, document.path)
                destination = ""
            elif isinstance(operation, OrganizationUpdateFolderMetadata):
                folder = folders.get(operation.folder_id)
                if folder is None:
                    raise ConflictError(f"Folder no longer exists: {operation.folder_id}")
                if folder.metadata_version != operation.expected_metadata_version:
                    raise ConflictError("Folder metadata changed")
                if (
                    folder.category != operation.expected_category
                    or sorted(tag.tag_id for tag in folder.tags) != operation.expected_tag_ids
                ):
                    raise ConflictError("Folder metadata no longer matches the reviewed plan")
                if (
                    operation.category == operation.expected_category
                    and operation.tag_ids == operation.expected_tag_ids
                ):
                    raise ValidationError(
                        "An organization plan cannot contain a no-op metadata update"
                    )
                self.policy.require(principal, Capability.TAG, folder.path)
                destination = ""
            else:
                raise ValidationError("Unsupported organization operation")
            operation_tags = getattr(operation, "tag_ids", [])
            missing_tags = [tag_id for tag_id in operation_tags if tag_id not in tag_ids]
            if missing_tags:
                raise ValidationError(
                    "One or more tags do not exist", details={"tag_ids": missing_tags}
                )
            if destination:
                if destination in planned_destinations:
                    raise ConflictError(f"Two operations target the same path: {destination}")
                planned_destinations.add(destination)

    _preflight_organization_plan = preflight_organization_plan

    def _execute_organization_operation(
        self,
        principal: Principal,
        *,
        operation: OrganizationCreateFolder
        | OrganizationMoveDocument
        | OrganizationMaterializeDocument
        | OrganizationTrashDocument
        | OrganizationRestoreDocument
        | OrganizationDuplicateDocument
        | OrganizationCreateTag
        | OrganizationMoveFolder
        | OrganizationUpdateDocumentMetadata
        | OrganizationUpdateFolderMetadata,
        idempotency_key: str,
    ) -> Document | Folder | Tag:
        if isinstance(operation, OrganizationCreateFolder):
            return self.create_folder(
                principal,
                path=operation.path,
                category=operation.category,
                tag_ids=operation.tag_ids,
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationMoveDocument):
            return self.write_document(
                principal,
                document_id=operation.document_id,
                action="move",
                body=PathMutation(
                    expected_revision_id=operation.expected_revision_id,
                    path=operation.destination_path,
                    summary="Applied workspace organization plan",
                ),
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationMaterializeDocument):
            return self.write_document(
                principal,
                document_id=operation.document_id,
                action="materialize",
                body=PathMutation(
                    expected_revision_id=operation.expected_revision_id,
                    path=operation.destination_path,
                    summary="Saved draft through workspace organization plan",
                ),
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationTrashDocument):
            return self.write_document(
                principal,
                document_id=operation.document_id,
                action="delete",
                body=DeleteDocument(
                    expected_revision_id=operation.expected_revision_id,
                    summary="Moved to trash by workspace organization plan",
                ),
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationCreateTag):
            return self.create_tag(
                principal,
                name=operation.name,
                color=operation.color,
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationRestoreDocument):
            return self.write_document(
                principal,
                document_id=operation.document_id,
                action="restore",
                body=RestoreDocument(
                    expected_revision_id=operation.expected_revision_id,
                    revision_id=operation.revision_id,
                    summary="Restored by workspace organization plan",
                ),
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationDuplicateDocument):
            return self.write_document(
                principal,
                document_id=operation.document_id,
                action="duplicate",
                body=DuplicateDocument(
                    expected_revision_id=operation.expected_revision_id,
                    title=operation.title,
                    path=operation.destination_path,
                ),
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationMoveFolder):
            return self.move_folder(
                principal,
                folder_id=operation.folder_id,
                path=operation.destination_path,
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationUpdateDocumentMetadata):
            return self.write_document(
                principal,
                document_id=operation.document_id,
                action="tag",
                body=UpdateDocumentMetadata(
                    expected_metadata_version=operation.expected_metadata_version,
                    category=operation.category,
                    tag_ids=operation.tag_ids,
                ),
                idempotency_key=idempotency_key,
            )
        return self.update_folder_metadata(
            principal,
            folder_id=operation.folder_id,
            expected_metadata_version=operation.expected_metadata_version,
            category=operation.category,
            tag_ids=operation.tag_ids,
            idempotency_key=idempotency_key,
        )

    def _document_operation(
        self,
        principal: Principal,
        *,
        capability: Capability,
        action: Action,
        current: Document,
        operation: Callable[[], T],
        details: dict[str, object] | None = None,
        estimated_bytes: int | None = None,
    ) -> T:
        def authorized() -> T:
            self.policy.require(principal, capability, current.path)
            return operation()

        return self.audited(
            principal,
            action,
            authorized,
            resource_id=current.document_id,
            path=current.path,
            details=details,
            estimated_bytes=estimated_bytes,
        )

    def _require_global_read(self, principal: Principal) -> None:
        self.policy.require(principal, Capability.READ, None)

    def _authorize_destination_path(
        self,
        principal: Principal,
        *,
        capability: Capability,
        path: str | None,
    ) -> str | None:
        normalized_path = canonicalize_document_path(path) if path is not None else None
        self.policy.require(principal, capability, normalized_path)
        return normalized_path

    def audited(
        self,
        principal: Principal,
        action: Action,
        operation: Callable[[], T],
        *,
        resource_id: str | None = None,
        path: str | None = None,
        details: dict[str, object] | None = None,
        estimated_bytes: int | None = None,
        subject: Callable[[T], str] | None = None,
    ) -> T:
        """Run one operation under the activity-ledger contract.

        A mutation writes exactly one ledger row: inside the first storage
        transaction it commits (naming whatever that transaction passed to
        ``Database.set_audit_target``), or after the operation returns when it
        committed nothing. Denials, conflicts, and failures are recorded too.
        Reads are recorded only for non-human principals. ``subject`` names the
        resource of a returned value the ledger cannot otherwise identify.
        """
        name = action.name
        resource_type = action.resource_type
        is_mutation = action.mutation
        if principal.via or principal.approved_by:
            details = {
                **(details or {}),
                **({"via": principal.via} if principal.via else {}),
                **({"approved_by": principal.approved_by} if principal.approved_by else {}),
            }
        if estimated_bytes is None:
            estimated_bytes = 2048
            if details:
                with suppress(Exception):
                    estimated_bytes = max(
                        estimated_bytes,
                        self.activity.estimate_payload_bytes(details),
                    )
        with self.activity.admit(estimated_bytes=estimated_bytes) as reservation:
            audit_inserted = False
            audit_committed = False
            recorded_resource_id = resource_id
            recorded_path = path
            recorded_revision_id = None
            recorded_details = dict(details or {})

            def audit_commit_hook(connection: sqlite3.Connection) -> None:
                nonlocal \
                    audit_inserted, \
                    recorded_resource_id, \
                    recorded_path, \
                    recorded_revision_id, \
                    recorded_details
                if not audit_inserted and is_mutation:
                    target = self.documents.database.get_audit_target()
                    hook_resource_id = target.get("resource_id") or resource_id
                    hook_revision_id = target.get("revision_id")
                    hook_path = target.get("path") if target.get("path") is not None else path
                    hook_details = dict(details or {})
                    if "details" in target and isinstance(target["details"], dict):
                        hook_details.update(target["details"])

                    reservation.record_with_connection(
                        connection,
                        principal=principal,
                        action=name,
                        resource_type=resource_type,
                        resource_id=hook_resource_id,
                        path=hook_path,
                        outcome="accepted",
                        revision_id=hook_revision_id,
                        details=hook_details or None,
                    )
                    audit_inserted = True
                    recorded_resource_id = hook_resource_id
                    recorded_path = hook_path
                    recorded_revision_id = hook_revision_id
                    recorded_details = hook_details

            def audit_post_commit_hook() -> None:
                nonlocal audit_committed
                if audit_inserted:
                    audit_committed = True

            try:
                with (
                    self.documents.database.commit_hook(audit_commit_hook),
                    self.documents.database.post_commit_hook(audit_post_commit_hook),
                ):
                    result = operation()
            except _RetryHttpMutation:
                # The operation has unwound its locks and commit hooks without
                # writing. Admission releases this unused ticket before retry.
                raise
            except Exception as error:
                audit_err: Exception | None = None
                if audit_committed:
                    error_code = getattr(error, "code", "INTERNAL_ERROR")
                    fail_details = dict(recorded_details)
                    fail_details["stage"] = "materialization"
                    fail_details["error"] = str(error)
                    try:
                        self.activity.record(
                            principal=principal,
                            action=name,
                            resource_type=resource_type,
                            resource_id=recorded_resource_id,
                            path=recorded_path,
                            outcome="failed",
                            error_code=error_code,
                            revision_id=recorded_revision_id,
                            details=fail_details,
                        )
                    except Exception as ae:
                        audit_err = ae
                elif audit_inserted or reservation.spent:
                    outcome = (
                        "denied"
                        if isinstance(error, AuthorizationError)
                        else "conflict"
                        if isinstance(error, ConflictError)
                        else "failed"
                    )
                    fail_details = dict(recorded_details)
                    if isinstance(error, SangamError) and error.details:
                        fail_details.update(error.details)
                    fail_details["stage"] = "commit" if audit_inserted else "mutation"
                    fail_details["error"] = str(error)
                    try:
                        self.activity.record(
                            principal=principal,
                            action=name,
                            resource_type=resource_type,
                            resource_id=recorded_resource_id or resource_id,
                            path=recorded_path or path,
                            outcome=outcome,
                            error_code=getattr(error, "code", "INTERNAL_ERROR"),
                            details=fail_details or None,
                        )
                    except Exception as ae:
                        audit_err = ae
                else:
                    outcome = (
                        "denied"
                        if isinstance(error, AuthorizationError)
                        else "conflict"
                        if isinstance(error, ConflictError)
                        else "failed"
                    )
                    combined_details = dict(details or {})
                    if isinstance(error, SangamError) and error.details:
                        combined_details.update(error.details)
                    try:
                        reservation.record(
                            principal=principal,
                            action=name,
                            resource_type=resource_type,
                            resource_id=resource_id,
                            path=path,
                            outcome=outcome,
                            error_code=getattr(error, "code", "INTERNAL_ERROR"),
                            details=combined_details or None,
                        )
                    except Exception as ae:
                        audit_err = ae

                if audit_err is not None:
                    if isinstance(error, SangamError):
                        error.details["audit_persisted"] = False
                        error.details["audit_error"] = str(audit_err)
                    raise error from audit_err
                raise

            if not audit_committed and (is_mutation or principal.identity_kind != "human"):
                result_resource_id = resource_id
                result_path = path
                revision_id = None
                if isinstance(result, Document):
                    result_resource_id = result.document_id
                    result_path = result.path if result.path is not None else path
                    revision_id = result.current_revision_id
                elif isinstance(result, Folder):
                    result_resource_id = result.folder_id
                    result_path = result.path if result.path is not None else path
                elif isinstance(result, (Publication, IssuedPublication)):
                    result_resource_id = result.publication_id
                elif subject is not None:
                    result_resource_id = subject(result)
                reservation.record(
                    principal=principal,
                    action=name,
                    resource_type=resource_type,
                    resource_id=result_resource_id,
                    path=result_path,
                    outcome="accepted",
                    revision_id=revision_id,
                    details=details,
                )
            return result
