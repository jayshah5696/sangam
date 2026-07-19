from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass

from sangam.db import Database, utc_now
from sangam.errors import ConflictError, IntegrationError, NotFoundError, ValidationError
from sangam.karakeep_extraction import NormalizedSnapshot
from sangam.schemas import KarakeepAsset, KarakeepImport, KarakeepImportDetail

KARAKEEP_ACTOR_ID = "integration:karakeep"


@dataclass(frozen=True)
class ImportReservation:
    import_id: str
    bookmark_id: str
    document_id: str | None


@dataclass(frozen=True)
class StoredSnapshot:
    snapshot_id: str
    title: str
    tags: tuple[str, ...]
    extracted_markdown: str
    content_hash: str


class KarakeepRepository:
    """Own the durable import state machine and its SQL representation."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def recover_interrupted_imports(self) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = 'failed', last_error = ?, updated_at = ?
                WHERE status = 'importing'
                """,
                ("Import interrupted by a process restart; retry it explicitly.", utc_now()),
            )

    def imported_states(self) -> dict[str, tuple[str | None, str]]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT bookmark_id, document_id, status FROM karakeep_imports"
            ).fetchall()
        return {row["bookmark_id"]: (row["document_id"], row["status"]) for row in rows}

    def list_imports(self) -> list[KarakeepImport]:
        with self.database.connection() as connection:
            rows = connection.execute(
                self._import_query() + " ORDER BY i.updated_at DESC, i.import_id"
            ).fetchall()
        return [self._import_from_row(row) for row in rows]

    def get_import(self, import_id: str) -> KarakeepImportDetail:
        with self.database.connection() as connection:
            row = connection.execute(
                self._import_query() + " WHERE i.import_id = ?", (import_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Karakeep import not found: {import_id}")
        return self._detail_from_row(row)

    def get_document_import(self, document_id: str) -> KarakeepImportDetail:
        with self.database.connection() as connection:
            row = connection.execute(
                self._import_query() + " WHERE i.document_id = ?", (document_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Karakeep import not found for document: {document_id}")
        return self._detail_from_row(row)

    def find_by_bookmark(self, bookmark_id: str) -> KarakeepImport | None:
        with self.database.connection() as connection:
            row = connection.execute(
                self._import_query() + " WHERE i.bookmark_id = ?", (bookmark_id,)
            ).fetchone()
        return self._import_from_row(row) if row else None

    def reserve(self, bookmark_id: str) -> ImportReservation:
        now = utc_now()
        candidate_id = str(uuid.uuid4())
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO karakeep_imports(
                    import_id, bookmark_id, document_id, status, last_error,
                    last_attempt_at, created_at, updated_at
                ) VALUES (?, ?, NULL, 'failed', NULL, ?, ?, ?)
                """,
                (candidate_id, bookmark_id, now, now, now),
            )
            row = connection.execute(
                """
                SELECT import_id, bookmark_id, document_id, status
                FROM karakeep_imports WHERE bookmark_id = ?
                """,
                (bookmark_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError("Karakeep import reservation could not be loaded")
            if row["status"] == "importing":
                raise ConflictError("This Karakeep bookmark is already being imported")
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = 'importing', last_error = NULL, last_attempt_at = ?, updated_at = ?
                WHERE import_id = ?
                """,
                (now, now, row["import_id"]),
            )
            return ImportReservation(
                import_id=row["import_id"],
                bookmark_id=row["bookmark_id"],
                document_id=row["document_id"],
            )

    def recover_document_link(self, import_id: str, *, create_key: str) -> str | None:
        """Reconnect a document committed just before an interrupted linkage step."""
        with self.database.transaction() as connection:
            current = connection.execute(
                "SELECT document_id FROM karakeep_imports WHERE import_id = ?", (import_id,)
            ).fetchone()
            if current is None:
                raise NotFoundError(f"Karakeep import not found: {import_id}")
            if current["document_id"]:
                return current["document_id"]
            created = connection.execute(
                """
                SELECT document_id FROM idempotency_keys
                WHERE actor_id = ? AND idempotency_key = ? AND operation = 'create'
                """,
                (KARAKEEP_ACTOR_ID, create_key),
            ).fetchone()
            if created is None:
                return None
            snapshot = connection.execute(
                """
                SELECT snapshot_id FROM karakeep_snapshots
                WHERE import_id = ? ORDER BY created_at, snapshot_id LIMIT 1
                """,
                (import_id,),
            ).fetchone()
            connection.execute(
                """
                UPDATE karakeep_imports
                SET document_id = ?, accepted_snapshot_id = COALESCE(?, accepted_snapshot_id),
                    updated_at = ?
                WHERE import_id = ?
                """,
                (
                    created["document_id"],
                    snapshot["snapshot_id"] if snapshot else None,
                    utc_now(),
                    import_id,
                ),
            )
            return created["document_id"]

    def claim_refresh(self, import_id: str) -> None:
        now = utc_now()
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT status FROM karakeep_imports WHERE import_id = ?", (import_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"Karakeep import not found: {import_id}")
            if row["status"] == "importing":
                raise ConflictError("This Karakeep import is already running")
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = 'importing', last_error = NULL, last_attempt_at = ?, updated_at = ?
                WHERE import_id = ?
                """,
                (now, now, import_id),
            )

    def mark_failed(self, import_id: str, error: Exception) -> None:
        message = (
            error.message if isinstance(error, (IntegrationError, ValidationError)) else str(error)
        )
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = 'failed', last_error = ?, updated_at = ? WHERE import_id = ?
                """,
                (message[:1000], utc_now(), import_id),
            )

    def store_snapshot(self, import_id: str, snapshot: NormalizedSnapshot) -> str:
        candidate_id = str(uuid.uuid4())
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO karakeep_snapshots(
                    snapshot_id, import_id, source_url, title, author,
                    source_created_at, source_modified_at, tags_json, assets_json,
                    source_payload_json, source_html, extracted_markdown,
                    content_hash, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate_id,
                    import_id,
                    snapshot.source_url,
                    snapshot.title,
                    snapshot.author,
                    snapshot.source_created_at,
                    snapshot.source_modified_at,
                    json.dumps(snapshot.tags),
                    json.dumps([asset.model_dump() for asset in snapshot.assets]),
                    snapshot.source_payload_json,
                    snapshot.source_html,
                    snapshot.extracted_markdown,
                    snapshot.content_hash,
                    utc_now(),
                ),
            )
            row = connection.execute(
                """
                SELECT snapshot_id FROM karakeep_snapshots
                WHERE import_id = ? AND content_hash = ?
                """,
                (import_id, snapshot.content_hash),
            ).fetchone()
            if row is None:
                raise RuntimeError("Karakeep snapshot could not be loaded")
            return row["snapshot_id"]

    def initial_snapshot(self, import_id: str) -> StoredSnapshot | None:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT s.snapshot_id, s.title, s.tags_json,
                    s.extracted_markdown, s.content_hash
                FROM karakeep_imports i
                JOIN karakeep_snapshots s
                    ON s.snapshot_id = COALESCE(
                        i.accepted_snapshot_id,
                        (SELECT first.snapshot_id FROM karakeep_snapshots first
                         WHERE first.import_id = i.import_id
                         ORDER BY first.created_at, first.snapshot_id LIMIT 1)
                    )
                WHERE i.import_id = ?
                """,
                (import_id,),
            ).fetchone()
        if row is None:
            return None
        return StoredSnapshot(
            snapshot_id=row["snapshot_id"],
            title=row["title"],
            tags=tuple(json.loads(row["tags_json"])),
            extracted_markdown=row["extracted_markdown"],
            content_hash=row["content_hash"],
        )

    def link_initial_document(self, import_id: str, document_id: str, snapshot_id: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE karakeep_imports
                SET document_id = ?, accepted_snapshot_id = ?, updated_at = ?
                WHERE import_id = ?
                """,
                (document_id, snapshot_id, utc_now(), import_id),
            )

    def complete_initial_import(self, import_id: str, snapshot_id: str) -> None:
        now = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = 'current', accepted_snapshot_id = ?,
                    pending_snapshot_id = NULL, last_error = NULL,
                    last_success_at = ?, updated_at = ?
                WHERE import_id = ? AND document_id IS NOT NULL
                """,
                (snapshot_id, now, now, import_id),
            )
            if connection.execute("SELECT changes()").fetchone()[0] != 1:
                raise RuntimeError("Karakeep import completed without a linked document")

    def accepted_content_hash(self, import_id: str) -> str | None:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT accepted.content_hash
                FROM karakeep_imports i
                LEFT JOIN karakeep_snapshots accepted
                    ON accepted.snapshot_id = i.accepted_snapshot_id
                WHERE i.import_id = ?
                """,
                (import_id,),
            ).fetchone()
        return row["content_hash"] if row else None

    def complete_refresh(self, import_id: str, snapshot_id: str, *, unchanged: bool) -> None:
        now = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = ?, pending_snapshot_id = ?, last_error = NULL,
                    last_success_at = ?, updated_at = ?
                WHERE import_id = ?
                """,
                (
                    "current" if unchanged else "review_required",
                    None if unchanged else snapshot_id,
                    now,
                    now,
                    import_id,
                ),
            )

    def complete_apply(self, import_id: str) -> None:
        now = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = 'current', accepted_snapshot_id = pending_snapshot_id,
                    pending_snapshot_id = NULL, last_error = NULL,
                    last_success_at = ?, updated_at = ?
                WHERE import_id = ? AND status = 'review_required'
                """,
                (now, now, import_id),
            )

    def is_document_retry(self, *, actor_id: str, idempotency_key: str, document_id: str) -> bool:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT 1 FROM idempotency_keys
                WHERE actor_id = ? AND idempotency_key = ?
                    AND operation = 'update' AND document_id = ?
                """,
                (actor_id, idempotency_key, document_id),
            ).fetchone()
        return row is not None

    @staticmethod
    def _import_query() -> str:
        return """
            SELECT i.*,
                accepted.source_url, accepted.title, accepted.author,
                accepted.source_created_at, accepted.source_modified_at,
                accepted.tags_json, accepted.assets_json,
                accepted.extracted_markdown AS accepted_markdown,
                pending.extracted_markdown AS pending_markdown,
                d.title AS document_title, d.current_revision_id, r.content AS working_copy
            FROM karakeep_imports i
            LEFT JOIN karakeep_snapshots accepted
                ON accepted.snapshot_id = i.accepted_snapshot_id
            LEFT JOIN karakeep_snapshots pending
                ON pending.snapshot_id = i.pending_snapshot_id
            LEFT JOIN documents d ON d.document_id = i.document_id
            LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
        """

    @staticmethod
    def _import_from_row(row: sqlite3.Row) -> KarakeepImport:
        return KarakeepImport(
            import_id=row["import_id"],
            bookmark_id=row["bookmark_id"],
            document_id=row["document_id"],
            status=row["status"],
            last_error=row["last_error"],
            last_attempt_at=row["last_attempt_at"],
            last_success_at=row["last_success_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            source_url=row["source_url"],
            title=row["title"],
            author=row["author"],
            source_created_at=row["source_created_at"],
            source_modified_at=row["source_modified_at"],
            tags=json.loads(row["tags_json"] or "[]"),
            assets=[
                KarakeepAsset.model_validate(asset)
                for asset in json.loads(row["assets_json"] or "[]")
            ],
        )

    @classmethod
    def _detail_from_row(cls, row: sqlite3.Row) -> KarakeepImportDetail:
        summary = cls._import_from_row(row)
        return KarakeepImportDetail(
            **summary.model_dump(),
            document_title=row["document_title"],
            current_revision_id=row["current_revision_id"],
            working_copy=row["working_copy"],
            accepted_markdown=row["accepted_markdown"],
            pending_markdown=row["pending_markdown"],
        )
