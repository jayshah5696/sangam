from __future__ import annotations

import difflib
import hashlib
import json
import sqlite3
import uuid
from pathlib import PurePosixPath

from sangam.actors import ActorService
from sangam.db import Database, utc_now
from sangam.errors import (
    ConflictError,
    IdempotencyError,
    MaterializationError,
    NotFoundError,
    ValidationError,
)
from sangam.idempotency import IdempotencyStore, request_hash
from sangam.mutations import MutationCoordinator
from sangam.organization import WorkspaceOrganizationService
from sangam.schemas import (
    Document,
    DocumentSummary,
    Revision,
    RevisionDiff,
    Tag,
)
from sangam.search import SearchIndex
from sangam.workspace import WorkspaceFilesystem


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


class DocumentService:
    def __init__(
        self,
        *,
        database: Database,
        workspace: WorkspaceFilesystem,
        idempotency: IdempotencyStore,
        actors: ActorService,
        organization: WorkspaceOrganizationService,
        search_index: SearchIndex,
        mutations: MutationCoordinator,
        max_document_bytes: int,
    ) -> None:
        self.database = database
        self.workspace = workspace
        self.idempotency = idempotency
        self.actors = actors
        self.organization = organization
        self.search_index = search_index
        self.mutations = mutations
        self.max_document_bytes = max_document_bytes
        self.pdf_research = None

    def _validate_content_size(self, content: str) -> None:
        size_bytes = len(content.encode("utf-8"))
        if size_bytes > self.max_document_bytes:
            raise ValidationError(
                "Text content exceeds the configured size limit",
                details={
                    "size_bytes": size_bytes,
                    "max_document_bytes": self.max_document_bytes,
                },
            )

    def validate_proposed_content(self, content: str) -> None:
        """Validate text content before a caller persists a reviewable proposal."""
        self._validate_content_size(content)

    def _normalize_path(self, raw_path: str) -> str:
        return self.workspace.normalize_document_path(raw_path)

    @staticmethod
    def _validate_path_type(path: str | None, content_type: str) -> None:
        if path is None:
            return
        suffix = path.lower().rsplit(".", 1)[-1]
        if suffix == "pdf":
            expected = "application/pdf"
        else:
            expected = "text/html" if suffix in {"html", "htm"} else "text/markdown"
        if content_type != expected:
            raise ValidationError(
                "The workspace path extension must match the document content type"
            )

    def _document_query(self, *, include_content: bool = True, include_search: bool = False) -> str:
        content_projection = ", r.content" if include_content else ""
        search_projection = (
            ", snippet(document_search, -1, '[[', ']]', ' … ', 24) AS search_snippet"
            if include_search
            else ", NULL AS search_snippet"
        )
        search_join = (
            "JOIN document_search ON document_search.document_id = d.document_id"
            if include_search
            else ""
        )
        return f"""
            SELECT d.*{content_projection}, r.actor_id AS updated_by,
                r.summary AS revision_summary, a.display_name AS updated_by_name,
                pdf.page_count, pdf.extraction_status, pdf.extraction_error,
                pdf.supersedes_document_id,
                COALESCE((
                    SELECT json_group_array(json_object(
                        'tag_id', ordered_tags.tag_id,
                        'name', ordered_tags.name,
                        'color', ordered_tags.color,
                        'created_at', ordered_tags.created_at
                    ))
                    FROM (
                        SELECT t.* FROM tags t
                        JOIN document_tags dt ON dt.tag_id = t.tag_id
                        WHERE dt.document_id = d.document_id
                        ORDER BY t.name COLLATE NOCASE
                    ) AS ordered_tags
                ), '[]') AS tags_json{search_projection}
            FROM documents d
            JOIN revisions r ON r.revision_id = d.current_revision_id
            JOIN actors a ON a.actor_id = r.actor_id
            LEFT JOIN pdf_documents pdf ON pdf.document_id = d.document_id
            {search_join}
        """

    def _document_summary_from_row(self, row: sqlite3.Row) -> DocumentSummary:
        return DocumentSummary(
            document_id=row["document_id"],
            title=row["title"],
            content_type=row["content_type"],
            path=row["path"],
            current_revision_id=row["current_revision_id"],
            content_hash=row["content_hash"],
            size_bytes=row["size_bytes"],
            materialization_state=row["materialization_state"],
            file_hash=row["file_hash"],
            deleted=bool(row["deleted"]),
            created_by=row["created_by"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            updated_by=row["updated_by"],
            updated_by_name=row["updated_by_name"],
            revision_summary=row["revision_summary"],
            category=row["category"],
            metadata_version=row["metadata_version"],
            trust_level=row["trust_level"],
            trust_version=row["trust_version"],
            tags=[Tag.model_validate(tag) for tag in json.loads(row["tags_json"])],
            search_snippet=row["search_snippet"],
            pdf_page_count=row["page_count"],
            pdf_extraction_status=row["extraction_status"],
            pdf_extraction_error=row["extraction_error"],
            supersedes_document_id=row["supersedes_document_id"],
        )

    def _document_from_row(self, row: sqlite3.Row) -> Document:
        summary = self._document_summary_from_row(row)
        return Document(**summary.model_dump(), content=row["content"])

    def _get_document_in_connection(
        self, connection: sqlite3.Connection, document_id: str, *, include_deleted: bool = True
    ) -> Document:
        row = connection.execute(
            self._document_query()
            + " WHERE d.document_id = ?"
            + ("" if include_deleted else " AND d.deleted = 0"),
            (document_id,),
        ).fetchone()
        if not row:
            raise NotFoundError(f"Document not found: {document_id}")
        return self._document_from_row(row)

    def get_document(self, document_id: str, *, include_deleted: bool = False) -> Document:
        with self.database.connection() as connection:
            return self._get_document_in_connection(
                connection, document_id, include_deleted=include_deleted
            )

    def update_trust(
        self,
        *,
        document_id: str,
        expected_trust_version: int,
        trust_level: str,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        """Apply an attributed HTML trust transition within the document boundary."""
        if trust_level not in {"untrusted", "trusted_interactive"}:
            raise ValidationError("Unsupported document trust level")
        fingerprint = request_hash(
            {
                "document_id": document_id,
                "expected_trust_version": expected_trust_version,
                "trust_level": trust_level,
            }
        )
        with self.database.transaction() as connection:
            duplicate = self.idempotency.mutation_record(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="document_trust",
                request_hash=fingerprint,
            )
            if duplicate is None:
                row = connection.execute(
                    """
                    SELECT content_type, trust_level, trust_version
                    FROM documents WHERE document_id = ?
                    """,
                    (document_id,),
                ).fetchone()
                if row is None:
                    raise NotFoundError(f"Document not found: {document_id}")
                if row["content_type"] != "text/html":
                    raise ValidationError("Only HTML documents have an interactive trust policy")
                if row["trust_version"] != expected_trust_version:
                    raise ConflictError(
                        "Document trust changed since it was read",
                        details={"current_trust_version": row["trust_version"]},
                    )
                next_version = row["trust_version"] + 1
                now = utc_now()
                connection.execute(
                    """
                    UPDATE documents SET trust_level = ?, trust_version = ?, updated_at = ?
                    WHERE document_id = ?
                    """,
                    (trust_level, next_version, now, document_id),
                )
                connection.execute(
                    """
                    INSERT INTO document_trust_events(
                        event_id, document_id, actor_id, previous_level,
                        next_level, trust_version, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        document_id,
                        actor_id,
                        row["trust_level"],
                        trust_level,
                        next_version,
                        now,
                    ),
                )
                self.idempotency.record_mutation(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="document_trust",
                    request_hash=fingerprint,
                    resource_type="document",
                    resource_id=document_id,
                )
        return self.get_document(document_id)

    def list_documents(self, *, include_deleted: bool = False) -> list[Document]:
        with self.database.connection() as connection:
            rows = connection.execute(
                self._document_query()
                + ("" if include_deleted else " WHERE d.deleted = 0")
                + " ORDER BY d.updated_at DESC, d.document_id"
            ).fetchall()
        return [self._document_from_row(row) for row in rows]

    def list_document_summaries(
        self,
        *,
        include_deleted: bool = False,
        path_prefixes: tuple[str, ...] | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[DocumentSummary]:
        if path_prefixes == ():
            return []
        conditions = [] if include_deleted else ["d.deleted = 0"]
        parameters: list[object] = []
        self._add_path_filter(conditions, parameters, path_prefixes)
        where = f" WHERE {' AND '.join(conditions)}" if conditions else ""
        parameters.extend((limit, offset))
        with self.database.connection() as connection:
            rows = connection.execute(
                self._document_query(include_content=False)
                + where
                + " ORDER BY d.updated_at DESC, d.document_id LIMIT ? OFFSET ?",
                parameters,
            ).fetchall()
        return [self._document_summary_from_row(row) for row in rows]

    @staticmethod
    def _add_path_filter(
        conditions: list[str],
        parameters: list[object],
        path_prefixes: tuple[str, ...] | None,
    ) -> None:
        if path_prefixes is None:
            return
        clauses: list[str] = []
        for prefix in path_prefixes:
            # Under SQLite's binary text ordering, every descendant starts in
            # the half-open ["prefix/", "prefix0") range. This is segment-aware
            # and treats SQL wildcard characters in paths as ordinary text.
            clauses.append("(d.path = ? OR (d.path >= ? AND d.path < ?))")
            parameters.extend((prefix, f"{prefix}/", f"{prefix}0"))
        conditions.append(f"({' OR '.join(clauses)})")

    def _idempotent_result(
        self,
        connection: sqlite3.Connection,
        *,
        actor_id: str,
        key: str,
        operation: str,
        request_hash: str,
    ) -> tuple[str, str] | None:
        self.idempotency.ensure_document_key_available(connection, actor_id=actor_id, key=key)
        row = connection.execute(
            """
            SELECT operation, request_hash, document_id, revision_id
            FROM idempotency_keys WHERE actor_id = ? AND idempotency_key = ?
            """,
            (actor_id, key),
        ).fetchone()
        if not row:
            return None
        if row["operation"] != operation or row["request_hash"] != request_hash:
            raise IdempotencyError(
                "Idempotency key was already used for a different mutation",
                details={"idempotency_key": key},
            )
        return row["document_id"], row["revision_id"]

    def _record_idempotency(
        self,
        connection: sqlite3.Connection,
        *,
        actor_id: str,
        key: str,
        operation: str,
        request_hash: str,
        document_id: str,
        revision_id: str,
    ) -> None:
        connection.execute(
            """
            INSERT INTO idempotency_keys(
                actor_id, idempotency_key, operation, request_hash,
                document_id, revision_id, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (actor_id, key, operation, request_hash, document_id, revision_id, utc_now()),
        )

    def _finish_if_current(self, document_id: str, revision_id: str) -> None:
        document = self.get_document(document_id, include_deleted=True)
        if (
            document.current_revision_id == revision_id
            and document.path
            and document.materialization_state == "pending"
            and not document.deleted
        ):
            self._finish_materialization(document)

    def create_document(
        self,
        *,
        title: str,
        content: str,
        path: str | None,
        content_type: str = "text/markdown",
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        with self.mutations.creation():
            fingerprint = request_hash(
                {
                    "title": title,
                    "content": content,
                    "path": self._normalize_path(path) if path is not None else None,
                    "content_type": content_type,
                }
            )
            with self.database.connection() as connection:
                duplicate = self._idempotent_result(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="create",
                    request_hash=fingerprint,
                )
            document_id = duplicate[0] if duplicate else str(uuid.uuid4())
            with self.mutations.document(document_id):
                return self._create_document_locked(
                    title=title,
                    content=content,
                    path=path,
                    content_type=content_type,
                    actor_id=actor_id,
                    idempotency_key=idempotency_key,
                    document_id=document_id,
                )

    def _create_document_locked(
        self,
        *,
        title: str,
        content: str,
        path: str | None,
        content_type: str,
        actor_id: str,
        idempotency_key: str,
        document_id: str,
    ) -> Document:
        self._validate_content_size(content)
        normalized_path = self._normalize_path(path) if path is not None else None
        if content_type not in {"text/markdown", "text/html"}:
            raise ValidationError("Unsupported text document content type")
        self._validate_path_type(normalized_path, content_type)
        payload = {
            "title": title,
            "content": content,
            "path": normalized_path,
            "content_type": content_type,
        }
        fingerprint = request_hash(payload)
        duplicate: tuple[str, str] | None = None
        try:
            with self.database.transaction() as connection:
                self.actors.require_known(connection, actor_id)
                duplicate = self._idempotent_result(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="create",
                    request_hash=fingerprint,
                )
                if duplicate is None:
                    now = utc_now()
                    revision_id = str(uuid.uuid4())
                    content_hash = _content_hash(content)
                    size_bytes = len(content.encode("utf-8"))
                    connection.execute(
                        """
                        INSERT INTO documents(
                            document_id, title, content_type, path, current_revision_id,
                            content_hash, size_bytes, materialization_state, file_hash,
                            deleted, created_by, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, NULL, 0, ?, ?, ?)
                        """,
                        (
                            document_id,
                            title.strip(),
                            content_type,
                            normalized_path,
                            content_hash,
                            size_bytes,
                            "pending" if normalized_path else "none",
                            actor_id,
                            now,
                            now,
                        ),
                    )
                    if normalized_path:
                        self.organization.ensure_document_folder_hierarchy(
                            connection, normalized_path
                        )
                    connection.execute(
                        """
                        INSERT INTO revisions(
                            revision_id, document_id, parent_revision_id, content,
                            content_hash, size_bytes, actor_id, operation, summary, created_at
                        ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'create', NULL, ?)
                        """,
                        (
                            revision_id,
                            document_id,
                            content,
                            content_hash,
                            size_bytes,
                            actor_id,
                            now,
                        ),
                    )
                    connection.execute(
                        "UPDATE documents SET current_revision_id = ? WHERE document_id = ?",
                        (revision_id, document_id),
                    )
                    self._record_idempotency(
                        connection,
                        actor_id=actor_id,
                        key=idempotency_key,
                        operation="create",
                        request_hash=fingerprint,
                        document_id=document_id,
                        revision_id=revision_id,
                    )
                    duplicate = (document_id, revision_id)
        except sqlite3.IntegrityError as error:
            raise ValidationError("A document already uses that path") from error
        if duplicate is None:
            raise RuntimeError("Document creation completed without an idempotent result")
        self._finish_if_current(*duplicate)
        result = self.get_document(duplicate[0], include_deleted=True)
        self.search_index.sync(result)
        return result

    def _append_revision(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        content: str | None,
        title: str | None,
        path: str | None,
        operation: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
        deleted: bool | None = None,
    ) -> tuple[Document, str | None]:
        with self.mutations.document(document_id):
            return self._append_revision_locked(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                content=content,
                title=title,
                path=path,
                operation=operation,
                summary=summary,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
                deleted=deleted,
            )

    def _append_revision_locked(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        content: str | None,
        title: str | None,
        path: str | None,
        operation: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
        deleted: bool | None = None,
    ) -> tuple[Document, str | None]:
        payload = {
            "document_id": document_id,
            "expected_revision_id": expected_revision_id,
            "content": content,
            "title": title,
            "path": path,
            "operation": operation,
            "summary": summary,
            "deleted": deleted,
        }
        fingerprint = request_hash(payload)
        old_path: str | None = None
        result: tuple[str, str] | None = None
        try:
            with self.database.transaction() as connection:
                self.actors.require_known(connection, actor_id)
                result = self._idempotent_result(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation=operation,
                    request_hash=fingerprint,
                )
                if result is None:
                    current = self._get_document_in_connection(
                        connection, document_id, include_deleted=True
                    )
                    if current.current_revision_id != expected_revision_id:
                        raise ConflictError(
                            "The document changed since it was read",
                            details={
                                "document_id": document_id,
                                "expected_revision_id": expected_revision_id,
                                "current_revision_id": current.current_revision_id,
                            },
                        )
                    if current.deleted and operation != "restore":
                        raise NotFoundError(f"Document is deleted: {document_id}")
                    next_content = current.content if content is None else content
                    self._validate_content_size(next_content)
                    next_title = current.title if title is None else title.strip()
                    next_path = current.path if path is None else path
                    next_deleted = current.deleted if deleted is None else deleted
                    now = utc_now()
                    revision_id = str(uuid.uuid4())
                    content_hash = _content_hash(next_content)
                    size_bytes = len(next_content.encode("utf-8"))
                    old_path = (
                        current.path if path is not None and current.path != next_path else None
                    )
                    if next_deleted:
                        state = "none"
                        file_hash = None
                    elif next_path:
                        state = "pending"
                        file_hash = current.file_hash if current.path == next_path else None
                    else:
                        state = "none"
                        file_hash = None
                    connection.execute(
                        """
                        INSERT INTO revisions(
                            revision_id, document_id, parent_revision_id, content,
                            content_hash, size_bytes, actor_id, operation, summary, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            revision_id,
                            document_id,
                            current.current_revision_id,
                            next_content,
                            content_hash,
                            size_bytes,
                            actor_id,
                            operation,
                            summary,
                            now,
                        ),
                    )
                    if next_path:
                        self.organization.ensure_document_folder_hierarchy(connection, next_path)
                    connection.execute(
                        """
                        UPDATE documents
                        SET title = ?, path = ?, current_revision_id = ?, content_hash = ?,
                            size_bytes = ?, materialization_state = ?, file_hash = ?,
                            deleted = ?, updated_at = ?
                        WHERE document_id = ?
                        """,
                        (
                            next_title,
                            next_path,
                            revision_id,
                            content_hash,
                            size_bytes,
                            state,
                            file_hash,
                            int(next_deleted),
                            now,
                            document_id,
                        ),
                    )
                    self._record_idempotency(
                        connection,
                        actor_id=actor_id,
                        key=idempotency_key,
                        operation=operation,
                        request_hash=fingerprint,
                        document_id=document_id,
                        revision_id=revision_id,
                    )
                    result = (document_id, revision_id)
        except sqlite3.IntegrityError as error:
            raise ValidationError("A document already uses that path") from error
        if result is None:
            raise RuntimeError("Revision append completed without a result")
        self._finish_if_current(*result)
        current_result = self.get_document(document_id, include_deleted=True)
        if old_path and old_path != current_result.path:
            self.workspace.delete_document(old_path)
        if current_result.deleted and current_result.path:
            self.workspace.delete_document(current_result.path)
        self.search_index.sync(current_result)
        return current_result, old_path

    def update_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        content: str,
        title: str | None,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        self._require_text_document(document_id, "PDF source bytes cannot be edited in place")
        document, _ = self._append_revision(
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=content,
            title=title,
            path=None,
            operation="update",
            summary=summary,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )
        return document

    def reconcile_content(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        content: str,
        summary: str,
        idempotency_key: str,
    ) -> Document:
        """Record accepted workspace content through the normal revision protocol."""
        self._require_text_document(
            document_id, "Changed PDF bytes must be imported as a replacement document"
        )
        document, _ = self._append_revision(
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=content,
            title=None,
            path=None,
            operation="reconcile",
            summary=summary,
            actor_id="system:reconcile",
            idempotency_key=idempotency_key,
        )
        return document

    def duplicate_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        title: str | None,
        path: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        source = self.get_document(document_id)
        if source.current_revision_id != expected_revision_id:
            raise ConflictError(
                "The source document changed since it was read",
                details={
                    "document_id": document_id,
                    "expected_revision_id": expected_revision_id,
                    "current_revision_id": source.current_revision_id,
                },
            )
        if source.content_type == "application/pdf":
            return self._duplicate_pdf_document(
                source=source,
                title=title,
                path=path,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        return self.create_document(
            title=title or f"{source.title} copy",
            content=source.content,
            path=path,
            content_type=source.content_type,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    def _duplicate_pdf_document(
        self,
        *,
        source: Document,
        title: str | None,
        path: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        if not source.path:
            raise ValidationError("Cannot duplicate an unmaterialized PDF")
        source_bytes = self.workspace.read_binary(source.path)
        actual_hash = hashlib.sha256(source_bytes).hexdigest()
        if actual_hash != source.content_hash:
            raise ConflictError(
                "Source PDF content does not match stored content hash",
                details={"expected_hash": source.content_hash, "actual_hash": actual_hash},
            )
        if path is not None:
            destination_path = self._normalize_path(path)
            self._validate_path_type(destination_path, "application/pdf")
        else:
            source_parts = PurePosixPath(source.path)
            candidate_name = f"{source_parts.stem} copy{source_parts.suffix}"
            destination_path = (
                (source_parts.parent / candidate_name).as_posix()
                if source_parts.parent != PurePosixPath(".")
                else candidate_name
            )
        with self.database.connection() as connection:
            if connection.execute(
                "SELECT 1 FROM documents WHERE path = ? AND deleted = 0", (destination_path,)
            ).fetchone():
                raise ValidationError("A document already uses that path")
        if self.workspace.is_document_file(destination_path):
            raise ValidationError("A document already uses that path")
        new_title = title.strip() if title and title.strip() else f"{source.title} copy"
        pdf_research = getattr(self, "pdf_research", None)
        if pdf_research is None:
            from sangam.pdf_research import PdfResearchService

            pdf_research = PdfResearchService(
                database=self.database,
                workspace=self.workspace,
                documents=self,
                idempotency=self.idempotency,
                actors=self.actors,
                search_index=self.search_index,
                mutations=self.mutations,
                max_pdf_bytes=self.max_document_bytes * 10,
            )
        return pdf_research.import_pdf(
            title=new_title,
            path=destination_path,
            content=source_bytes,
            supersedes_document_id=None,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    def materialize_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        path: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        normalized_path = self._normalize_path(path)
        current = self.get_document(document_id)
        if current.content_type == "application/pdf":
            raise ValidationError("PDFs are materialized when they are imported")
        self._validate_path_type(normalized_path, current.content_type)
        document, _ = self._append_revision(
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=None,
            title=None,
            path=normalized_path,
            operation="materialize",
            summary=summary,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )
        return document

    def move_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        path: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        normalized_path = self._normalize_path(path)
        current = self.get_document(document_id)
        self._validate_path_type(normalized_path, current.content_type)
        if not current.path:
            raise ValidationError("Unmaterialized documents must be materialized before moving")
        if current.content_type == "application/pdf":
            return self._move_pdf_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                path=normalized_path,
                summary=summary,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        document, _ = self._append_revision(
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=None,
            title=None,
            path=normalized_path,
            operation="move",
            summary=summary,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )
        return document

    def _move_pdf_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        path: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        with self.mutations.document(document_id):
            payload = {
                "document_id": document_id,
                "expected_revision_id": expected_revision_id,
                "path": path,
                "operation": "move",
                "summary": summary,
            }
            fingerprint = request_hash(payload)
            with self.database.connection() as connection:
                duplicate = self._idempotent_result(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="move",
                    request_hash=fingerprint,
                )
                if duplicate is not None:
                    return self.get_document(duplicate[0], include_deleted=True)

                current = self._get_document_in_connection(
                    connection, document_id, include_deleted=True
                )
                if current.current_revision_id != expected_revision_id:
                    raise ConflictError(
                        "The document changed since it was read",
                        details={
                            "document_id": document_id,
                            "expected_revision_id": expected_revision_id,
                            "current_revision_id": current.current_revision_id,
                        },
                    )
                if current.deleted:
                    raise NotFoundError(f"Document is deleted: {document_id}")
                if current.path == path:
                    raise ValidationError("An organization plan cannot contain a no-op move")
                if not current.path:
                    raise ValidationError(
                        "Unmaterialized documents must be materialized before moving"
                    )

                existing = connection.execute(
                    "SELECT document_id FROM documents WHERE path = ? AND deleted = 0",
                    (path,),
                ).fetchone()
                if existing and existing["document_id"] != document_id:
                    raise ConflictError(f"A document already uses that path: {path}")
                if connection.execute("SELECT 1 FROM folders WHERE path = ?", (path,)).fetchone():
                    raise ConflictError(f"Destination path conflicts with a folder: {path}")

            old_path = current.path
            source_exists = self.workspace.is_document_file(old_path)
            dest_exists = self.workspace.is_document_file(path)
            if dest_exists and source_exists:
                raise ConflictError(f"A workspace file already exists at that path: {path}")

            if source_exists:
                self.workspace.move_document(old_path, path)

            try:
                with self.database.transaction() as connection:
                    self.actors.require_known(connection, actor_id)
                    duplicate = self._idempotent_result(
                        connection,
                        actor_id=actor_id,
                        key=idempotency_key,
                        operation="move",
                        request_hash=fingerprint,
                    )
                    if duplicate is not None:
                        result = duplicate
                    else:
                        now = utc_now()
                        revision_id = str(uuid.uuid4())
                        self.organization.ensure_document_folder_hierarchy(connection, path)
                        connection.execute(
                            """
                            INSERT INTO revisions(
                                revision_id, document_id, parent_revision_id, content,
                                content_hash, size_bytes, actor_id, operation, summary, created_at
                            ) VALUES (?, ?, ?, '', ?, ?, ?, 'move', ?, ?)
                            """,
                            (
                                revision_id,
                                document_id,
                                current.current_revision_id,
                                current.content_hash,
                                current.size_bytes,
                                actor_id,
                                summary or f"Moved to {path}",
                                now,
                            ),
                        )
                        connection.execute(
                            """
                            UPDATE documents
                            SET path = ?, current_revision_id = ?, materialization_state = 'clean',
                                file_hash = ?, updated_at = ?
                            WHERE document_id = ?
                            """,
                            (path, revision_id, current.content_hash, now, document_id),
                        )
                        self._record_idempotency(
                            connection,
                            actor_id=actor_id,
                            key=idempotency_key,
                            operation="move",
                            request_hash=fingerprint,
                            document_id=document_id,
                            revision_id=revision_id,
                        )
                        self.organization._replace_document_search_row(connection, document_id)
                        result = (document_id, revision_id)
            except Exception:
                try:
                    if (
                        source_exists
                        and self.workspace.is_document_file(path)
                        and not self.workspace.is_document_file(old_path)
                    ):
                        self.workspace.move_document(path, old_path)
                except Exception as rollback_err:
                    raise RuntimeError(
                        "Move failed and filesystem rollback failed"
                    ) from rollback_err
                raise

            document = self.get_document(result[0], include_deleted=True)
            self.search_index.sync(document)
            return document

    def delete_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        current = self.get_document(document_id)
        if current.content_type == "application/pdf":
            return self._delete_pdf_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                summary=summary,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        document, _ = self._append_revision(
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=None,
            title=None,
            path=None,
            operation="delete",
            summary=summary,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
            deleted=True,
        )
        return document

    def _delete_pdf_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        with self.mutations.document(document_id):
            payload = {
                "document_id": document_id,
                "expected_revision_id": expected_revision_id,
                "operation": "delete",
                "summary": summary,
                "deleted": True,
            }
            fingerprint = request_hash(payload)
            with self.database.connection() as connection:
                duplicate = self._idempotent_result(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="delete",
                    request_hash=fingerprint,
                )
                if duplicate is not None:
                    return self.get_document(duplicate[0], include_deleted=True)

                current = self._get_document_in_connection(
                    connection, document_id, include_deleted=True
                )
                if current.current_revision_id != expected_revision_id:
                    raise ConflictError(
                        "The document changed since it was read",
                        details={
                            "document_id": document_id,
                            "expected_revision_id": expected_revision_id,
                            "current_revision_id": current.current_revision_id,
                        },
                    )
                if current.deleted:
                    raise NotFoundError(f"Document is deleted: {document_id}")
                if not current.path:
                    raise ValidationError("Unmaterialized documents cannot be moved to trash")

            old_path = current.path
            self.workspace.trash_document(
                document_id=document_id,
                path=old_path,
                content_hash=current.content_hash,
                size_bytes=current.size_bytes,
            )

            try:
                with self.database.transaction() as connection:
                    self.actors.require_known(connection, actor_id)
                    duplicate = self._idempotent_result(
                        connection,
                        actor_id=actor_id,
                        key=idempotency_key,
                        operation="delete",
                        request_hash=fingerprint,
                    )
                    if duplicate is not None:
                        result = duplicate
                    else:
                        now = utc_now()
                        revision_id = str(uuid.uuid4())
                        connection.execute(
                            """
                            INSERT INTO revisions(
                                revision_id, document_id, parent_revision_id, content,
                                content_hash, size_bytes, actor_id, operation, summary, created_at
                            ) VALUES (?, ?, ?, '', ?, ?, ?, 'delete', ?, ?)
                            """,
                            (
                                revision_id,
                                document_id,
                                current.current_revision_id,
                                current.content_hash,
                                current.size_bytes,
                                actor_id,
                                summary or "Moved to trash",
                                now,
                            ),
                        )
                        connection.execute(
                            """
                            UPDATE documents
                            SET current_revision_id = ?, deleted = 1,
                                materialization_state = 'none',
                                file_hash = NULL, updated_at = ?
                            WHERE document_id = ?
                            """,
                            (revision_id, now, document_id),
                        )
                        self._record_idempotency(
                            connection,
                            actor_id=actor_id,
                            key=idempotency_key,
                            operation="delete",
                            request_hash=fingerprint,
                            document_id=document_id,
                            revision_id=revision_id,
                        )
                        self.organization._replace_document_search_row(connection, document_id)
                        result = (document_id, revision_id)
            except Exception:
                try:
                    if self.workspace.has_trashed_document(
                        document_id
                    ) and not self.workspace.is_document_file(old_path):
                        self.workspace.restore_trash_document(
                            document_id=document_id,
                            path=old_path,
                            content_hash=current.content_hash,
                            size_bytes=current.size_bytes,
                        )
                except Exception as rollback_err:
                    raise RuntimeError(
                        "Delete failed and filesystem rollback failed"
                    ) from rollback_err
                raise

            document = self.get_document(result[0], include_deleted=True)
            self.search_index.sync(document)
            return document

    def history(self, document_id: str) -> list[Revision]:
        self.get_document(document_id, include_deleted=True)
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT r.*, a.display_name AS actor_display_name,
                    a.identity_kind AS actor_kind,
                    (
                        SELECT e.operation_id FROM operation_events e
                        WHERE e.revision_id = r.revision_id AND e.outcome = 'accepted'
                        ORDER BY e.created_at, e.operation_id LIMIT 1
                    ) AS operation_id
                FROM revisions r
                JOIN actors a ON a.actor_id = r.actor_id
                WHERE r.document_id = ?
                ORDER BY r.created_at DESC, r.revision_id DESC
                """,
                (document_id,),
            ).fetchall()
        return [Revision.model_validate(dict(row)) for row in rows]

    def revision_diff(
        self, *, document_id: str, from_revision_id: str, to_revision_id: str | None
    ) -> RevisionDiff:
        document = self.get_document(document_id, include_deleted=True)
        if document.content_type == "application/pdf":
            raise ValidationError("Binary PDF revisions do not have a line-oriented diff")
        resolved_to = to_revision_id or document.current_revision_id
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT revision_id, content FROM revisions
                WHERE document_id = ? AND revision_id IN (?, ?)
                """,
                (document_id, from_revision_id, resolved_to),
            ).fetchall()
        contents = {row["revision_id"]: row["content"] for row in rows}
        missing = [
            revision for revision in (from_revision_id, resolved_to) if revision not in contents
        ]
        if missing:
            raise NotFoundError("One or more revisions do not belong to this document")
        lines = list(
            difflib.unified_diff(
                contents[from_revision_id].splitlines(),
                contents[resolved_to].splitlines(),
                fromfile=from_revision_id,
                tofile=resolved_to,
                lineterm="",
            )
        )
        additions = sum(line.startswith("+") and not line.startswith("+++") for line in lines)
        deletions = sum(line.startswith("-") and not line.startswith("---") for line in lines)
        return RevisionDiff(
            document_id=document_id,
            from_revision_id=from_revision_id,
            to_revision_id=resolved_to,
            unified_diff="\n".join(lines),
            additions=additions,
            deletions=deletions,
        )

    def restore_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        revision_id: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        current = self.get_document(document_id, include_deleted=True)
        if current.content_type == "application/pdf":
            if not current.deleted:
                raise ValidationError(
                    "Immutable PDF source bytes cannot be restored as text revisions"
                )
            return self._restore_pdf_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                revision_id=revision_id,
                summary=summary,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )
        with self.database.connection() as connection:
            target = connection.execute(
                "SELECT content FROM revisions WHERE revision_id = ? AND document_id = ?",
                (revision_id, document_id),
            ).fetchone()
        if not target:
            raise NotFoundError(f"Revision not found for document: {revision_id}")
        document, _ = self._append_revision(
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=target["content"],
            title=None,
            path=None,
            operation="restore",
            summary=summary or f"Restored revision {revision_id}",
            actor_id=actor_id,
            idempotency_key=idempotency_key,
            deleted=False,
        )
        return document

    def _restore_pdf_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        revision_id: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        with self.mutations.document(document_id):
            payload = {
                "document_id": document_id,
                "expected_revision_id": expected_revision_id,
                "revision_id": revision_id,
                "operation": "restore",
                "summary": summary,
                "deleted": False,
            }
            fingerprint = request_hash(payload)
            with self.database.connection() as connection:
                duplicate = self._idempotent_result(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="restore",
                    request_hash=fingerprint,
                )
                if duplicate is not None:
                    return self.get_document(duplicate[0], include_deleted=True)

                current = self._get_document_in_connection(
                    connection, document_id, include_deleted=True
                )
                if not current.deleted:
                    raise ValidationError(
                        "Immutable PDF source bytes cannot be restored as text revisions"
                    )
                if current.current_revision_id != expected_revision_id:
                    raise ConflictError(
                        "The document changed since it was read",
                        details={
                            "document_id": document_id,
                            "expected_revision_id": expected_revision_id,
                            "current_revision_id": current.current_revision_id,
                        },
                    )
                if not current.path:
                    raise ValidationError("Cannot restore a document without a path")

                existing = connection.execute(
                    "SELECT document_id FROM documents WHERE path = ? AND deleted = 0",
                    (current.path,),
                ).fetchone()
                if existing and existing["document_id"] != document_id:
                    raise ConflictError(
                        f"Cannot restore document: path is occupied: {current.path}"
                    )
                if connection.execute(
                    "SELECT 1 FROM folders WHERE path = ?", (current.path,)
                ).fetchone():
                    raise ConflictError(
                        f"Cannot restore document: path conflicts with a folder: {current.path}"
                    )

            if self.workspace.is_document_file(current.path):
                raise ConflictError(f"Cannot restore document: path is occupied: {current.path}")
            if not self.workspace.has_trashed_document(document_id):
                raise NotFoundError(f"Retained trash file not found for document: {document_id}")

            target_path = current.path
            self.workspace.restore_trash_document(
                document_id=document_id,
                path=target_path,
                content_hash=current.content_hash,
                size_bytes=current.size_bytes,
            )

            try:
                with self.database.transaction() as connection:
                    self.actors.require_known(connection, actor_id)
                    duplicate = self._idempotent_result(
                        connection,
                        actor_id=actor_id,
                        key=idempotency_key,
                        operation="restore",
                        request_hash=fingerprint,
                    )
                    if duplicate is not None:
                        result = duplicate
                    else:
                        now = utc_now()
                        new_revision_id = str(uuid.uuid4())
                        self.organization.ensure_document_folder_hierarchy(connection, target_path)
                        connection.execute(
                            """
                            INSERT INTO revisions(
                                revision_id, document_id, parent_revision_id, content,
                                content_hash, size_bytes, actor_id, operation, summary, created_at
                            ) VALUES (?, ?, ?, '', ?, ?, ?, 'restore', ?, ?)
                            """,
                            (
                                new_revision_id,
                                document_id,
                                current.current_revision_id,
                                current.content_hash,
                                current.size_bytes,
                                actor_id,
                                summary or f"Restored {document_id} from trash",
                                now,
                            ),
                        )
                        connection.execute(
                            """
                            UPDATE documents
                            SET current_revision_id = ?, deleted = 0,
                                materialization_state = 'clean',
                                file_hash = ?, updated_at = ?
                            WHERE document_id = ?
                            """,
                            (new_revision_id, current.content_hash, now, document_id),
                        )
                        self._record_idempotency(
                            connection,
                            actor_id=actor_id,
                            key=idempotency_key,
                            operation="restore",
                            request_hash=fingerprint,
                            document_id=document_id,
                            revision_id=new_revision_id,
                        )
                        self.organization._replace_document_search_row(connection, document_id)
                        result = (document_id, new_revision_id)
            except Exception:
                try:
                    if self.workspace.is_document_file(
                        target_path
                    ) and not self.workspace.has_trashed_document(document_id):
                        self.workspace.trash_document(
                            document_id=document_id,
                            path=target_path,
                            content_hash=current.content_hash,
                            size_bytes=current.size_bytes,
                        )
                except Exception as rollback_err:
                    raise RuntimeError(
                        "Restore failed and filesystem rollback failed"
                    ) from rollback_err
                raise

            document = self.get_document(result[0], include_deleted=True)
            self.search_index.sync(document)
            return document

    def _finish_materialization(self, document: Document) -> None:
        if document.deleted or not document.path:
            return
        try:
            file_hash = self.workspace.write_atomic(document.path, document.content)
        except Exception as error:
            raise MaterializationError(
                "The revision was committed, but its workspace file is still pending",
                details={
                    "document_id": document.document_id,
                    "revision_id": document.current_revision_id,
                    "path": document.path,
                },
            ) from error
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE documents
                SET materialization_state = 'clean', file_hash = ?
                WHERE document_id = ? AND current_revision_id = ?
                """,
                (file_hash, document.document_id, document.current_revision_id),
            )

    def rematerialize_document(self, document_id: str) -> Document:
        """Rewrite a materialized document from the canonical database head."""
        with self.mutations.document(document_id):
            document = self.get_document(document_id)
            if document.content_type == "application/pdf":
                raise ValidationError(
                    "Missing PDF bytes must be restored from backup; they are not stored in SQLite"
                )
            self._finish_materialization(document)
            return self.get_document(document_id)

    def _require_text_document(self, document_id: str, message: str) -> Document:
        document = self.get_document(document_id, include_deleted=True)
        if document.content_type == "application/pdf":
            raise ValidationError(message)
        return document

    def update_document_metadata(
        self,
        *,
        document_id: str,
        expected_metadata_version: int,
        category: str | None,
        tag_ids: list[str],
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        with self.mutations.document(document_id):
            return self._update_document_metadata_locked(
                document_id=document_id,
                expected_metadata_version=expected_metadata_version,
                category=category,
                tag_ids=tag_ids,
                actor_id=actor_id,
                idempotency_key=idempotency_key,
            )

    def _update_document_metadata_locked(
        self,
        *,
        document_id: str,
        expected_metadata_version: int,
        category: str | None,
        tag_ids: list[str],
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        normalized_category = category.strip() if category and category.strip() else None
        payload = {
            "document_id": document_id,
            "expected_metadata_version": expected_metadata_version,
            "category": normalized_category,
            "tag_ids": sorted(set(tag_ids)),
        }
        fingerprint = request_hash(payload)
        with self.database.transaction() as connection:
            self.actors.require_known(connection, actor_id)
            duplicate = self._idempotent_result(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="metadata",
                request_hash=fingerprint,
            )
            if duplicate is None:
                current = self._get_document_in_connection(
                    connection, document_id, include_deleted=False
                )
                if current.metadata_version != expected_metadata_version:
                    raise ConflictError(
                        "Document metadata changed since it was read",
                        details={
                            "document_id": document_id,
                            "expected_metadata_version": expected_metadata_version,
                            "current_metadata_version": current.metadata_version,
                        },
                    )
                valid_tag_ids = self.organization.validate_tag_ids(connection, tag_ids)
                before = {
                    "category": current.category,
                    "tag_ids": [tag.tag_id for tag in current.tags],
                    "metadata_version": current.metadata_version,
                }
                now = utc_now()
                connection.execute(
                    """
                    UPDATE documents
                    SET category = ?, metadata_version = metadata_version + 1, updated_at = ?
                    WHERE document_id = ?
                    """,
                    (normalized_category, now, document_id),
                )
                connection.execute(
                    "DELETE FROM document_tags WHERE document_id = ?", (document_id,)
                )
                connection.executemany(
                    "INSERT INTO document_tags(document_id, tag_id) VALUES (?, ?)",
                    [(document_id, tag_id) for tag_id in valid_tag_ids],
                )
                after = {
                    "category": normalized_category,
                    "tag_ids": valid_tag_ids,
                    "metadata_version": current.metadata_version + 1,
                }
                connection.execute(
                    """
                    INSERT INTO metadata_events(
                        event_id, entity_type, entity_id, actor_id,
                        operation, before_json, after_json, created_at
                    ) VALUES (?, 'document', ?, ?, 'organize', ?, ?, ?)
                    """,
                    (
                        str(uuid.uuid4()),
                        document_id,
                        actor_id,
                        json.dumps(before),
                        json.dumps(after),
                        now,
                    ),
                )
                self._record_idempotency(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="metadata",
                    request_hash=fingerprint,
                    document_id=document_id,
                    revision_id=current.current_revision_id,
                )
        updated = self.get_document(document_id)
        self.search_index.sync(updated)
        return updated

    def search_documents(
        self,
        *,
        query: str = "",
        tag_id: str | None = None,
        category: str | None = None,
        sort: str = "relevance",
        actor_id: str | None = None,
        path_prefixes: tuple[str, ...] | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[DocumentSummary]:
        if path_prefixes == ():
            return []
        expression = self.search_index.compile_expression(query)
        conditions = ["d.deleted = 0"]
        parameters: list[object] = []
        if expression:
            conditions.append("document_search MATCH ?")
            parameters.append(expression)
        if tag_id:
            conditions.append(
                "EXISTS (SELECT 1 FROM document_tags dt "
                "WHERE dt.document_id = d.document_id AND dt.tag_id = ?)"
            )
            parameters.append(tag_id)
        if category:
            conditions.append("d.category = ? COLLATE NOCASE")
            parameters.append(category)
        if actor_id:
            conditions.append(
                "EXISTS (SELECT 1 FROM revisions ar "
                "WHERE ar.document_id = d.document_id AND ar.actor_id = ?)"
            )
            parameters.append(actor_id)
        self._add_path_filter(conditions, parameters, path_prefixes)
        if sort == "title":
            ordering = "d.title COLLATE NOCASE, d.document_id"
        elif sort == "path":
            ordering = "COALESCE(d.path, '') COLLATE NOCASE, d.document_id"
        elif sort == "updated":
            ordering = "d.updated_at DESC, d.document_id DESC"
        elif sort == "relevance" and expression:
            ordering = "bm25(document_search), d.document_id"
        elif sort == "relevance":
            ordering = "d.updated_at DESC, d.document_id"
        elif sort != "relevance":
            raise ValidationError(f"Unsupported search sort: {sort}")
        parameters.extend((limit, offset))
        with self.database.connection() as connection:
            rows = connection.execute(
                self._document_query(
                    include_content=False,
                    include_search=expression is not None,
                )
                + f" WHERE {' AND '.join(conditions)}"
                + f" ORDER BY {ordering} LIMIT ? OFFSET ?",
                parameters,
            ).fetchall()
        return [self._document_summary_from_row(row) for row in rows]

    def rebuild_search_index(self) -> int:
        documents = self.list_documents(include_deleted=True)
        self.search_index.rebuild(documents)
        return sum(not document.deleted for document in documents)
