from __future__ import annotations

import hashlib
import sqlite3
import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from sangam.db import Database, utc_now
from sangam.errors import NotFoundError, ValidationError
from sangam.schemas import Document, ReconciliationConflict, ReconciliationReport
from sangam.workspace import WorkspaceFilesystem


@dataclass(frozen=True)
class MaterializedDocumentSnapshot:
    document_id: str
    path: str
    content_hash: str
    recoverable_from_database: bool = True


@dataclass(frozen=True)
class PlannedConflict:
    conflict_type: Literal["unexpected_hash", "possible_move", "unknown_file"]
    document_id: str | None
    path: str
    candidate_path: str | None = None
    expected_hash: str | None = None
    actual_hash: str | None = None


@dataclass(frozen=True)
class ReconciliationPlan:
    rematerialize_document_ids: tuple[str, ...]
    conflicts: tuple[PlannedConflict, ...]


class ReconciliationPlanner:
    def plan(
        self,
        documents: Sequence[MaterializedDocumentSnapshot],
        disk_files: Mapping[str, str],
    ) -> ReconciliationPlan:
        known_paths = {document.path for document in documents}
        unknown_paths = sorted(path for path in disk_files if path not in known_paths)
        missing = [document for document in documents if document.path not in disk_files]

        unknown_paths_by_hash: dict[str, list[str]] = defaultdict(list)
        for path in unknown_paths:
            unknown_paths_by_hash[disk_files[path]].append(path)

        missing_documents_by_hash: dict[str, list[MaterializedDocumentSnapshot]] = defaultdict(list)
        for document in missing:
            missing_documents_by_hash[document.content_hash].append(document)

        rematerialize: list[str] = []
        conflicts: list[PlannedConflict] = []
        move_candidate_paths: set[str] = set()
        for document in missing:
            matches = unknown_paths_by_hash.get(document.content_hash, [])
            if not matches:
                if document.recoverable_from_database:
                    rematerialize.append(document.document_id)
                else:
                    conflicts.append(
                        PlannedConflict(
                            conflict_type="unexpected_hash",
                            document_id=document.document_id,
                            path=document.path,
                            expected_hash=document.content_hash,
                        )
                    )
                continue
            move_candidate_paths.update(matches)
            unambiguous = (
                len(matches) == 1 and len(missing_documents_by_hash[document.content_hash]) == 1
            )
            conflicts.append(
                PlannedConflict(
                    conflict_type="possible_move",
                    document_id=document.document_id,
                    path=document.path,
                    candidate_path=matches[0] if unambiguous else None,
                    expected_hash=document.content_hash,
                    actual_hash=document.content_hash,
                )
            )

        for document in documents:
            actual_hash = disk_files.get(document.path)
            if actual_hash is not None and actual_hash != document.content_hash:
                conflicts.append(
                    PlannedConflict(
                        conflict_type="unexpected_hash",
                        document_id=document.document_id,
                        path=document.path,
                        expected_hash=document.content_hash,
                        actual_hash=actual_hash,
                    )
                )

        for path in unknown_paths:
            if path not in move_candidate_paths:
                conflicts.append(
                    PlannedConflict(
                        conflict_type="unknown_file",
                        document_id=None,
                        path=path,
                        actual_hash=disk_files[path],
                    )
                )

        return ReconciliationPlan(
            rematerialize_document_ids=tuple(rematerialize),
            conflicts=tuple(conflicts),
        )


