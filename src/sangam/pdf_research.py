from __future__ import annotations

import hashlib
import io
import json
import re
import sqlite3
import uuid

from pypdf import PdfReader

from sangam.actors import ActorService
from sangam.db import Database, utc_now
from sangam.errors import ConflictError, NotFoundError, ValidationError
from sangam.idempotency import IdempotencyStore, request_hash
from sangam.schemas import (
    Annotation,
    AnnotationEvent,
    AnnotationFields,
    AnnotationSnapshot,
    AnnotationType,
    Document,
    PdfPage,
    PdfRect,
    PdfSearchResult,
)
from sangam.search import SearchIndex
from sangam.service import DocumentService
from sangam.workspace import WorkspaceFilesystem


class PdfResearchService:
    """Owns immutable PDF bytes, extracted pages, and versioned research annotations."""

    def __init__(
        self,
        *,
        database: Database,
        workspace: WorkspaceFilesystem,
        documents: DocumentService,
        idempotency: IdempotencyStore,
        actors: ActorService,
        search_index: SearchIndex,
        max_pdf_bytes: int,
    ) -> None:
        self.database = database
        self.workspace = workspace
        self.documents = documents
        self.idempotency = idempotency
        self.actors = actors
        self.search_index = search_index
        self.max_pdf_bytes = max_pdf_bytes

    def import_pdf(
        self,
        *,
        title: str,
        path: str,
        content: bytes,
        supersedes_document_id: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        title = title.strip()
        if not title:
            raise ValidationError("PDF title is required")
        if not content.startswith(b"%PDF-"):
            raise ValidationError("The uploaded file is not a PDF")
        if len(content) > self.max_pdf_bytes:
            raise ValidationError(
                "PDF exceeds the configured size limit",
                details={"size_bytes": len(content), "max_pdf_bytes": self.max_pdf_bytes},
            )
        normalized_path = self.workspace.normalize_document_path(path)
        if not normalized_path.lower().endswith(".pdf"):
            raise ValidationError("PDF document paths must end in .pdf")
        content_hash = hashlib.sha256(content).hexdigest()
        fingerprint = request_hash(
            {
                "title": title,
                "path": normalized_path,
                "content_hash": content_hash,
                "supersedes_document_id": supersedes_document_id,
            }
        )
        with self.database.connection() as connection:
            duplicate = self.idempotency.mutation_record(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="pdf_import",
                request_hash=fingerprint,
            )
        if duplicate is not None:
            return self.documents.get_document(duplicate.resource_id)

        created_file = not self.workspace.is_document_file(normalized_path)
        if created_file:
            file_hash = self.workspace.write_atomic_bytes(normalized_path, content)
        else:
            # An import may have been interrupted after the durable file rename but
            # before SQLite committed. Adopt only the exact bytes the caller supplied;
            # a different existing file must remain a visible reconciliation conflict.
            file_hash = hashlib.sha256(self.workspace.read_binary(normalized_path)).hexdigest()
            if file_hash != content_hash:
                raise ValidationError("A different workspace file already exists at that path")
        document_id = str(uuid.uuid4())
        revision_id = str(uuid.uuid4())
        try:
            with self.database.transaction() as connection:
                self.actors.require_known(connection, actor_id)
                if supersedes_document_id:
                    previous = connection.execute(
                        "SELECT content_type FROM documents WHERE document_id = ? AND deleted = 0",
                        (supersedes_document_id,),
                    ).fetchone()
                    if not previous or previous["content_type"] != "application/pdf":
                        raise ValidationError("A replacement can only supersede an existing PDF")
                now = utc_now()
                connection.execute(
                    """
                    INSERT INTO documents(
                        document_id, title, content_type, path, current_revision_id,
                        content_hash, size_bytes, materialization_state, file_hash,
                        deleted, created_by, created_at, updated_at
                    ) VALUES (?, ?, 'application/pdf', ?, NULL, ?, ?, 'clean', ?, 0, ?, ?, ?)
                    """,
                    (
                        document_id,
                        title,
                        normalized_path,
                        content_hash,
                        len(content),
                        file_hash,
                        actor_id,
                        now,
                        now,
                    ),
                )
                self.documents.organization.ensure_document_folder_hierarchy(
                    connection, normalized_path
                )
                connection.execute(
                    """
                    INSERT INTO revisions(
                        revision_id, document_id, parent_revision_id, content,
                        content_hash, size_bytes, actor_id, operation, summary, created_at
                    ) VALUES (?, ?, NULL, '', ?, ?, ?, 'create', 'Imported immutable PDF', ?)
                    """,
                    (revision_id, document_id, content_hash, len(content), actor_id, now),
                )
                connection.execute(
                    "UPDATE documents SET current_revision_id = ? WHERE document_id = ?",
                    (revision_id, document_id),
                )
                connection.execute(
                    """
                    INSERT INTO pdf_documents(
                        document_id, extraction_status, supersedes_document_id, imported_at
                    ) VALUES (?, 'pending', ?, ?)
                    """,
                    (document_id, supersedes_document_id, now),
                )
                connection.execute(
                    """
                    UPDATE reconciliation_conflicts
                    SET status = 'resolved', resolved_at = ?
                    WHERE status = 'open' AND conflict_type = 'unknown_file' AND path = ?
                    """,
                    (now, normalized_path),
                )
                self.idempotency.record_mutation(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="pdf_import",
                    request_hash=fingerprint,
                    resource_type="pdf_document",
                    resource_id=document_id,
                )
        except Exception:
            if created_file:
                self.workspace.delete_document(normalized_path)
            raise
        document = self.documents.get_document(document_id)
        self.search_index.sync(document)
        return document

    def pdf_bytes(self, document_id: str) -> tuple[Document, bytes]:
        document = self._require_pdf(document_id)
        if not document.path:
            raise ValidationError("PDF document is not materialized")
        content = self.workspace.read_binary(document.path)
        actual_hash = hashlib.sha256(content).hexdigest()
        if actual_hash != document.content_hash:
            raise ConflictError(
                "PDF bytes differ from the imported immutable source",
                details={
                    "document_id": document_id,
                    "expected_hash": document.content_hash,
                    "actual_hash": actual_hash,
                },
            )
        return document, content

    def pending_extractions(self) -> list[str]:
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT document_id FROM pdf_documents
                WHERE extraction_status IN ('pending', 'processing')
                ORDER BY imported_at
                """
            ).fetchall()
        return [row["document_id"] for row in rows]

    def extract_text(self, document_id: str) -> None:
        self._require_pdf(document_id)
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE pdf_documents
                SET extraction_status = 'processing', extraction_error = NULL,
                    extraction_attempts = extraction_attempts + 1
                WHERE document_id = ?
                """,
                (document_id,),
            )
        try:
            _, content = self.pdf_bytes(document_id)
            reader = PdfReader(io.BytesIO(content), strict=False)
            pages = [page.extract_text() or "" for page in reader.pages]
            with self.database.transaction() as connection:
                connection.execute("DELETE FROM pdf_pages WHERE document_id = ?", (document_id,))
                connection.executemany(
                    "INSERT INTO pdf_pages(document_id, page_number, text) VALUES (?, ?, ?)",
                    [(document_id, index, text) for index, text in enumerate(pages, start=1)],
                )
                connection.execute(
                    """
                    UPDATE pdf_documents
                    SET page_count = ?, extraction_status = 'ready', extraction_error = NULL,
                        extracted_at = ?
                    WHERE document_id = ?
                    """,
                    (len(pages), utc_now(), document_id),
                )
        except Exception as error:
            with self.database.transaction() as connection:
                connection.execute(
                    """
                    UPDATE pdf_documents
                    SET extraction_status = 'failed', extraction_error = ?
                    WHERE document_id = ?
                    """,
                    (str(error)[:1000], document_id),
                )
            return
        self.search_index.sync(self.documents.get_document(document_id))

    def retry_extraction(self, document_id: str) -> Document:
        self._require_pdf(document_id)
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE pdf_documents
                SET extraction_status = 'pending', extraction_error = NULL
                WHERE document_id = ?
                """,
                (document_id,),
            )
        return self.documents.get_document(document_id)

    def pages(self, document_id: str) -> list[PdfPage]:
        self._require_pdf(document_id)
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM pdf_pages WHERE document_id = ? ORDER BY page_number",
                (document_id,),
            ).fetchall()
        return [PdfPage.model_validate(dict(row)) for row in rows]

    def search_pages(self, document_id: str, query: str) -> list[PdfSearchResult]:
        self._require_pdf(document_id)
        terms = [term.casefold() for term in re.findall(r"[\w-]+", query, flags=re.UNICODE)]
        if not terms:
            return []
        results: list[PdfSearchResult] = []
        for page in self.pages(document_id):
            folded = page.text.casefold()
            positions = [folded.find(term) for term in terms]
            if any(position < 0 for position in positions):
                continue
            start = max(0, min(positions) - 90)
            end = min(len(page.text), max(positions) + max(map(len, terms)) + 120)
            prefix = "…" if start else ""
            suffix = "…" if end < len(page.text) else ""
            results.append(
                PdfSearchResult(
                    **page.model_dump(), snippet=f"{prefix}{page.text[start:end].strip()}{suffix}"
                )
            )
        return results

    def list_annotations(
        self,
        document_id: str,
        *,
        page_number: int | None = None,
        query: str = "",
        include_deleted: bool = False,
    ) -> list[Annotation]:
        self._require_pdf(document_id)
        conditions = ["n.document_id = ?"]
        parameters: list[object] = [document_id]
        if page_number is not None:
            conditions.append("n.page_number = ?")
            parameters.append(page_number)
        if not include_deleted:
            conditions.append("n.deleted = 0")
        if query.strip():
            conditions.append(
                "LOWER(COALESCE(n.selected_text, '') || ' ' || COALESCE(n.note, '') "
                "|| ' ' || n.tags_json) LIKE ?"
            )
            parameters.append(f"%{query.strip().casefold()}%")
        with self.database.connection() as connection:
            rows = connection.execute(
                self._annotation_query()
                + f" WHERE {' AND '.join(conditions)}"
                + " ORDER BY n.page_number, n.created_at, n.annotation_id",
                parameters,
            ).fetchall()
        return [self._annotation_from_row(row) for row in rows]

    def get_annotation(self, annotation_id: str, *, include_deleted: bool = False) -> Annotation:
        with self.database.connection() as connection:
            row = connection.execute(
                self._annotation_query()
                + " WHERE n.annotation_id = ?"
                + ("" if include_deleted else " AND n.deleted = 0"),
                (annotation_id,),
            ).fetchone()
        if not row:
            raise NotFoundError(f"Annotation not found: {annotation_id}")
        return self._annotation_from_row(row)

    def create_annotation(
        self,
        *,
        document_id: str,
        page_number: int,
        annotation_type: AnnotationType,
        selected_text: str | None,
        note: str | None,
        geometry: list[PdfRect],
        tags: list[str],
        color: str,
        actor_id: str,
        idempotency_key: str,
    ) -> Annotation:
        document = self._require_pdf(document_id)
        self._validate_page(document, page_number)
        normalized = self._normalize_annotation_fields(
            annotation_type=annotation_type,
            selected_text=selected_text,
            note=note,
            geometry=geometry,
            tags=tags,
            color=color,
        )
        fingerprint = request_hash(
            {
                "document_id": document_id,
                "page_number": page_number,
                **normalized.model_dump(),
            }
        )
        with self.database.transaction() as connection:
            duplicate = self.idempotency.mutation_record(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="annotation_create",
                request_hash=fingerprint,
            )
            if duplicate is not None:
                annotation_id = duplicate.resource_id
            else:
                self.actors.require_known(connection, actor_id)
                annotation_id = str(uuid.uuid4())
                now = utc_now()
                connection.execute(
                    """
                    INSERT INTO annotations(
                        annotation_id, document_id, page_number, annotation_type,
                        selected_text, note, geometry_json, tags_json, color,
                        version, deleted, created_by, updated_by, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
                    """,
                    (
                        annotation_id,
                        document_id,
                        page_number,
                        annotation_type,
                        normalized.selected_text,
                        normalized.note,
                        json.dumps([rect.model_dump() for rect in normalized.geometry]),
                        json.dumps(normalized.tags),
                        normalized.color,
                        actor_id,
                        actor_id,
                        now,
                        now,
                    ),
                )
                snapshot = AnnotationSnapshot(
                    annotation_id=annotation_id,
                    document_id=document_id,
                    page_number=page_number,
                    annotation_type=annotation_type,
                    version=1,
                    deleted=False,
                    **normalized.model_dump(),
                )
                self._insert_event(
                    connection,
                    annotation_id=annotation_id,
                    document_id=document_id,
                    actor_id=actor_id,
                    operation="create",
                    version=1,
                    snapshot=snapshot,
                )
                self.idempotency.record_mutation(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="annotation_create",
                    request_hash=fingerprint,
                    resource_type="annotation",
                    resource_id=annotation_id,
                )
        self.search_index.sync(document)
        return self.get_annotation(annotation_id)

    def update_annotation(
        self,
        *,
        annotation_id: str,
        expected_version: int,
        selected_text: str | None,
        note: str | None,
        geometry: list[PdfRect],
        tags: list[str],
        color: str,
        actor_id: str,
        idempotency_key: str,
    ) -> Annotation:
        current = self.get_annotation(annotation_id)
        normalized = self._normalize_annotation_fields(
            annotation_type=current.annotation_type,
            selected_text=selected_text,
            note=note,
            geometry=geometry,
            tags=tags,
            color=color,
        )
        return self._change_annotation(
            current=current,
            expected_version=expected_version,
            normalized=normalized,
            deleted=False,
            operation="update",
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    def delete_annotation(
        self,
        *,
        annotation_id: str,
        expected_version: int,
        actor_id: str,
        idempotency_key: str,
    ) -> Annotation:
        current = self.get_annotation(annotation_id)
        normalized = AnnotationFields(
            selected_text=current.selected_text,
            note=current.note,
            geometry=current.geometry,
            tags=current.tags,
            color=current.color,
        )
        return self._change_annotation(
            current=current,
            expected_version=expected_version,
            normalized=normalized,
            deleted=True,
            operation="delete",
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    def annotation_history(self, annotation_id: str) -> list[AnnotationEvent]:
        self.get_annotation(annotation_id, include_deleted=True)
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT e.*, a.display_name AS actor_display_name,
                    a.identity_kind AS actor_kind
                FROM annotation_events e
                JOIN actors a ON a.actor_id = e.actor_id
                WHERE e.annotation_id = ?
                ORDER BY e.version DESC
                """,
                (annotation_id,),
            ).fetchall()
        events: list[AnnotationEvent] = []
        for row in rows:
            values = dict(row)
            snapshot = AnnotationSnapshot.model_validate(json.loads(values.pop("snapshot_json")))
            events.append(AnnotationEvent(**values, snapshot=snapshot))
        return events

    def _change_annotation(
        self,
        *,
        current: Annotation,
        expected_version: int,
        normalized: AnnotationFields,
        deleted: bool,
        operation: str,
        actor_id: str,
        idempotency_key: str,
    ) -> Annotation:
        fingerprint = request_hash(
            {
                "annotation_id": current.annotation_id,
                "expected_version": expected_version,
                "deleted": deleted,
                **normalized.model_dump(),
            }
        )
        with self.database.transaction() as connection:
            duplicate = self.idempotency.mutation_record(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation=f"annotation_{operation}",
                request_hash=fingerprint,
            )
            if duplicate is None:
                self.actors.require_known(connection, actor_id)
                row = connection.execute(
                    "SELECT version, deleted FROM annotations WHERE annotation_id = ?",
                    (current.annotation_id,),
                ).fetchone()
                if not row or row["deleted"]:
                    raise NotFoundError(f"Annotation not found: {current.annotation_id}")
                if row["version"] != expected_version:
                    raise ConflictError(
                        "The annotation changed since it was read",
                        details={
                            "annotation_id": current.annotation_id,
                            "expected_version": expected_version,
                            "current_version": row["version"],
                        },
                    )
                next_version = expected_version + 1
                now = utc_now()
                connection.execute(
                    """
                    UPDATE annotations SET selected_text = ?, note = ?, geometry_json = ?,
                        tags_json = ?, color = ?, version = ?, deleted = ?,
                        updated_by = ?, updated_at = ? WHERE annotation_id = ?
                    """,
                    (
                        normalized.selected_text,
                        normalized.note,
                        json.dumps([rect.model_dump() for rect in normalized.geometry]),
                        json.dumps(normalized.tags),
                        normalized.color,
                        next_version,
                        int(deleted),
                        actor_id,
                        now,
                        current.annotation_id,
                    ),
                )
                snapshot = AnnotationSnapshot(
                    annotation_id=current.annotation_id,
                    document_id=current.document_id,
                    page_number=current.page_number,
                    annotation_type=current.annotation_type,
                    version=next_version,
                    deleted=deleted,
                    **normalized.model_dump(),
                )
                self._insert_event(
                    connection,
                    annotation_id=current.annotation_id,
                    document_id=current.document_id,
                    actor_id=actor_id,
                    operation=operation,
                    version=next_version,
                    snapshot=snapshot,
                )
                self.idempotency.record_mutation(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation=f"annotation_{operation}",
                    request_hash=fingerprint,
                    resource_type="annotation",
                    resource_id=current.annotation_id,
                )
        self.search_index.sync(self.documents.get_document(current.document_id))
        return self.get_annotation(current.annotation_id, include_deleted=deleted)

    def _require_pdf(self, document_id: str) -> Document:
        document = self.documents.get_document(document_id)
        if document.content_type != "application/pdf":
            raise ValidationError("This operation requires a PDF document")
        return document

    @staticmethod
    def _validate_page(document: Document, page_number: int) -> None:
        if document.pdf_page_count is not None and page_number > document.pdf_page_count:
            raise ValidationError("Annotation page exceeds the PDF page count")

    @staticmethod
    def _normalize_annotation_fields(
        *,
        annotation_type: AnnotationType,
        selected_text: str | None,
        note: str | None,
        geometry: list[PdfRect],
        tags: list[str],
        color: str,
    ) -> AnnotationFields:
        selected_text = selected_text.strip() if selected_text and selected_text.strip() else None
        note = note.strip() if note and note.strip() else None
        normalized_tags = sorted({tag.strip() for tag in tags if tag.strip()}, key=str.casefold)
        normalized_geometry = geometry
        if annotation_type == "text_highlight" and not selected_text:
            raise ValidationError("Text highlights require selected text")
        if annotation_type in {"text_highlight", "area_highlight"} and not normalized_geometry:
            raise ValidationError("Highlights require page coordinates")
        if annotation_type in {"comment", "page_note"} and not note:
            raise ValidationError("Notes and comments require text")
        return AnnotationFields(
            selected_text=selected_text,
            note=note,
            geometry=normalized_geometry,
            tags=normalized_tags,
            color=color.lower(),
        )

    @staticmethod
    def _insert_event(
        connection: sqlite3.Connection,
        *,
        annotation_id: str,
        document_id: str,
        actor_id: str,
        operation: str,
        version: int,
        snapshot: AnnotationSnapshot,
    ) -> None:
        connection.execute(
            """
            INSERT INTO annotation_events(
                event_id, annotation_id, document_id, actor_id,
                operation, version, snapshot_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                annotation_id,
                document_id,
                actor_id,
                operation,
                version,
                json.dumps(snapshot.model_dump(mode="json"), sort_keys=True),
                utc_now(),
            ),
        )

    @staticmethod
    def _annotation_query() -> str:
        return """
            SELECT n.*, creator.display_name AS created_by_name,
                updater.display_name AS updated_by_name
            FROM annotations n
            JOIN actors creator ON creator.actor_id = n.created_by
            JOIN actors updater ON updater.actor_id = n.updated_by
        """

    @staticmethod
    def _annotation_from_row(row: sqlite3.Row) -> Annotation:
        values = dict(row)
        geometry = json.loads(values.pop("geometry_json"))
        tags = json.loads(values.pop("tags_json"))
        return Annotation(**values, geometry=geometry, tags=tags)
