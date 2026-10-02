from __future__ import annotations

import base64
import binascii
import difflib
import hashlib
import json
import sqlite3
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import PurePosixPath

from sangam.actors import ActorService
from sangam.db import Database, utc_now
from sangam.errors import (
    ConflictError,
    MaterializationError,
    NotFoundError,
    ValidationError,
    validate_metadata_text,
)
from sangam.idempotency import IdempotencyStore, request_hash
from sangam.mutations import MutationCoordinator
from sangam.organization import WorkspaceOrganizationService
from sangam.schemas import (
    Document,
    DocumentSummary,
    Revision,
    RevisionDiff,
    RevisionPage,
    RevisionSummary,
    Tag,
)
from sangam.search import SearchIndex
from sangam.search_passages import attach_search_matches
from sangam.workspace import WorkspaceFilesystem


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _encode_revision_cursor(document_id: str, created_at: str, revision_id: str) -> str:
    payload = json.dumps([document_id, created_at, revision_id], separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_revision_cursor(cursor: str, document_id: str) -> tuple[str, str]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.b64decode(padded, altchars=b"-_", validate=True))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise ValidationError("Invalid revision cursor") from error
    if (
        not isinstance(value, list)
        or len(value) != 3
        or value[0] != document_id
        or not isinstance(value[1], str)
        or not isinstance(value[2], str)
    ):
        raise ValidationError("Revision cursor does not match this document")
    return value[1], value[2]


@dataclass(frozen=True)
class Written:
    """The revision one write committed, and workspace files it left stale."""

    revision_id: str
    stale_paths: tuple[str, ...] = ()


@dataclass(frozen=True)
class FileStep:
    """A workspace file change that must precede its commit, and how to undo it."""

    apply: Callable[[], None]
    undo: Callable[[], None]


def _require_revision(current: Document, expected_revision_id: str) -> None:
    if current.current_revision_id != expected_revision_id:
        raise ConflictError(
            "The document changed since it was read",
            details={
                "document_id": current.document_id,
                "expected_revision_id": expected_revision_id,
                "current_revision_id": current.current_revision_id,
            },
        )


def append_fingerprint(
    *,
    document_id: str,
    expected_revision_id: str,
    content: str | None,
    title: str | None,
    path: str | None,
    operation: str,
    summary: str | None,
    deleted: bool | None,
) -> str:
    """The request hash a text revision append binds to its idempotency key.

    Recovery code that must prove a key committed one exact append rebuilds it here.
    """
    return request_hash(
        {
            "document_id": document_id,
            "expected_revision_id": expected_revision_id,
            "content": content,
            "title": title,
            "path": path,
            "operation": operation,
            "summary": summary,
            "deleted": deleted,
        }
    )


