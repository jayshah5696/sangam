from __future__ import annotations

import difflib
import hashlib
import json
import sqlite3
import uuid

from sangam.backup import BackupManager
from sangam.config import Settings
from sangam.db import Database, utc_now
from sangam.errors import (
    ConflictError,
    IdempotencyError,
    MaterializationError,
    NotFoundError,
    ValidationError,
)
from sangam.idempotency import IdempotencyStore, request_hash
from sangam.organization import WorkspaceOrganizationService
from sangam.reconciliation import MaterializedDocumentSnapshot, ReconciliationPlanner
from sangam.schemas import (
    BackupSet,
    BackupVerification,
    Document,
    Folder,
    ReconciliationConflict,
    ReconciliationReport,
    Revision,
    RevisionDiff,
    Tag,
)
from sangam.search import SearchIndex
from sangam.workspace import DiskWorkspaceFilesystem, WorkspaceFilesystem


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


class DocumentService:
    def __init__(
        self,
        settings: Settings,
        *,
        workspace: WorkspaceFilesystem | None = None,
        reconciliation_planner: ReconciliationPlanner | None = None,
    ) -> None:
        self.settings = settings
        self.settings.prepare()
        self.workspace = workspace or DiskWorkspaceFilesystem(settings.workspace_root)
        self.reconciliation_planner = reconciliation_planner or ReconciliationPlanner()
        self.database = Database(settings.database_path)
        self.database.initialize()
        self._bootstrap_actors()
        self.idempotency = IdempotencyStore(self.database)
        self.organization = WorkspaceOrganizationService(
            database=self.database,
            workspace=self.workspace,
            idempotency=self.idempotency,
        )
        self.search_index = SearchIndex(self.database)
        self.search_index.rebuild(self.list_documents(include_deleted=True))
        self.backups = BackupManager(
            database=self.database,
            workspace_root=settings.workspace_root,
            backup_root=settings.backup_root,
            retention_count=settings.backup_retention_count,
        )

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
        return self.organization.normalize_folder_path(raw_path)

    def _document_query(self) -> str:
        return """
            SELECT d.*, r.content, r.actor_id AS updated_by,
                r.summary AS revision_summary, a.display_name AS updated_by_name,
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
            JOIN actors a ON a.actor_id = r.actor_id
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
            updated_by=row["updated_by"],
            updated_by_name=row["updated_by_name"],
            revision_summary=row["revision_summary"],
            category=row["category"],
            metadata_version=row["metadata_version"],
            tags=[Tag.model_validate(tag) for tag in json.loads(row["tags_json"])],
        )

    def _ensure_folder_hierarchy(self, connection: sqlite3.Connection, document_path: str) -> None:
        self.organization.ensure_document_folder_hierarchy(connection, document_path)

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

    def _get_documents_by_ids(self, document_ids: list[str]) -> list[Document]:
        if not document_ids:
            return []
        placeholders = ",".join("?" for _ in document_ids)
        with self.database.connection() as connection:
            rows = connection.execute(
                self._document_query()
                + f" WHERE d.deleted = 0 AND d.document_id IN ({placeholders})",
                document_ids,
            ).fetchall()
        documents = {row["document_id"]: self._document_from_row(row) for row in rows}
        return [documents[document_id] for document_id in document_ids if document_id in documents]

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
        actor_id: str,
        idempotency_key: str,
    ) -> Document:
        normalized_path = self._normalize_path(path) if path is not None else None
        payload = {"title": title, "content": content, "path": normalized_path}
        fingerprint = request_hash(payload)
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
        return self.create_document(
            title=title or f"{source.title} copy",
            content=source.content,
            path=path,
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

    def revision_diff(
        self, *, document_id: str, from_revision_id: str, to_revision_id: str | None
    ) -> RevisionDiff:
        document = self.get_document(document_id, include_deleted=True)
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
        repaired = self._recover_pending_materializations()

        documents = [document for document in self.list_documents() if document.path]
        documents_by_id = {document.document_id: document for document in documents}
        snapshots = [
            MaterializedDocumentSnapshot(
                document_id=document.document_id,
                path=document.path,
                content_hash=document.content_hash,
            )
            for document in documents
            if document.path is not None
        ]
        disk_state = self.workspace.scan_markdown()
        with self.database.transaction() as connection:
            ignored_rows = connection.execute(
                "SELECT path, content_hash FROM ignored_workspace_files"
            ).fetchall()
            for ignored in ignored_rows:
                if disk_state.get(ignored["path"]) == ignored["content_hash"]:
                    disk_state.pop(ignored["path"], None)
                else:
                    connection.execute(
                        "DELETE FROM ignored_workspace_files WHERE path = ?", (ignored["path"],)
                    )
        plan = self.reconciliation_planner.plan(snapshots, disk_state)
        for document_id in plan.rematerialize_document_ids:
            self._finish_materialization(documents_by_id[document_id])
            repaired.append(document_id)
        for conflict in plan.conflicts:
            self._record_conflict(
                conflict_type=conflict.conflict_type,
                document_id=conflict.document_id,
                path=conflict.path,
                candidate_path=conflict.candidate_path,
                expected_hash=conflict.expected_hash,
                actual_hash=conflict.actual_hash,
            )
        return ReconciliationReport(repaired_document_ids=repaired, conflicts=self.list_conflicts())

    def _recover_pending_materializations(self) -> list[str]:
        repaired: list[str] = []
        for document in self.list_documents():
            if document.path and document.materialization_state == "pending":
                self._finish_materialization(document)
                repaired.append(document.document_id)
        return repaired

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

    def restore_database_content(self, conflict_id: str) -> Document:
        conflict = self._get_open_conflict(conflict_id, "unexpected_hash")
        if not conflict["document_id"]:
            raise NotFoundError("Open unexpected-hash conflict not found")
        document = self.get_document(conflict["document_id"])
        self._finish_materialization(document)
        self._resolve_conflict(conflict_id)
        return self.get_document(document.document_id)

    def recognize_move(self, conflict_id: str) -> Document:
        conflict = self._get_open_conflict(conflict_id, "possible_move")
        if not conflict["document_id"] or not conflict["candidate_path"]:
            raise NotFoundError("Open unambiguous move conflict not found")
        document = self.get_document(conflict["document_id"])
        moved = self.move_document(
            document_id=document.document_id,
            expected_revision_id=document.current_revision_id,
            path=conflict["candidate_path"],
            summary="Recognized out-of-band workspace move",
            actor_id="system:reconcile",
            idempotency_key=f"recognize-move:{conflict_id}",
        )
        self._resolve_conflict(conflict_id)
        return moved

    def ignore_unknown_file(self, conflict_id: str) -> ReconciliationReport:
        conflict = self._get_open_conflict(conflict_id, "unknown_file")
        actual_hash = conflict["actual_hash"]
        if not actual_hash:
            raise ValidationError("Unknown file conflict is missing its content hash")
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO ignored_workspace_files(path, content_hash, ignored_at)
                VALUES (?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                    content_hash = excluded.content_hash,
                    ignored_at = excluded.ignored_at
                """,
                (conflict["path"], actual_hash, utc_now()),
            )
        self._resolve_conflict(conflict_id)
        return ReconciliationReport(repaired_document_ids=[], conflicts=self.list_conflicts())

    def _get_open_conflict(self, conflict_id: str, expected_type: str) -> sqlite3.Row:
        with self.database.connection() as connection:
            conflict = connection.execute(
                "SELECT * FROM reconciliation_conflicts WHERE conflict_id = ? AND status = 'open'",
                (conflict_id,),
            ).fetchone()
        if not conflict or conflict["conflict_type"] != expected_type:
            raise NotFoundError(f"Open {expected_type} conflict not found")
        return conflict

    def _resolve_conflict(self, conflict_id: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE reconciliation_conflicts
                SET status = 'resolved', resolved_at = ?
                WHERE conflict_id = ?
                """,
                (utc_now(), conflict_id),
            )

    def _validate_tag_ids(self, connection: sqlite3.Connection, tag_ids: list[str]) -> list[str]:
        return self.organization.validate_tag_ids(connection, tag_ids)

    def list_tags(self) -> list[Tag]:
        return self.organization.list_tags()

    def create_tag(self, *, name: str, color: str, actor_id: str, idempotency_key: str) -> Tag:
        return self.organization.create_tag(
            name=name,
            color=color,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

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
        fingerprint = request_hash(payload)
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
    ) -> list[Document]:
        matches = self.search_index.search(query)
        documents = (
            self.list_documents()
            if matches is None
            else self._get_documents_by_ids([match.document_id for match in matches])
        )
        snippets = (
            {} if matches is None else {match.document_id: match.snippet for match in matches}
        )
        normalized_category = category.casefold() if category else None
        actor_document_ids = self._document_ids_for_actor(actor_id) if actor_id else None
        filtered = [
            document
            for document in documents
            if (not tag_id or any(tag.tag_id == tag_id for tag in document.tags))
            and (
                not normalized_category
                or (document.category or "").casefold() == normalized_category
            )
            and (actor_document_ids is None or document.document_id in actor_document_ids)
        ]
        if sort == "title":
            filtered.sort(key=lambda item: (item.title.casefold(), item.document_id))
        elif sort == "path":
            filtered.sort(key=lambda item: ((item.path or "").casefold(), item.document_id))
        elif sort == "updated":
            filtered.sort(key=lambda item: (item.updated_at, item.document_id), reverse=True)
        elif sort != "relevance":
            raise ValidationError(f"Unsupported search sort: {sort}")
        return [
            document.model_copy(update={"search_snippet": snippets.get(document.document_id)})
            for document in filtered
        ]

    def _document_ids_for_actor(self, actor_id: str) -> set[str]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT DISTINCT document_id FROM revisions WHERE actor_id = ?", (actor_id,)
            ).fetchall()
        return {row["document_id"] for row in rows}

    def rebuild_search_index(self) -> int:
        documents = self.list_documents(include_deleted=True)
        self.search_index.rebuild(documents)
        return sum(not document.deleted for document in documents)

    def list_backups(self) -> list[BackupSet]:
        return self.backups.list()

    def create_backup(self, *, actor_id: str, idempotency_key: str) -> BackupSet:
        fingerprint = request_hash({"operation": "create_backup"})
        with self.database.transaction() as connection:
            self._ensure_actor(connection, actor_id)
            duplicate = self.idempotency.mutation_record(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="create_backup",
                request_hash=fingerprint,
            )
            if duplicate:
                backup_id = duplicate.resource_id
                completed = duplicate.completed_at is not None
            else:
                backup_id = self.backups.new_backup_id()
                completed = False
                self.idempotency.record_mutation(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="create_backup",
                    request_hash=fingerprint,
                    resource_type="backup",
                    resource_id=backup_id,
                    completed=False,
                )
        try:
            backup = self.backups.get(backup_id)
        except NotFoundError:
            if completed:
                raise NotFoundError("Idempotent backup result is no longer retained") from None
            backup = self.backups.create(backup_id=backup_id)
        if backup.verified_at is None:
            self.backups.verify(backup_id)
            backup = self.backups.get(backup_id)
        if not completed:
            self.idempotency.complete_mutation(
                actor_id=actor_id, key=idempotency_key, resource_id=backup_id
            )
        return backup

    def verify_backup(self, backup_id: str) -> BackupVerification:
        return self.backups.verify(backup_id)

    def list_folders(self) -> list[Folder]:
        return self.organization.list_folders()

    def create_folder(
        self,
        *,
        path: str,
        category: str | None,
        tag_ids: list[str],
        actor_id: str,
        idempotency_key: str,
    ) -> Folder:
        return self.organization.create_folder(
            path=path,
            category=category,
            tag_ids=tag_ids,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    def update_folder_metadata(
        self,
        *,
        folder_id: str,
        expected_metadata_version: int,
        category: str | None,
        tag_ids: list[str],
        actor_id: str,
        idempotency_key: str,
    ) -> Folder:
        return self.organization.update_folder_metadata(
            folder_id=folder_id,
            expected_metadata_version=expected_metadata_version,
            category=category,
            tag_ids=tag_ids,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )
