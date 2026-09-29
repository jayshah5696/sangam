from __future__ import annotations

import difflib
import json
import sqlite3
import uuid
from collections.abc import Callable, Iterator
from contextlib import suppress
from pathlib import PurePosixPath
from typing import TypeVar

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
from sangam.errors import (
    AuthorizationError,
    ConflictError,
    IdempotencyError,
    SangamError,
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
    Document,
    DocumentSummary,
    Folder,
    IssuedPublication,
    OrganizationCreateFolder,
    OrganizationDocumentSnapshot,
    OrganizationFolderSnapshot,
    OrganizationMaterializeDocument,
    OrganizationMoveDocument,
    OrganizationMoveFolder,
    OrganizationPlanItemResult,
    OrganizationPlanResult,
    OrganizationSnapshotPage,
    OrganizationTagSnapshot,
    OrganizationTrashDocument,
    OrganizationUpdateDocumentMetadata,
    OrganizationUpdateFolderMetadata,
    PdfPage,
    PdfRect,
    PdfSearchResult,
    Publication,
    PublicationRevision,
    Revision,
    RevisionDiff,
    Tag,
)
from sangam.security import Principal, path_matches, sanitize_sensitive_text
from sangam.service import DocumentService
from sangam.workspace import canonicalize_document_path

T = TypeVar("T")


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

        return self._run(principal, "read", "document", operation, resource_id=document_id)

    def http_document_mutation(
        self,
        principal: Principal,
        *,
        document_id: str,
        action: str,
        payload: dict[str, object],
        if_match: str | None,
        if_none_match: str | None,
        idempotency_key: str,
        operation: Callable[[str], Document],
    ) -> Document:
        """Authorize fresh paths, then evaluate HTTP conditions in storage transactions."""
        details = dict(payload)

        def authorized() -> Document:
            with self.documents.mutations.document(document_id):
                current = self.documents.get_document(document_id, include_deleted=True)
                capability = {
                    "update": Capability.UPDATE,
                    "duplicate": Capability.READ,
                    "move": Capability.MOVE,
                    "materialize": Capability.MOVE,
                    "delete": Capability.DELETE,
                    "restore": Capability.RESTORE,
                    "tag": Capability.TAG,
                }.get(action)
                if action == "trust":
                    if not principal.administrator:
                        raise AuthorizationError("Document trust requires administrator access")
                elif capability is not None:
                    self.policy.require(principal, capability, current.path)
                else:
                    raise ValidationError("Unsupported conditional document operation")
                if action in {"move", "materialize", "duplicate"}:
                    details["source_path"] = current.path
                    destination = payload.get("path")
                    if (
                        action == "duplicate"
                        and destination is None
                        and current.content_type == "application/pdf"
                        and current.path
                    ):
                        source = PurePosixPath(current.path)
                        destination = (
                            source.parent / f"{source.stem} copy{source.suffix}"
                        ).as_posix()
                    self._authorize_destination_path(
                        principal,
                        capability=Capability.CREATE if action == "duplicate" else Capability.MOVE,
                        path=destination,
                    )
                    details["destination_path"] = destination
                conditions = Preconditions.parse(if_match, if_none_match)
                has_conditions = if_match is not None or if_none_match is not None
                expected = payload.get("expected_revision_id")
                if action not in {"trust", "tag"} and expected is None and not has_conditions:
                    raise ValidationError(
                        "expected_revision_id in body or HTTP condition is required"
                    )

                if action in {"update", "duplicate", "restore"}:
                    content = payload.get("content", current.content)
                    if action == "restore":
                        details["current_revision_id"] = payload.get("revision_id")
                        with self.documents.database.connection() as connection:
                            row = connection.execute(
                                "SELECT content FROM revisions "
                                "WHERE document_id = ? AND revision_id = ?",
                                (document_id, payload.get("revision_id")),
                            ).fetchone()
                            content = row["content"] if row else ""
                    diff, added, removed, meta = compute_document_diff(
                        "" if action == "duplicate" else current.content,
                        content,
                        fromfile=current.current_revision_id,
                        tofile="current",
                    )
                    details.update(diff=diff, lines_added=added, lines_removed=removed, **meta)

                if not has_conditions:
                    return operation(expected or current.current_revision_id)
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
                    replay = connection.execute(
                        "SELECT request_hash, document_id AS resource_id FROM idempotency_keys "
                        "WHERE actor_id = ? AND idempotency_key = ? UNION ALL "
                        "SELECT request_hash, resource_id FROM mutation_idempotency_keys "
                        "WHERE actor_id = ? AND idempotency_key = ?",
                        (principal.actor_id, idempotency_key, principal.actor_id, idempotency_key),
                    ).fetchone()
                    if replay:
                        if replay["request_hash"] != fingerprint:
                            raise IdempotencyError(
                                "Idempotency key was already used for a different mutation"
                            )
                        with self.documents.mutations.document(replay["resource_id"]):
                            result = self.documents.get_document(
                                replay["resource_id"], include_deleted=True
                            )
                            if action == "duplicate":
                                self.policy.require(principal, Capability.CREATE, result.path)
                            self.documents._finish_if_current(
                                result.document_id, result.current_revision_id
                            )
                            result = self.documents.get_document(
                                result.document_id, include_deleted=True
                            )
                            with self.documents.database.transaction():
                                self.documents.database.set_audit_target(
                                    resource_id=result.document_id,
                                    revision_id=result.current_revision_id,
                                    path=result.path,
                                )
                                self.documents.search_index.sync(result)
                            return result

                def validate(connection: sqlite3.Connection) -> None:
                    snapshot = self.documents._get_document_in_connection(
                        connection, document_id, include_deleted=True
                    )
                    conditions.evaluate(document_etag(snapshot))

                # Validate before any filesystem side effect, then again in the
                # committing storage transaction through its replay lookup.
                with self.documents.database.connection() as connection:
                    validate(connection)
                with conditional_mutation(ConditionalMutation(fingerprint, validate)):
                    return operation(expected or current.current_revision_id)

        return self._run(
            principal, action, "document", authorized, resource_id=document_id, details=details
        )

    def __init__(
        self,
        *,
        documents: DocumentService,
        organization: WorkspaceOrganizationService,
        policy: AuthorizationPolicy,
        activity: ActivityService,
        publications: PublicationService,
        pdf_research: PdfResearchService,
    ) -> None:
        self.documents = documents
        self.organization = organization
        self.policy = policy
        self.activity = activity
        self.publications = publications
        self.pdf_research = pdf_research

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
        content: bytes,
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

        details: dict[str, object] = {"title": title, "content_type": "application/pdf"}
        if supersedes_document_id:
            details["supersedes_document_id"] = supersedes_document_id
        return self._run(principal, "import", "pdf_document", operation, path=path, details=details)

    def pdf_bytes(self, principal: Principal, document_id: str) -> tuple[Document, bytes]:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action="read_pdf",
            current=current,
            operation=lambda: self.pdf_research.pdf_bytes(document_id),
        )

    def pdf_stream_info(self, principal: Principal, document_id: str) -> tuple[Document, int]:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action="read_pdf",
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
            action="read_pdf_text",
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

        return self._run(
            principal,
            "search_pdf",
            "pdf_document",
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
            action="list_annotations",
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
            action="annotate",
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
            action="annotate",
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
            action="annotate",
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
            action="annotation_history",
            current=current,
            operation=lambda: self.pdf_research.annotation_history(annotation_id),
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

        return self._run(principal, "list", "document", operation)

    def search_documents(
        self,
        principal: Principal,
        *,
        query: str,
        tag_id: str | None,
        category: str | None,
        actor_id: str | None,
        sort: str,
        limit: int = 50,
        offset: int = 0,
    ) -> list[DocumentSummary]:
        def operation() -> list[DocumentSummary]:
            return self.documents.search_documents(
                query=query,
                tag_id=tag_id,
                category=category,
                actor_id=actor_id,
                sort=sort,
                path_prefixes=self.policy.allowed_prefixes(
                    principal, Capability.READ, Capability.SEARCH
                ),
                limit=limit,
                offset=offset,
            )

        return self._run(principal, "search", "document", operation)

    def get_document(
        self, principal: Principal, document_id: str, *, include_deleted: bool = False
    ) -> Document:
        document = self.documents.get_document(document_id, include_deleted=include_deleted)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action="read",
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
            "title": title,
            "content_type": content_type,
            "diff": diff_text,
            "lines_added": lines_added,
            "lines_removed": lines_removed,
            **meta,
        }
        return self._run(principal, "create", "document", operation, path=path, details=details)

    def create_publication(
        self,
        principal: Principal,
        *,
        document_id: str,
        slug: str,
        access_policy: str,
        idempotency_key: str,
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
            )

        details: dict[str, object] = {"slug": slug, "access_policy": access_policy}
        return self._run(
            principal,
            "publish",
            "publication",
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

    def update_publication(
        self,
        principal: Principal,
        *,
        publication_id: str,
        expected_version: int,
        slug: str,
        access_policy: str,
        idempotency_key: str,
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
            )

        details: dict[str, object] = {
            "expected_metadata_version": expected_version,
            "slug": slug,
            "access_policy": access_policy,
        }
        return self._run(
            principal,
            "publish",
            "publication",
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
        return self._run(
            principal,
            "unpublish",
            "publication",
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
        return self._run(
            principal,
            "expose_revision",
            "publication",
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

        return self._run(
            principal,
            "rotate_token",
            "publication",
            operation,
            resource_id=publication_id,
            path=current.path,
        )

    def update_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        content: str,
        title: str | None,
        summary: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)
        diff_text, lines_added, lines_removed, meta = compute_document_diff(
            current.content,
            content,
            fromfile=current.current_revision_id or "before",
            tofile="current",
        )
        details: dict[str, object] = {
            "expected_revision_id": expected_revision_id,
            "diff": diff_text,
            "lines_added": lines_added,
            "lines_removed": lines_removed,
            **meta,
        }
        if title is not None:
            details["title"] = title
        if summary is not None:
            details["summary"] = summary
        return self._document_operation(
            principal,
            capability=Capability.UPDATE,
            action="update",
            current=current,
            operation=lambda: self.documents.update_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                content=content,
                title=title,
                summary=summary,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
            details=details,
        )

    def duplicate_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        title: str | None,
        path: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)

        def operation() -> Document:
            self.policy.require(principal, Capability.READ, current.path)
            destination_path = path
            if (
                destination_path is None
                and current.content_type == "application/pdf"
                and current.path
            ):
                source_parts = PurePosixPath(current.path)
                candidate_name = f"{source_parts.stem} copy{source_parts.suffix}"
                destination_path = (
                    (source_parts.parent / candidate_name).as_posix()
                    if source_parts.parent != PurePosixPath(".")
                    else candidate_name
                )
            authorized_path = self._authorize_destination_path(
                principal, capability=Capability.CREATE, path=destination_path
            )
            return self.documents.duplicate_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                title=title,
                path=authorized_path,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        diff_text, lines_added, lines_removed, meta = compute_document_diff(
            "",
            current.content,
            fromfile="empty",
            tofile="current",
        )
        details: dict[str, object] = {
            "expected_revision_id": expected_revision_id,
            "source_path": current.path,
            "diff": diff_text,
            "lines_added": lines_added,
            "lines_removed": lines_removed,
            **meta,
        }
        if path:
            details["destination_path"] = path
        if title is not None:
            details["title"] = title
        return self._run(
            principal,
            "duplicate",
            "document",
            operation,
            resource_id=document_id,
            path=path,
            details=details,
        )

    def update_document_metadata(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_metadata_version: int,
        category: str | None,
        tag_ids: list[str],
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)
        details: dict[str, object] = {
            "expected_metadata_version": expected_metadata_version,
            "tag_ids": tag_ids,
        }
        if category is not None:
            details["category"] = category
        return self._document_operation(
            principal,
            capability=Capability.TAG,
            action="tag",
            current=current,
            operation=lambda: self.documents.update_document_metadata(
                document_id=document_id,
                expected_metadata_version=expected_metadata_version,
                category=category,
                tag_ids=tag_ids,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
            details=details,
        )

    def materialize_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        path: str,
        summary: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)

        def operation() -> Document:
            self.policy.require(principal, Capability.MOVE, current.path)
            authorized_path = self._authorize_destination_path(
                principal, capability=Capability.MOVE, path=path
            )
            return self.documents.materialize_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                path=authorized_path,
                summary=summary,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        details: dict[str, object] = {
            "expected_revision_id": expected_revision_id,
            "source_path": current.path,
            "destination_path": path,
        }
        if summary:
            details["summary"] = summary
        return self._run(
            principal,
            "materialize",
            "document",
            operation,
            resource_id=document_id,
            path=path,
            details=details,
        )

    def move_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        path: str,
        summary: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)

        def operation() -> Document:
            self.policy.require(principal, Capability.MOVE, current.path)
            authorized_path = self._authorize_destination_path(
                principal, capability=Capability.MOVE, path=path
            )
            return self.documents.move_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                path=authorized_path,
                summary=summary,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        details: dict[str, object] = {
            "expected_revision_id": expected_revision_id,
            "source_path": current.path,
            "destination_path": path,
        }
        if summary:
            details["summary"] = summary
        return self._run(
            principal,
            "move",
            "document",
            operation,
            resource_id=document_id,
            path=path,
            details=details,
        )

    def delete_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        summary: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)
        details: dict[str, object] = {"expected_revision_id": expected_revision_id}
        if summary:
            details["summary"] = summary
        return self._document_operation(
            principal,
            capability=Capability.DELETE,
            action="delete",
            current=current,
            operation=lambda: self.documents.delete_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                summary=summary,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
            details=details,
        )

    def history(self, principal: Principal, document_id: str) -> list[Revision]:
        current = self.documents.get_document(document_id, include_deleted=True)

        return self._document_operation(
            principal,
            capability=Capability.READ,
            action="history",
            current=current,
            operation=lambda: self.documents.history(document_id),
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
            action="diff",
            current=current,
            operation=lambda: self.documents.revision_diff(
                document_id=document_id,
                from_revision_id=from_revision_id,
                to_revision_id=to_revision_id,
            ),
        )

    def restore_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        revision_id: str,
        summary: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id, include_deleted=True)
        target_content = ""
        with self.documents.database.connection() as conn:
            row = conn.execute(
                "SELECT content FROM revisions WHERE revision_id = ? AND document_id = ?",
                (revision_id, document_id),
            ).fetchone()
            if row:
                target_content = row["content"]
        diff_text, lines_added, lines_removed, meta = compute_document_diff(
            current.content,
            target_content,
            fromfile=current.current_revision_id or "before",
            tofile=revision_id,
        )
        details: dict[str, object] = {
            "expected_revision_id": expected_revision_id,
            "current_revision_id": revision_id,
            "diff": diff_text,
            "lines_added": lines_added,
            "lines_removed": lines_removed,
            **meta,
        }
        if summary:
            details["summary"] = summary
        return self._document_operation(
            principal,
            capability=Capability.RESTORE,
            action="restore",
            current=current,
            operation=lambda: self.documents.restore_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                revision_id=revision_id,
                summary=summary,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
            details=details,
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
        return self._run(
            principal,
            "list_organization",
            "workspace",
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
                if not self._organization_operation_recorded(principal.actor_id, child_key):
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
                        resource_type=("document" if "document" in operation.kind else "folder"),
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
                            resource_type=("document" if "document" in skipped.kind else "folder"),
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
                    resource_type="document" if "document" in operation.kind else "folder",
                    resource_id=result.document_id
                    if isinstance(result, Document)
                    else result.folder_id,
                    path=result.path,
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

    def _organization_operation_recorded(self, actor_id: str, operation_key: str) -> bool:
        """Detect a child commit before replaying after an interrupted response."""
        with self.organization.database.connection() as connection:
            document = connection.execute(
                "SELECT 1 FROM idempotency_keys WHERE actor_id = ? AND idempotency_key = ?",
                (actor_id, operation_key),
            ).fetchone()
            organization = connection.execute(
                """
                SELECT 1 FROM mutation_idempotency_keys
                WHERE actor_id = ? AND idempotency_key = ? AND completed_at IS NOT NULL
                """,
                (actor_id, operation_key),
            ).fetchone()
        return document is not None or organization is not None

    def list_tags(self, principal: Principal) -> list[Tag]:
        def operation() -> list[Tag]:
            self._require_global_read(principal)
            return self.organization.list_tags()

        return self._run(principal, "list_tags", "tag", operation)

    def list_folders(self, principal: Principal) -> list[Folder]:
        return self._run(
            principal, "list_folders", "folder", lambda: self._visible_folders(principal)
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

        return self._run(principal, "create", "tag", operation)

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
        return self._run(principal, "create", "folder", operation, path=path, details=details)

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
        return self._run(
            principal, "tag", "folder", operation, resource_id=folder_id, details=details
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

        return self._run(principal, "move", "folder", operation, resource_id=folder_id, path=path)

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
        | OrganizationMoveFolder
        | OrganizationUpdateDocumentMetadata
        | OrganizationUpdateFolderMetadata,
        idempotency_key: str,
    ) -> Document | Folder:
        if isinstance(operation, OrganizationCreateFolder):
            return self.create_folder(
                principal,
                path=operation.path,
                category=operation.category,
                tag_ids=operation.tag_ids,
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationMoveDocument):
            return self.move_document(
                principal,
                document_id=operation.document_id,
                expected_revision_id=operation.expected_revision_id,
                path=operation.destination_path,
                summary="Applied workspace organization plan",
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationMaterializeDocument):
            return self.materialize_document(
                principal,
                document_id=operation.document_id,
                expected_revision_id=operation.expected_revision_id,
                path=operation.destination_path,
                summary="Saved draft through workspace organization plan",
                idempotency_key=idempotency_key,
            )
        if isinstance(operation, OrganizationTrashDocument):
            return self.delete_document(
                principal,
                document_id=operation.document_id,
                expected_revision_id=operation.expected_revision_id,
                summary="Moved to trash by workspace organization plan",
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
            return self.update_document_metadata(
                principal,
                document_id=operation.document_id,
                expected_metadata_version=operation.expected_metadata_version,
                category=operation.category,
                tag_ids=operation.tag_ids,
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
        action: str,
        current: Document,
        operation: Callable[[], T],
        details: dict[str, object] | None = None,
        estimated_bytes: int | None = None,
    ) -> T:
        def authorized() -> T:
            self.policy.require(principal, capability, current.path)
            return operation()

        return self._run(
            principal,
            action,
            "document",
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

    def _run(
        self,
        principal: Principal,
        action: str,
        resource_type: str,
        operation: Callable[[], T],
        *,
        resource_id: str | None = None,
        path: str | None = None,
        details: dict[str, object] | None = None,
        estimated_bytes: int | None = None,
    ) -> T:
        is_mutation = action not in {
            "list",
            "search",
            "read",
            "history",
            "diff",
            "list_tags",
            "list_folders",
            "list_organization",
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
                        action=action,
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
                            action=action,
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
                elif (
                    audit_inserted
                    or getattr(reservation, "_used", False)
                    or getattr(reservation, "_released", False)
                ):
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
                            action=action,
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
                            action=action,
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
                reservation.record(
                    principal=principal,
                    action=action,
                    resource_type=resource_type,
                    resource_id=result_resource_id,
                    path=result_path,
                    outcome="accepted",
                    revision_id=revision_id,
                    details=details,
                )
            return result
