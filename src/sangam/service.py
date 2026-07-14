from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from pathlib import PurePosixPath
from typing import Any

from sangam.config import Settings
from sangam.db import Database, utc_now
from sangam.errors import (
    ConflictError,
    IdempotencyError,
    MaterializationError,
    NotFoundError,
    ValidationError,
)
from sangam.schemas import (
    Document,
    Folder,
    ReconciliationConflict,
    ReconciliationReport,
    Revision,
    Tag,
)
from sangam.workspace import DiskWorkspaceFilesystem, WorkspaceFilesystem


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _request_hash(payload: dict[str, Any]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


class DocumentService:
    def __init__(
        self,
        settings: Settings,
        *,
        workspace: WorkspaceFilesystem | None = None,
    ) -> None:
        self.settings = settings
        self.settings.prepare()
        self.workspace = workspace or DiskWorkspaceFilesystem(settings.workspace_root)
        self.database = Database(settings.database_path)
        self.database.migrate()
        self._bootstrap_actors()
        self._rebuild_search_index()

    def _bootstrap_actors(self) -> None:
        actors = (
            ("human:jay", "Jay", "human"),
            ("client:cli", "Sangam CLI", "client"),
            ("system", "Sangam system", "system"),
            ("system:reconcile", "Filesystem reconciliation", "system"),
        )
        with self.database.transaction() as connection:
            for actor_id, display_name, actor_type in actors:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO actors(actor_id, display_name, actor_type, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (actor_id, display_name, actor_type, utc_now()),
                )

    def _ensure_actor(self, connection: sqlite3.Connection, actor_id: str) -> None:
        if not connection.execute(
            "SELECT 1 FROM actors WHERE actor_id = ?", (actor_id,)
        ).fetchone():
            raise ValidationError(f"Unknown actor: {actor_id}")

    def _normalize_path(self, raw_path: str) -> str:
        return self.workspace.normalize_document_path(raw_path)

    def _normalize_folder_path(self, raw_path: str) -> str:
        return self.workspace.normalize_folder_path(raw_path)

    def _document_query(self) -> str:
        return """
            SELECT d.*, r.content,
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
                ), '[]') AS tags_json
            FROM documents d
            JOIN revisions r ON r.revision_id = d.current_revision_id
        """

    def _document_from_row(self, row: sqlite3.Row) -> Document:
        return Document(
            document_id=row["document_id"],
            title=row["title"],
            content_type=row["content_type"],
            path=row["path"],
            current_revision_id=row["current_revision_id"],
            content=row["content"],
            content_hash=row["content_hash"],
            size_bytes=row["size_bytes"],
            materialization_state=row["materialization_state"],
            file_hash=row["file_hash"],
            deleted=bool(row["deleted"]),
            created_by=row["created_by"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            category=row["category"],
            metadata_version=row["metadata_version"],
            tags=[Tag.model_validate(tag) for tag in json.loads(row["tags_json"])],
        )

    def _ensure_folder_hierarchy(self, connection: sqlite3.Connection, document_path: str) -> None:
        parent = PurePosixPath(document_path).parent
        if parent == PurePosixPath("."):
            return
        now = utc_now()
        parts: list[str] = []
        for part in parent.parts:
            parts.append(part)
            folder_path = "/".join(parts)
            connection.execute(
                """
                INSERT OR IGNORE INTO folders(
                    folder_id, path, name, category, metadata_version, created_at, updated_at
                ) VALUES (?, ?, ?, NULL, 0, ?, ?)
                """,
                (str(uuid.uuid4()), folder_path, part, now, now),
            )

    def _sync_search_index(self, document_id: str) -> None:
        document = self.get_document(document_id, include_deleted=True)
        with self.database.transaction() as connection:
            connection.execute("DELETE FROM document_search WHERE document_id = ?", (document_id,))
            if not document.deleted:
                connection.execute(
                    """
                    INSERT INTO document_search(
                        document_id, title, path, content, tags, category
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        document.document_id,
                        document.title,
                        document.path or "",
                        document.content,
                        " ".join(tag.name for tag in document.tags),
                        document.category or "",
                    ),
                )

    def _rebuild_search_index(self) -> None:
        with self.database.transaction() as connection:
            connection.execute("DELETE FROM document_search")
        for document in self.list_documents(include_deleted=True):
            self._sync_search_index(document.document_id)

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

    def list_documents(self, *, include_deleted: bool = False) -> list[Document]:
        with self.database.connection() as connection:
            rows = connection.execute(
                self._document_query()
                + ("" if include_deleted else " WHERE d.deleted = 0")
                + " ORDER BY d.updated_at DESC, d.document_id"
            ).fetchall()
        return [self._document_from_row(row) for row in rows]

    def _idempotent_result(
        self,
        connection: sqlite3.Connection,
        *,
        actor_id: str,
        key: str,
        operation: str,
        request_hash: str,
    ) -> tuple[str, str] | None:
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
            self._finish_materialization(document_id)

    def create_document(
        self,
        *,
        title: str,
        content: str,
        path: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        normalized_path = self._normalize_path(path) if path is not None else None
        payload = {"title": title, "content": content, "path": normalized_path}
        fingerprint = _request_hash(payload)
        duplicate: tuple[str, str] | None = None
        try:
            with self.database.transaction() as connection:
                self._ensure_actor(connection, actor_id)
                duplicate = self._idempotent_result(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="create",
                    request_hash=fingerprint,
                )
                if duplicate is None:
                    now = utc_now()
                    document_id = str(uuid.uuid4())
                    revision_id = str(uuid.uuid4())
                    content_hash = _content_hash(content)
                    size_bytes = len(content.encode("utf-8"))
                    connection.execute(
                        """
                        INSERT INTO documents(
                            document_id, title, content_type, path, current_revision_id,
                            content_hash, size_bytes, materialization_state, file_hash,
                            deleted, created_by, created_at, updated_at
                        ) VALUES (?, ?, 'text/markdown', ?, NULL, ?, ?, ?, NULL, 0, ?, ?, ?)
                        """,
                        (
                            document_id,
                            title.strip(),
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
                        self._ensure_folder_hierarchy(connection, normalized_path)
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
        assert duplicate is not None
        self._finish_if_current(*duplicate)
        self._sync_search_index(duplicate[0])
        return self.get_document(duplicate[0], include_deleted=True)

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
        fingerprint = _request_hash(payload)
        old_path: str | None = None
        result: tuple[str, str] | None = None
        try:
            with self.database.transaction() as connection:
                self._ensure_actor(connection, actor_id)
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
                        self._ensure_folder_hierarchy(connection, next_path)
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
        assert result is not None
        self._finish_if_current(*result)
        current_result = self.get_document(document_id, include_deleted=True)
        if old_path and old_path != current_result.path:
            self.workspace.delete_document(old_path)
        if current_result.deleted and current_result.path:
            self.workspace.delete_document(current_result.path)
        self._sync_search_index(document_id)
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
        if not current.path:
            raise ValidationError("Unmaterialized documents must be materialized before moving")
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

    def delete_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
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

    def history(self, document_id: str) -> list[Revision]:
        self.get_document(document_id, include_deleted=True)
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM revisions
                WHERE document_id = ?
                ORDER BY created_at DESC, revision_id DESC
                """,
                (document_id,),
            ).fetchall()
        return [Revision.model_validate(dict(row)) for row in rows]

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

    def _finish_materialization(self, document_id: str) -> None:
        document = self.get_document(document_id, include_deleted=True)
        if document.deleted or not document.path:
            return
        try:
            file_hash = self.workspace.write_atomic(document.path, document.content)
        except Exception as error:
            raise MaterializationError(
                "The revision was committed, but its workspace file is still pending",
                details={
                    "document_id": document_id,
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
                (file_hash, document_id, document.current_revision_id),
            )

    def _record_conflict(
        self,
        *,
        conflict_type: str,
        document_id: str | None,
        path: str,
        candidate_path: str | None = None,
        expected_hash: str | None = None,
        actual_hash: str | None = None,
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO reconciliation_conflicts(
                    conflict_id, conflict_type, document_id, path, candidate_path,
                    expected_hash, actual_hash, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
                """,
                (
                    str(uuid.uuid4()),
                    conflict_type,
                    document_id,
                    path,
                    candidate_path,
                    expected_hash,
                    actual_hash,
                    utc_now(),
                ),
            )
            if document_id:
                connection.execute(
                    "UPDATE documents SET materialization_state = 'conflict' WHERE document_id = ?",
                    (document_id,),
                )

    def list_conflicts(self) -> list[ReconciliationConflict]:
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT * FROM reconciliation_conflicts
                WHERE status = 'open'
                ORDER BY created_at, conflict_id
                """
            ).fetchall()
        return [ReconciliationConflict.model_validate(dict(row)) for row in rows]

    def reconcile(self) -> ReconciliationReport:
        repaired: list[str] = []
        for document in self.list_documents():
            if document.path and document.materialization_state == "pending":
                self._finish_materialization(document.document_id)
                repaired.append(document.document_id)

        documents = [document for document in self.list_documents() if document.path]
        known_paths = {document.path for document in documents if document.path}
        disk_files = self.workspace.scan_markdown()

        missing = [document for document in documents if document.path not in disk_files]
        unknown_paths = [path for path in disk_files if path not in known_paths]
        candidate_paths: set[str] = set()
        for document in missing:
            matches = [path for path in unknown_paths if disk_files[path] == document.content_hash]
            if matches:
                for match in matches:
                    candidate_paths.add(match)
                self._record_conflict(
                    conflict_type="possible_move",
                    document_id=document.document_id,
                    path=document.path or "",
                    candidate_path=matches[0] if len(matches) == 1 else None,
                    expected_hash=document.content_hash,
                    actual_hash=document.content_hash,
                )
            else:
                self._finish_materialization(document.document_id)
                repaired.append(document.document_id)

        for document in documents:
            if not document.path or document.path not in disk_files:
                continue
            actual_hash = disk_files[document.path]
            if actual_hash != document.content_hash:
                self._record_conflict(
                    conflict_type="unexpected_hash",
                    document_id=document.document_id,
                    path=document.path,
                    expected_hash=document.content_hash,
                    actual_hash=actual_hash,
                )

        for path in unknown_paths:
            if path in candidate_paths:
                continue
            self._record_conflict(
                conflict_type="unknown_file",
                document_id=None,
                path=path,
                actual_hash=disk_files[path],
            )
        return ReconciliationReport(repaired_document_ids=repaired, conflicts=self.list_conflicts())

    def reindex_path(self, path: str) -> Document:
        normalized = self._normalize_path(path)
        if not self.workspace.is_document_file(normalized):
            raise NotFoundError(f"Workspace file not found: {normalized}")
        with self.database.connection() as connection:
            registered = connection.execute(
                "SELECT 1 FROM documents WHERE path = ?", (normalized,)
            ).fetchone()
            if registered:
                raise ValidationError("That path is already registered")
        content = self.workspace.read_document(normalized)
        fingerprint = _content_hash(content)
        document = self.create_document(
            title=self.workspace.title_from_path(normalized),
            content=content,
            path=normalized,
            actor_id="system:reconcile",
            idempotency_key=f"reindex:{normalized}:{fingerprint}",
        )
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE reconciliation_conflicts
                SET status = 'resolved', resolved_at = ?
                WHERE status = 'open' AND conflict_type = 'unknown_file' AND path = ?
                """,
                (utc_now(), normalized),
            )
        return document

    def accept_disk_content(self, conflict_id: str) -> Document:
        with self.database.connection() as connection:
            conflict = connection.execute(
                """
                SELECT * FROM reconciliation_conflicts
                WHERE conflict_id = ? AND status = 'open'
                """,
                (conflict_id,),
            ).fetchone()
        if (
            not conflict
            or conflict["conflict_type"] != "unexpected_hash"
            or not conflict["document_id"]
        ):
            raise NotFoundError("Open unexpected-hash conflict not found")
        document = self.get_document(conflict["document_id"])
        content = self.workspace.read_document(conflict["path"])
        result, _ = self._append_revision(
            document_id=document.document_id,
            expected_revision_id=document.current_revision_id,
            content=content,
            title=None,
            path=None,
            operation="reconcile",
            summary="Accepted out-of-band workspace content",
            actor_id="system:reconcile",
            idempotency_key=f"accept-disk:{conflict_id}:{_content_hash(content)}",
        )
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE reconciliation_conflicts
                SET status = 'resolved', resolved_at = ?
                WHERE conflict_id = ?
                """,
                (utc_now(), conflict_id),
            )
        return result

    def _validate_tag_ids(self, connection: sqlite3.Connection, tag_ids: list[str]) -> list[str]:
        unique_ids = list(dict.fromkeys(tag_ids))
        if not unique_ids:
            return []
        placeholders = ",".join("?" for _ in unique_ids)
        rows = connection.execute(
            f"SELECT tag_id FROM tags WHERE tag_id IN ({placeholders})", unique_ids
        ).fetchall()
        found = {row["tag_id"] for row in rows}
        missing = [tag_id for tag_id in unique_ids if tag_id not in found]
        if missing:
            raise ValidationError("One or more tags do not exist", details={"tag_ids": missing})
        return unique_ids

    def list_tags(self) -> list[Tag]:
        with self.database.connection() as connection:
            rows = connection.execute("SELECT * FROM tags ORDER BY name COLLATE NOCASE").fetchall()
        return [Tag.model_validate(dict(row)) for row in rows]

    def create_tag(self, *, name: str, color: str, actor_id: str) -> Tag:
        normalized_name = " ".join(name.strip().split())
        if not normalized_name:
            raise ValidationError("Tag name cannot be blank")
        with self.database.transaction() as connection:
            self._ensure_actor(connection, actor_id)
            existing = connection.execute(
                "SELECT * FROM tags WHERE name = ? COLLATE NOCASE", (normalized_name,)
            ).fetchone()
            if existing:
                return Tag.model_validate(dict(existing))
            now = utc_now()
            tag_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO tags(tag_id, name, color, created_at) VALUES (?, ?, ?, ?)",
                (tag_id, normalized_name, color.lower(), now),
            )
            after = {
                "tag_id": tag_id,
                "name": normalized_name,
                "color": color.lower(),
                "created_at": now,
            }
            connection.execute(
                """
                INSERT INTO metadata_events(
                    event_id, entity_type, entity_id, actor_id,
                    operation, before_json, after_json, created_at
                ) VALUES (?, 'tag', ?, ?, 'create', NULL, ?, ?)
                """,
                (str(uuid.uuid4()), tag_id, actor_id, json.dumps(after), now),
            )
        return Tag.model_validate(after)

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
        normalized_category = category.strip() if category and category.strip() else None
        payload = {
            "document_id": document_id,
            "expected_metadata_version": expected_metadata_version,
            "category": normalized_category,
            "tag_ids": sorted(set(tag_ids)),
        }
        fingerprint = _request_hash(payload)
        with self.database.transaction() as connection:
            self._ensure_actor(connection, actor_id)
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
                valid_tag_ids = self._validate_tag_ids(connection, tag_ids)
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
        self._sync_search_index(document_id)
        return self.get_document(document_id)

    def search_documents(
        self,
        *,
        query: str = "",
        tag_id: str | None = None,
        category: str | None = None,
    ) -> list[Document]:
        terms = re.findall(r"[\w-]+", query, flags=re.UNICODE)
        if terms:
            expression = " AND ".join(f'"{term}"*' for term in terms)
            with self.database.connection() as connection:
                rows = connection.execute(
                    """
                    SELECT document_id FROM document_search
                    WHERE document_search MATCH ?
                    ORDER BY bm25(document_search)
                    """,
                    (expression,),
                ).fetchall()
            documents = [self.get_document(row["document_id"]) for row in rows]
        else:
            documents = self.list_documents()
        normalized_category = category.casefold() if category else None
        return [
            document
            for document in documents
            if (not tag_id or any(tag.tag_id == tag_id for tag in document.tags))
            and (
                not normalized_category
                or (document.category or "").casefold() == normalized_category
            )
        ]

    def _folder_from_row(self, connection: sqlite3.Connection, row: sqlite3.Row) -> Folder:
        tag_rows = connection.execute(
            """
            SELECT t.* FROM tags t
            JOIN folder_tags ft ON ft.tag_id = t.tag_id
            WHERE ft.folder_id = ?
            ORDER BY t.name COLLATE NOCASE
            """,
            (row["folder_id"],),
        ).fetchall()
        count = connection.execute(
            """
            SELECT count(*) FROM documents
            WHERE deleted = 0 AND path LIKE ?
            """,
            (f"{row['path']}/%",),
        ).fetchone()[0]
        return Folder(
            folder_id=row["folder_id"],
            path=row["path"],
            name=row["name"],
            category=row["category"],
            metadata_version=row["metadata_version"],
            tags=[Tag.model_validate(dict(tag_row)) for tag_row in tag_rows],
            document_count=count,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def list_folders(self) -> list[Folder]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM folders ORDER BY path COLLATE NOCASE"
            ).fetchall()
            return [self._folder_from_row(connection, row) for row in rows]

    def create_folder(
        self,
        *,
        path: str,
        category: str | None,
        tag_ids: list[str],
        actor_id: str,
    ) -> Folder:
        normalized_path = self._normalize_folder_path(path)
        normalized_category = category.strip() if category and category.strip() else None
        target_id: str
        with self.database.transaction() as connection:
            self._ensure_actor(connection, actor_id)
            valid_tag_ids = self._validate_tag_ids(connection, tag_ids)
            self._ensure_folder_hierarchy(connection, f"{normalized_path}/.placeholder.md")
            row = connection.execute(
                "SELECT * FROM folders WHERE path = ?", (normalized_path,)
            ).fetchone()
            assert row is not None
            target_id = row["folder_id"]
            before = {
                "category": row["category"],
                "tag_ids": [],
                "metadata_version": row["metadata_version"],
            }
            now = utc_now()
            connection.execute(
                """
                UPDATE folders
                SET category = ?, metadata_version = metadata_version + 1, updated_at = ?
                WHERE folder_id = ?
                """,
                (normalized_category, now, target_id),
            )
            connection.execute("DELETE FROM folder_tags WHERE folder_id = ?", (target_id,))
            connection.executemany(
                "INSERT INTO folder_tags(folder_id, tag_id) VALUES (?, ?)",
                [(target_id, tag_id) for tag_id in valid_tag_ids],
            )
            after = {
                "path": normalized_path,
                "category": normalized_category,
                "tag_ids": valid_tag_ids,
                "metadata_version": row["metadata_version"] + 1,
            }
            connection.execute(
                """
                INSERT INTO metadata_events(
                    event_id, entity_type, entity_id, actor_id,
                    operation, before_json, after_json, created_at
                ) VALUES (?, 'folder', ?, ?, 'create_or_organize', ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    target_id,
                    actor_id,
                    json.dumps(before),
                    json.dumps(after),
                    now,
                ),
            )
        self.workspace.create_folder(normalized_path)
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM folders WHERE folder_id = ?", (target_id,)
            ).fetchone()
            assert row is not None
            return self._folder_from_row(connection, row)

    def update_folder_metadata(
        self,
        *,
        folder_id: str,
        expected_metadata_version: int,
        category: str | None,
        tag_ids: list[str],
        actor_id: str,
    ) -> Folder:
        normalized_category = category.strip() if category and category.strip() else None
        with self.database.transaction() as connection:
            self._ensure_actor(connection, actor_id)
            row = connection.execute(
                "SELECT * FROM folders WHERE folder_id = ?", (folder_id,)
            ).fetchone()
            if not row:
                raise NotFoundError(f"Folder not found: {folder_id}")
            if row["metadata_version"] != expected_metadata_version:
                raise ConflictError(
                    "Folder metadata changed since it was read",
                    details={
                        "folder_id": folder_id,
                        "expected_metadata_version": expected_metadata_version,
                        "current_metadata_version": row["metadata_version"],
                    },
                )
            valid_tag_ids = self._validate_tag_ids(connection, tag_ids)
            current_tags = connection.execute(
                "SELECT tag_id FROM folder_tags WHERE folder_id = ?", (folder_id,)
            ).fetchall()
            before = {
                "category": row["category"],
                "tag_ids": [tag["tag_id"] for tag in current_tags],
                "metadata_version": row["metadata_version"],
            }
            now = utc_now()
            connection.execute(
                """
                UPDATE folders
                SET category = ?, metadata_version = metadata_version + 1, updated_at = ?
                WHERE folder_id = ?
                """,
                (normalized_category, now, folder_id),
            )
            connection.execute("DELETE FROM folder_tags WHERE folder_id = ?", (folder_id,))
            connection.executemany(
                "INSERT INTO folder_tags(folder_id, tag_id) VALUES (?, ?)",
                [(folder_id, tag_id) for tag_id in valid_tag_ids],
            )
            after = {
                "category": normalized_category,
                "tag_ids": valid_tag_ids,
                "metadata_version": row["metadata_version"] + 1,
            }
            connection.execute(
                """
                INSERT INTO metadata_events(
                    event_id, entity_type, entity_id, actor_id,
                    operation, before_json, after_json, created_at
                ) VALUES (?, 'folder', ?, ?, 'organize', ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    folder_id,
                    actor_id,
                    json.dumps(before),
                    json.dumps(after),
                    now,
                ),
            )
        with self.database.connection() as connection:
            updated = connection.execute(
                "SELECT * FROM folders WHERE folder_id = ?", (folder_id,)
            ).fetchone()
            assert updated is not None
            return self._folder_from_row(connection, updated)