def default_duplicate_path(document: Document) -> str | None:
    """Name a PDF copy beside its source; text copies default to pathless drafts."""
    if document.content_type != "application/pdf" or not document.path:
        return None
    source = PurePosixPath(document.path)
    return (source.parent / f"{source.stem} copy{source.suffix}").as_posix()


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

    normalize_document_path = _normalize_path

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

    def _document_query(
        self,
        *,
        include_content: bool = True,
        include_search: bool = False,
        include_snippet: bool = True,
    ) -> str:
        content_projection = ", r.content" if include_content else ""
        search_projection = (
            ", snippet(document_search, -1, '[[', ']]', ' … ', 24) AS search_snippet"
            if include_search and include_snippet
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

    def get_document_in_connection(
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
            return self.get_document_in_connection(
                connection, document_id, include_deleted=include_deleted
            )

    def revision_content(self, document_id: str, revision_id: str) -> str:
        """Read one immutable revision's text, scoped to its own document."""
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT content FROM revisions WHERE revision_id = ? AND document_id = ?",
                (revision_id, document_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Revision not found for document: {revision_id}")
        return row["content"]

    def finish_replayed_write(self, document_id: str) -> Document:
        """Complete a replayed write: materialize a pending head and re-index it.

        A replay never appends a revision, but the original request may have
        crashed after commit and before its workspace file was written.
        """
        document = self.get_document(document_id, include_deleted=True)
        self._finish_if_current(document.document_id, document.current_revision_id)
        document = self.get_document(document_id, include_deleted=True)
        with self.database.transaction():
            self.database.set_audit_target(
                resource_id=document.document_id,
                revision_id=document.current_revision_id,
                path=document.path,
            )
            self.search_index.sync(document)
        return document

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
                current = self.get_document_in_connection(connection, document_id)
                self.database.set_audit_target(
                    resource_id=document_id,
                    revision_id=current.current_revision_id,
                    path=current.path,
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

    def iter_documents(
        self, *, include_deleted: bool = False, batch_size: int = 500
    ) -> Iterator[Document]:
        offset = 0
        while True:
            with self.database.connection() as connection:
                rows = connection.execute(
                    self._document_query()
                    + ("" if include_deleted else " WHERE d.deleted = 0")
                    + " ORDER BY d.updated_at DESC, d.document_id LIMIT ? OFFSET ?",
                    (batch_size, offset),
                ).fetchall()
            if not rows:
                break
            for row in rows:
                yield self._document_from_row(row)
            offset += len(rows)

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
    def _extract_backlink_snippet(content: str, document_id: str, window: int = 50) -> str | None:
        patterns = (f"sangam://document/{document_id}", f"/documents/{document_id}")
        pos = -1
        matched_pat = ""
        for pat in patterns:
            idx = content.find(pat)
            if idx != -1:
                pos = idx
                matched_pat = pat
                break
        if pos == -1:
            return None
        link_start = content.rfind("[", max(0, pos - 100), pos)
        start = max(0, link_start - window) if link_start != -1 else max(0, pos - window)
        link_end = content.find(")", pos)
        if link_end != -1 and link_end < pos + len(matched_pat) + 100:
            end = min(len(content), link_end + 1 + window)
        else:
            end = min(len(content), pos + len(matched_pat) + window)
        prefix = "… " if start > 0 else ""
        suffix = " …" if end < len(content) else ""
        raw_snippet = content[start:end].replace("\r", "").replace("\n", " ").strip()
        return f"{prefix}{raw_snippet}{suffix}"

    def get_backlinks(
        self,
        document_id: str,
        *,
        path_prefixes: tuple[str, ...] | None = None,
        limit: int = 50,
    ) -> list[DocumentSummary]:
        if path_prefixes == ():
            return []
        self.get_document(document_id, include_deleted=True)
        conditions = [
            "d.deleted = 0",
            "d.document_id != ?",
            "(r.content LIKE ? OR r.content LIKE ?)",
        ]
        parameters: list[object] = [
            document_id,
            f"%sangam://document/{document_id}%",
            f"%/documents/{document_id}%",
        ]
        self._add_path_filter(conditions, parameters, path_prefixes)
        where = f" WHERE {' AND '.join(conditions)}"
        parameters.append(limit)
        with self.database.connection() as connection:
            rows = connection.execute(
                self._document_query(include_content=True)
                + where
                + " ORDER BY d.updated_at DESC, d.document_id LIMIT ?",
                parameters,
            ).fetchall()
        summaries: list[DocumentSummary] = []
        for row in rows:
            content = row["content"]
            snippet = self._extract_backlink_snippet(content, document_id)
            summary = self._document_summary_from_row(row)
            if snippet:
                summary.search_snippet = snippet
            summaries.append(summary)
        return summaries

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

    def legacy_duplicate_replay_matches(
        self,
        connection: sqlite3.Connection,
        *,
        actor_id: str,
        source_document_id: str,
        expected_revision_id: str,
        title: str | None,
        path: str | None,
        result_document_id: str,
        result_revision_id: str,
        stored_request_hash: str,
    ) -> bool:
        """Recover old create-shaped duplicate keys only with source-bound provenance.

        Old duplicates recorded a create revision but an accepted duplicate audit.
        Ordinary create keys, including keys later misused by the old wrapper,
        must never become duplicate replay grants.
        """
        source_revision = connection.execute(
            "SELECT r.content, d.title, d.content_type FROM revisions r "
            "JOIN documents d ON d.document_id = r.document_id "
            "WHERE r.document_id = ? AND r.revision_id = ?",
            (source_document_id, expected_revision_id),
        ).fetchone()
        if source_revision is None:
            return False
        if connection.execute(
            "SELECT 1 FROM operation_events WHERE actor_id = ? AND resource_id = ? "
            "AND revision_id = ? AND action = 'create' AND outcome = 'accepted'",
            (actor_id, result_document_id, result_revision_id),
        ).fetchone():
            return False
        normalized_path = self._normalize_path(path) if path is not None else None
        # Audit strings can be redacted. The original checksum still proves
        # exact arguments using the immutable source revision, not its new head.
        checksum_matches = stored_request_hash == request_hash(
            {
                "title": title or f"{source_revision['title']} copy",
                "content": source_revision["content"],
                "path": normalized_path,
                "content_type": source_revision["content_type"],
            }
        )
        rows = connection.execute(
            "SELECT detail_json FROM operation_events WHERE actor_id = ? "
            "AND resource_id = ? AND revision_id = ? "
            "AND action = 'duplicate' AND outcome = 'accepted'",
            (actor_id, result_document_id, result_revision_id),
        ).fetchall()
        for row in rows:
            details = json.loads(row["detail_json"])
            original_path = details.get("destination_path")
            if original_path is not None:
                original_path = self._normalize_path(original_path)
            if details.get("expected_revision_id") == expected_revision_id and (
                checksum_matches
                or (details.get("title") == title and original_path == normalized_path)
            ):
                return True
        return False

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
        normalized_path = self._normalize_path(path) if path is not None else None
        with (
            self.mutations.creation(actor_id=actor_id, idempotency_key=idempotency_key),
            self.mutations.paths(normalized_path),
        ):
            fingerprint = request_hash(
                {
                    "title": title,
                    "content": content,
                    "path": normalized_path,
                    "content_type": content_type,
                }
            )
            with self.database.connection() as connection:
                duplicate = self.idempotency.document_result(
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

    def create_draft_in_transaction(
        self, *, title: str, content: str, actor_id: str, idempotency_key: str
    ) -> Document:
        """Create a pathless Markdown draft inside the caller's open transaction.

        The caller owns atomicity and auditing. The new ID stays private until the
        caller commits, and a draft has no workspace file, so no lock is needed.
        """
        return self._create_document_locked(
            document_id=str(uuid.uuid4()),
            title=title,
            content=content,
            path=None,
            content_type="text/markdown",
            actor_id=actor_id,
            idempotency_key=idempotency_key,
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
        validate_metadata_text(title, "Document title")
        self._validate_content_size(content)
        normalized_path = self._normalize_path(path) if path is not None else None
        if content_type not in {"text/markdown", "text/html"}:
            raise ValidationError("Unsupported text document content type")
        self._validate_path_type(normalized_path, content_type)

        def write(connection: sqlite3.Connection) -> Written:
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
                self.organization.ensure_document_folder_hierarchy(connection, normalized_path)
            connection.execute(
                """
                INSERT INTO revisions(
                    revision_id, document_id, parent_revision_id, content,
                    content_hash, size_bytes, actor_id, operation, summary, created_at
                ) VALUES (?, ?, NULL, ?, ?, ?, ?, 'create', NULL, ?)
                """,
                (revision_id, document_id, content, content_hash, size_bytes, actor_id, now),
            )
            connection.execute(
                "UPDATE documents SET current_revision_id = ? WHERE document_id = ?",
                (revision_id, document_id),
            )
            return Written(revision_id)

        return self._commit(
            document_id=document_id,
            operation="create",
            fingerprint=request_hash(
                {
                    "title": title,
                    "content": content,
                    "path": normalized_path,
                    "content_type": content_type,
                }
            ),
            actor_id=actor_id,
            idempotency_key=idempotency_key,
            write=write,
        )

    def _commit(
        self,
        *,
        document_id: str,
        operation: str,
        fingerprint: str,
        actor_id: str,
        idempotency_key: str,
        write: Callable[[sqlite3.Connection], Written],
        prepare: Callable[[sqlite3.Connection, Document], FileStep] | None = None,
    ) -> Document:
        """Commit one document write through the protocol every write shares.

        Callers hold the document and path locks. ``prepare`` validates against a
        read snapshot and returns a workspace file change that must precede the
        commit (PDF bytes live only on disk); it is undone if the commit fails.
        ``write`` runs in the committing transaction after the actor and replay
        checks and must re-check its own preconditions there. The pipeline binds
        the idempotency key, names the ledger target, then materializes text,
        removes stale files, and re-indexes search after the commit.
        """
        file_step: FileStep | None = None
        if prepare is not None:
            with self.database.connection() as connection:
                replayed = self.idempotency.document_result(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation=operation,
                    request_hash=fingerprint,
                )
                if replayed is None:
                    file_step = prepare(
                        connection, self.get_document_in_connection(connection, document_id)
                    )
            if file_step is not None:
                file_step.apply()
        stale_paths: tuple[str, ...] = ()
        try:
            with self.database.transaction() as connection:
                self.actors.require_known(connection, actor_id)
                replayed = self.idempotency.document_result(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation=operation,
                    request_hash=fingerprint,
                )
                if replayed is None:
                    written = write(connection)
                    revision_id, stale_paths = written.revision_id, written.stale_paths
                    self.idempotency.record_document(
                        connection,
                        actor_id=actor_id,
                        key=idempotency_key,
                        operation=operation,
                        request_hash=fingerprint,
                        document_id=document_id,
                        revision_id=revision_id,
                    )
                else:
                    document_id, revision_id = replayed
                path_row = connection.execute(
                    "SELECT path FROM documents WHERE document_id = ?", (document_id,)
                ).fetchone()
                self.database.set_audit_target(
                    resource_id=document_id,
                    revision_id=revision_id,
                    path=path_row["path"] if path_row else None,
                )
        except Exception as error:
            if file_step is not None:
                try:
                    file_step.undo()
                except Exception as rollback_error:
                    raise RuntimeError(
                        f"{operation.capitalize()} failed and filesystem rollback failed"
                    ) from rollback_error
            if isinstance(error, sqlite3.IntegrityError):
                raise ValidationError("A document already uses that path") from error
            raise
        self._finish_if_current(document_id, revision_id)
        for stale_path in stale_paths:
            self.workspace.delete_document(stale_path)
        result = self.get_document(document_id, include_deleted=True)
        if result.deleted and result.path and result.content_type != "application/pdf":
            self.workspace.delete_document(result.path)
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
    ) -> Document:
        """Append one text revision under the document's path and identity locks."""
        current = self.get_document(document_id, include_deleted=True)
        target_path = self._normalize_path(path) if path is not None else None
        with (
            self.mutations.paths(current.path, target_path),
            self.mutations.document(document_id),
        ):
            validate_metadata_text(title, "Document title")
            validate_metadata_text(summary, "Revision summary")

            def write(connection: sqlite3.Connection) -> Written:
                current = self.get_document_in_connection(connection, document_id)
                _require_revision(current, expected_revision_id)
                if current.deleted and operation != "restore":
                    raise NotFoundError(f"Document is deleted: {document_id}")
                next_content = current.content if content is None else content
                self._validate_content_size(next_content)
                next_title = current.title if title is None else title.strip()
                next_path = current.path if path is None else path
                next_deleted = current.deleted if deleted is None else deleted
                if next_deleted or not next_path:
                    state, file_hash = "none", None
                else:
                    state = "pending"
                    file_hash = current.file_hash if current.path == next_path else None
                revision_id = self._insert_revision(
                    connection,
                    current,
                    content=next_content,
                    actor_id=actor_id,
                    operation=operation,
                    summary=summary,
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
                        _content_hash(next_content),
                        len(next_content.encode("utf-8")),
                        state,
                        file_hash,
                        int(next_deleted),
                        utc_now(),
                        document_id,
                    ),
                )
                moved_from = current.path if current.path and current.path != next_path else None
                return Written(revision_id, (moved_from,) if moved_from else ())

            return self._commit(
                document_id=document_id,
                operation=operation,
                fingerprint=append_fingerprint(
                    document_id=document_id,
                    expected_revision_id=expected_revision_id,
                    content=content,
                    title=title,
                    path=path,
                    operation=operation,
                    summary=summary,
                    deleted=deleted,
                ),
                actor_id=actor_id,
                idempotency_key=idempotency_key,
                write=write,
            )

    @staticmethod
    def _insert_revision(
        connection: sqlite3.Connection,
        current: Document,
        *,
        content: str,
        actor_id: str,
        operation: str,
        summary: str | None,
        content_hash: str | None = None,
        size_bytes: int | None = None,
    ) -> str:
        """Append an immutable revision as the child of the current head."""
        revision_id = str(uuid.uuid4())
        connection.execute(
            """
            INSERT INTO revisions(
                revision_id, document_id, parent_revision_id, content,
                content_hash, size_bytes, actor_id, operation, summary, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                revision_id,
                current.document_id,
                current.current_revision_id,
                content,
                content_hash or _content_hash(content),
                len(content.encode("utf-8")) if size_bytes is None else size_bytes,
                actor_id,
                operation,
                summary,
                utc_now(),
            ),
        )
        return revision_id

    def _commit_pdf_head(
        self,
        connection: sqlite3.Connection,
        *,
        document_id: str,
        expected_revision_id: str,
        operation: str,
        summary: str,
        actor_id: str,
        assignments: str,
        parameters: tuple[object, ...],
    ) -> Written:
        """Record a PDF identity change as a byte-less revision of the same content."""
        current = self.get_document_in_connection(connection, document_id)
        _require_revision(current, expected_revision_id)
        revision_id = self._insert_revision(
            connection,
            current,
            content="",
            actor_id=actor_id,
            operation=operation,
            summary=summary,
            content_hash=current.content_hash,
            size_bytes=current.size_bytes,
        )
        connection.execute(
            f"UPDATE documents SET current_revision_id = ?, {assignments}, updated_at = ? "
            "WHERE document_id = ?",
            (revision_id, *parameters, utc_now(), document_id),
        )
        return Written(revision_id)

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
        return self._append_revision(
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
        return self._append_revision(
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
        validate_metadata_text(title, "Document title")
        source = self.get_document(document_id)
        target_path = self._normalize_path(path) if path is not None else None
        with self.mutations.paths(source.path, target_path):
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
        destination_path = self._normalize_path(path or default_duplicate_path(source) or "")
        self._validate_path_type(destination_path, "application/pdf")
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
        return self._append_revision(
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
        return self._append_revision(
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
        current = self.get_document(document_id, include_deleted=True)

        def prepare(connection: sqlite3.Connection, current: Document) -> FileStep:
            _require_revision(current, expected_revision_id)
            if current.deleted:
                raise NotFoundError(f"Document is deleted: {document_id}")
            if current.path == path:
                raise ValidationError("A document cannot be moved to its current path")
            if not current.path:
                raise ValidationError("Unmaterialized documents must be materialized before moving")
            existing = connection.execute(
                "SELECT document_id FROM documents WHERE path = ? AND deleted = 0", (path,)
            ).fetchone()
            if existing and existing["document_id"] != document_id:
                raise ConflictError(f"A document already uses that path: {path}")
            if connection.execute("SELECT 1 FROM folders WHERE path = ?", (path,)).fetchone():
                raise ConflictError(f"Destination path conflicts with a folder: {path}")
            old_path = current.path
            source_exists = self.workspace.is_document_file(old_path)
            if source_exists and self.workspace.is_document_file(path):
                raise ConflictError(f"A workspace file already exists at that path: {path}")

            def apply() -> None:
                if source_exists:
                    self.workspace.move_document(old_path, path)

            def undo() -> None:
                if (
                    source_exists
                    and self.workspace.is_document_file(path)
                    and not self.workspace.is_document_file(old_path)
                ):
                    self.workspace.move_document(path, old_path)

            return FileStep(apply=apply, undo=undo)

        def write(connection: sqlite3.Connection) -> Written:
            self.organization.ensure_document_folder_hierarchy(connection, path)
            return self._commit_pdf_head(
                connection,
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                operation="move",
                summary=summary or f"Moved to {path}",
                actor_id=actor_id,
                assignments="path = ?, materialization_state = 'clean', file_hash = content_hash",
                parameters=(path,),
            )

        with self.mutations.paths(current.path, path), self.mutations.document(document_id):
            return self._commit(
                document_id=document_id,
                operation="move",
                fingerprint=request_hash(
                    {
                        "document_id": document_id,
                        "expected_revision_id": expected_revision_id,
                        "path": path,
                        "operation": "move",
                        "summary": summary,
                    }
                ),
                actor_id=actor_id,
                idempotency_key=idempotency_key,
                write=write,
                prepare=prepare,
            )

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
        return self._append_revision(
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

    def _delete_pdf_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        current = self.get_document(document_id, include_deleted=True)

        def prepare(connection: sqlite3.Connection, current: Document) -> FileStep:
            del connection
            _require_revision(current, expected_revision_id)
            if current.deleted:
                raise NotFoundError(f"Document is deleted: {document_id}")
            if not current.path:
                raise ValidationError("Unmaterialized documents cannot be moved to trash")
            path = current.path

            def apply() -> None:
                self.workspace.trash_document(
                    document_id=document_id,
                    path=path,
                    content_hash=current.content_hash,
                    size_bytes=current.size_bytes,
                )

            def undo() -> None:
                if self.workspace.has_trashed_document(
                    document_id
                ) and not self.workspace.is_document_file(path):
                    self.workspace.restore_trash_document(
                        document_id=document_id,
                        path=path,
                        content_hash=current.content_hash,
                        size_bytes=current.size_bytes,
                    )

            return FileStep(apply=apply, undo=undo)

        def write(connection: sqlite3.Connection) -> Written:
            return self._commit_pdf_head(
                connection,
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                operation="delete",
                summary=summary or "Moved to trash",
                actor_id=actor_id,
                assignments="deleted = 1, materialization_state = 'none', file_hash = NULL",
                parameters=(),
            )

        with self.mutations.paths(current.path), self.mutations.document(document_id):
            return self._commit(
                document_id=document_id,
                operation="delete",
                fingerprint=request_hash(
                    {
                        "document_id": document_id,
                        "expected_revision_id": expected_revision_id,
                        "operation": "delete",
                        "summary": summary,
                        "deleted": True,
                    }
                ),
                actor_id=actor_id,
                idempotency_key=idempotency_key,
                write=write,
                prepare=prepare,
            )

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

    def revision_page(self, document_id: str, *, limit: int, cursor: str | None) -> RevisionPage:
        """Read a bounded page of revision metadata without selecting revision content."""
        self.get_document(document_id, include_deleted=True)
        before: tuple[str, str] | None = None
        if cursor:
            before = _decode_revision_cursor(cursor, document_id)
        parameters: list[object] = [document_id]
        boundary = ""
        if before:
            boundary = "AND (r.created_at, r.revision_id) < (?, ?)"
            parameters.extend(before)
        parameters.append(limit + 1)
        with self.database.connection() as connection:
            rows = connection.execute(
                f"""
                SELECT r.revision_id, r.document_id, r.parent_revision_id,
                    r.content_hash, r.size_bytes, r.actor_id,
                    a.display_name AS actor_display_name,
                    a.identity_kind AS actor_kind, r.operation, r.summary, r.created_at,
                    (
                        SELECT e.operation_id FROM operation_events e
                        WHERE e.revision_id = r.revision_id AND e.outcome = 'accepted'
                        ORDER BY e.created_at, e.operation_id LIMIT 1
                    ) AS operation_id
                FROM revisions r
                JOIN actors a ON a.actor_id = r.actor_id
                WHERE r.document_id = ? {boundary}
                ORDER BY r.created_at DESC, r.revision_id DESC
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        has_more = len(rows) > limit
        visible = rows[:limit]
        next_cursor = None
        if has_more and visible:
            last = visible[-1]
            next_cursor = _encode_revision_cursor(
                document_id, last["created_at"], last["revision_id"]
            )
        return RevisionPage(
            items=[RevisionSummary.model_validate(dict(row)) for row in visible],
            next_cursor=next_cursor,
        )

    def get_revision(self, document_id: str, revision_id: str) -> Revision:
        self.get_document(document_id, include_deleted=True)
        with self.database.connection() as connection:
            row = connection.execute(
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
                WHERE r.document_id = ? AND r.revision_id = ?
                """,
                (document_id, revision_id),
            ).fetchone()
        if row is None:
            raise NotFoundError("Revision does not belong to this document")
        return Revision.model_validate(dict(row))

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
        return self._append_revision(
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=self.revision_content(document_id, revision_id),
            title=None,
            path=None,
            operation="restore",
            summary=summary or f"Restored revision {revision_id}",
            actor_id=actor_id,
            idempotency_key=idempotency_key,
            deleted=False,
        )

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
        current = self.get_document(document_id, include_deleted=True)

        def prepare(connection: sqlite3.Connection, current: Document) -> FileStep:
            if not current.deleted:
                raise ValidationError(
                    "Immutable PDF source bytes cannot be restored as text revisions"
                )
            _require_revision(current, expected_revision_id)
            if not current.path:
                raise ValidationError("Cannot restore a document without a path")
            path = current.path
            existing = connection.execute(
                "SELECT document_id FROM documents WHERE path = ? AND deleted = 0", (path,)
            ).fetchone()
            if existing and existing["document_id"] != document_id:
                raise ConflictError(f"Cannot restore document: path is occupied: {path}")
            if connection.execute("SELECT 1 FROM folders WHERE path = ?", (path,)).fetchone():
                raise ConflictError(
                    f"Cannot restore document: path conflicts with a folder: {path}"
                )
            if self.workspace.is_document_file(path):
                raise ConflictError(f"Cannot restore document: path is occupied: {path}")
            if not self.workspace.has_trashed_document(document_id):
                raise NotFoundError(f"Retained trash file not found for document: {document_id}")

            def apply() -> None:
                self.workspace.restore_trash_document(
                    document_id=document_id,
                    path=path,
                    content_hash=current.content_hash,
                    size_bytes=current.size_bytes,
                )

            def undo() -> None:
                if self.workspace.is_document_file(
                    path
                ) and not self.workspace.has_trashed_document(document_id):
                    self.workspace.trash_document(
                        document_id=document_id,
                        path=path,
                        content_hash=current.content_hash,
                        size_bytes=current.size_bytes,
                    )

            return FileStep(apply=apply, undo=undo)

        def write(connection: sqlite3.Connection) -> Written:
            if current.path:
                self.organization.ensure_document_folder_hierarchy(connection, current.path)
            return self._commit_pdf_head(
                connection,
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                operation="restore",
                summary=summary or f"Restored {document_id} from trash",
                actor_id=actor_id,
                assignments=(
                    "deleted = 0, materialization_state = 'clean', file_hash = content_hash"
                ),
                parameters=(),
            )

        with self.mutations.paths(current.path), self.mutations.document(document_id):
            return self._commit(
                document_id=document_id,
                operation="restore",
                fingerprint=request_hash(
                    {
                        "document_id": document_id,
                        "expected_revision_id": expected_revision_id,
                        "revision_id": revision_id,
                        "operation": "restore",
                        "summary": summary,
                        "deleted": False,
                    }
                ),
                actor_id=actor_id,
                idempotency_key=idempotency_key,
                write=write,
                prepare=prepare,
            )

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
            self.database.set_audit_target(
                resource_id=document.document_id,
                revision_id=document.current_revision_id,
                path=document.path,
            )

    def rematerialize_document(self, document_id: str) -> Document:
        """Rewrite a materialized document from the canonical database head."""
        document = self.get_document(document_id)
        with (
            self.mutations.paths(document.path),
            self.mutations.document(document_id),
        ):
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
        validate_metadata_text(category, "Document category")
        normalized_category = category.strip() if category and category.strip() else None

        def write(connection: sqlite3.Connection) -> Written:
            current = self.get_document_in_connection(
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
            connection.execute("DELETE FROM document_tags WHERE document_id = ?", (document_id,))
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
            # Metadata is not content: the key binds to the unchanged head revision.
            return Written(current.current_revision_id)

        return self._commit(
            document_id=document_id,
            operation="metadata",
            fingerprint=request_hash(
                {
                    "document_id": document_id,
                    "expected_metadata_version": expected_metadata_version,
                    "category": normalized_category,
                    "tag_ids": sorted(set(tag_ids)),
                }
            ),
            actor_id=actor_id,
            idempotency_key=idempotency_key,
            write=write,
        )

    def search_documents(
        self,
        *,
        query: str = "",
        tag_id: str | None = None,
        category: str | None = None,
        sort: str = "relevance",
        actor_id: str | None = None,
        content_type: str | None = None,
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
        if content_type:
            conditions.append("d.content_type = ?")
            parameters.append(content_type)
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
                # FTS snippet() would run for every match before LIMIT; passages
                # are located afterwards for the returned page only.
                self._document_query(
                    include_content=False,
                    include_search=expression is not None,
                    include_snippet=False,
                )
                + f" WHERE {' AND '.join(conditions)}"
                + f" ORDER BY {ordering} LIMIT ? OFFSET ?",
                parameters,
            ).fetchall()
            documents = [self._document_summary_from_row(row) for row in rows]
            if expression is None:
                return documents
            return attach_search_matches(connection, documents, query, expression)

    def rebuild_search_index(self) -> int:
        count = 0

        def count_and_yield():
            nonlocal count
            for doc in self.iter_documents(include_deleted=True):
                if not doc.deleted:
                    count += 1
                yield doc

        self.search_index.rebuild(count_and_yield())
        return count