class ReconciliationDocumentPort(Protocol):
    """Document lifecycle operations reconciliation is allowed to invoke."""

    def list_documents(self, *, include_deleted: bool = False) -> list[Document]: ...

    def get_document(self, document_id: str, *, include_deleted: bool = False) -> Document: ...

    def create_document(
        self,
        *,
        title: str,
        content: str,
        path: str | None,
        content_type: str = "text/markdown",
        actor_id: str,
        idempotency_key: str,
    ) -> Document: ...

    def reconcile_content(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        content: str,
        summary: str,
        idempotency_key: str,
    ) -> Document: ...

    def move_document(
        self,
        *,
        document_id: str,
        expected_revision_id: str,
        path: str,
        summary: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> Document: ...

    def rematerialize_document(self, document_id: str) -> Document: ...


class ReconciliationService:
    """Owns workspace conflict detection, persistence, and resolution workflows."""

    def __init__(
        self,
        *,
        database: Database,
        workspace: WorkspaceFilesystem,
        documents: ReconciliationDocumentPort,
        planner: ReconciliationPlanner,
    ) -> None:
        self.database = database
        self.workspace = workspace
        self.documents = documents
        self.planner = planner

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

    def scan(self) -> ReconciliationReport:
        repaired = self._recover_pending_materializations()
        documents = [document for document in self.documents.list_documents() if document.path]
        snapshots = [
            MaterializedDocumentSnapshot(
                document_id=document.document_id,
                path=document.path,
                content_hash=document.content_hash,
                recoverable_from_database=document.content_type != "application/pdf",
            )
            for document in documents
            if document.path is not None
        ]
        disk_state = self.workspace.scan_documents()
        self._remove_ignored_files(disk_state)
        plan = self.planner.plan(snapshots, disk_state)
        for document_id in plan.rematerialize_document_ids:
            self.documents.rematerialize_document(document_id)
            repaired.append(document_id)
        self._synchronize_conflicts(plan.conflicts, disk_state)
        return ReconciliationReport(repaired_document_ids=repaired, conflicts=self.list_conflicts())

    def reindex_path(self, path: str) -> Document:
        normalized = self.workspace.normalize_document_path(path)
        if not self.workspace.is_document_file(normalized):
            raise NotFoundError(f"Workspace file not found: {normalized}")
        if normalized.lower().endswith(".pdf"):
            raise ValidationError("Use the PDF import endpoint for unknown PDF files")
        content = self.workspace.read_document(normalized)
        fingerprint = _content_hash(content)
        document = self.documents.create_document(
            title=self.workspace.title_from_path(normalized),
            content=content,
            path=normalized,
            content_type=(
                "text/html" if normalized.lower().endswith((".html", ".htm")) else "text/markdown"
            ),
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
        conflict = self._get_open_conflict(conflict_id, "unexpected_hash")
        if not conflict["document_id"]:
            raise NotFoundError("Open unexpected-hash conflict not found")
        document = self.documents.get_document(conflict["document_id"])
        if document.content_type == "application/pdf":
            raise ValidationError(
                "Changed PDF bytes must be imported as a replacement, never accepted in place"
            )
        content = self.workspace.read_document(conflict["path"])
        fingerprint = _content_hash(content)
        if document.content_hash == fingerprint:
            self._resolve_conflict(conflict_id)
            return document
        result = self.documents.reconcile_content(
            document_id=document.document_id,
            expected_revision_id=document.current_revision_id,
            content=content,
            summary="Accepted out-of-band workspace content",
            idempotency_key=f"accept-disk:{conflict_id}:{fingerprint}",
        )
        self._resolve_conflict(conflict_id)
        return result

    def restore_database_content(self, conflict_id: str) -> Document:
        conflict = self._get_open_conflict(conflict_id, "unexpected_hash")
        if not conflict["document_id"]:
            raise NotFoundError("Open unexpected-hash conflict not found")
        document = self.documents.rematerialize_document(conflict["document_id"])
        self._resolve_conflict(conflict_id)
        return document

    def recognize_move(self, conflict_id: str) -> Document:
        conflict = self._get_open_conflict(conflict_id, "possible_move")
        if not conflict["document_id"] or not conflict["candidate_path"]:
            raise NotFoundError("Open unambiguous move conflict not found")
        document = self.documents.get_document(conflict["document_id"])
        if document.path == conflict["candidate_path"]:
            self._resolve_conflict(conflict_id)
            return document
        moved = self.documents.move_document(
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
            self._resolve_conflict_in_connection(connection, conflict_id)
        return ReconciliationReport(repaired_document_ids=[], conflicts=self.list_conflicts())

    def _recover_pending_materializations(self) -> list[str]:
        repaired: list[str] = []
        for document in self.documents.list_documents():
            if document.path and document.materialization_state == "pending":
                if document.content_type == "application/pdf":
                    continue
                self.documents.rematerialize_document(document.document_id)
                repaired.append(document.document_id)
        return repaired

    def _remove_ignored_files(self, disk_state: dict[str, str]) -> None:
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

    def _synchronize_conflicts(
        self, conflicts: Sequence[PlannedConflict], disk_state: Mapping[str, str]
    ) -> None:
        """Make persisted open conflicts match the latest complete workspace scan."""
        planned = {self._planned_conflict_key(conflict): conflict for conflict in conflicts}
        now = utc_now()
        with self.database.transaction() as connection:
            open_rows = connection.execute(
                "SELECT * FROM reconciliation_conflicts WHERE status = 'open'"
            ).fetchall()
            existing = {self._stored_conflict_key(row): row for row in open_rows}
            affected_document_ids = {
                row["document_id"] for row in open_rows if row["document_id"] is not None
            }
            affected_document_ids.update(
                conflict.document_id for conflict in conflicts if conflict.document_id is not None
            )

            stale_ids = [row["conflict_id"] for key, row in existing.items() if key not in planned]
            if stale_ids:
                connection.executemany(
                    """
                    UPDATE reconciliation_conflicts
                    SET status = 'resolved', resolved_at = ?
                    WHERE conflict_id = ? AND status = 'open'
                    """,
                    [(now, conflict_id) for conflict_id in stale_ids],
                )

            for key, conflict in planned.items():
                current = existing.get(key)
                if current is None:
                    connection.execute(
                        """
                        INSERT INTO reconciliation_conflicts(
                            conflict_id, conflict_type, document_id, path, candidate_path,
                            expected_hash, actual_hash, status, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
                        """,
                        (
                            str(uuid.uuid4()),
                            conflict.conflict_type,
                            conflict.document_id,
                            conflict.path,
                            conflict.candidate_path,
                            conflict.expected_hash,
                            conflict.actual_hash,
                            now,
                        ),
                    )
                else:
                    connection.execute(
                        """
                        UPDATE reconciliation_conflicts
                        SET expected_hash = ?, actual_hash = ?
                        WHERE conflict_id = ?
                        """,
                        (conflict.expected_hash, conflict.actual_hash, current["conflict_id"]),
                    )
                if conflict.document_id:
                    connection.execute(
                        """
                        UPDATE documents SET materialization_state = 'conflict'
                        WHERE document_id = ?
                        """,
                        (conflict.document_id,),
                    )

            for document_id in affected_document_ids:
                row = connection.execute(
                    """
                    SELECT path, content_hash, deleted FROM documents WHERE document_id = ?
                    """,
                    (document_id,),
                ).fetchone()
                if (
                    row is not None
                    and not row["deleted"]
                    and row["path"] is not None
                    and disk_state.get(row["path"]) == row["content_hash"]
                    and connection.execute(
                        """
                        SELECT 1 FROM reconciliation_conflicts
                        WHERE document_id = ? AND status = 'open'
                        """,
                        (document_id,),
                    ).fetchone()
                    is None
                ):
                    connection.execute(
                        """
                        UPDATE documents
                        SET materialization_state = 'clean', file_hash = content_hash
                        WHERE document_id = ?
                        """,
                        (document_id,),
                    )

    @staticmethod
    def _planned_conflict_key(conflict: PlannedConflict) -> tuple[str, str, str, str]:
        return (
            conflict.conflict_type,
            conflict.document_id or "",
            conflict.path,
            conflict.candidate_path or "",
        )

    @staticmethod
    def _stored_conflict_key(conflict: sqlite3.Row) -> tuple[str, str, str, str]:
        return (
            conflict["conflict_type"],
            conflict["document_id"] or "",
            conflict["path"],
            conflict["candidate_path"] or "",
        )

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
            self._resolve_conflict_in_connection(connection, conflict_id)

    @staticmethod
    def _resolve_conflict_in_connection(connection: sqlite3.Connection, conflict_id: str) -> None:
        connection.execute(
            """
            UPDATE reconciliation_conflicts
            SET status = 'resolved', resolved_at = ?
            WHERE conflict_id = ?
            """,
            (utc_now(), conflict_id),
        )


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()
