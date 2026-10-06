from __future__ import annotations

import sqlite3
import uuid
from typing import TYPE_CHECKING

from sangam.db import Database, utc_now
from sangam.errors import (
    ConflictError,
    NotFoundError,
    ValidationError,
    validate_metadata_text,
)
from sangam.idempotency import request_hash
from sangam.schemas import (
    CreateDocumentCommentRequest,
    DocumentComment,
)

if TYPE_CHECKING:
    from sangam.actors import ActorService
    from sangam.idempotency import IdempotencyStore
    from sangam.service import DocumentService


class DocumentCommentService:
    """Manages anchored comments on Markdown and HTML document passages."""

    def __init__(
        self,
        *,
        database: Database,
        idempotency: IdempotencyStore,
        actors: ActorService,
        documents: DocumentService,
    ) -> None:
        self.database = database
        self.idempotency = idempotency
        self.actors = actors
        self.documents = documents

    def create_comment(
        self,
        *,
        document_id: str,
        request: CreateDocumentCommentRequest,
        actor_id: str,
        idempotency_key: str | None = None,
    ) -> DocumentComment:
        validate_metadata_text(request.exact, "Comment exact passage")
        validate_metadata_text(request.prefix, "Comment prefix")
        validate_metadata_text(request.suffix, "Comment suffix")
        validate_metadata_text(request.body, "Comment body")

        self.documents.get_document(document_id)
        revision = self.documents.get_revision(document_id, request.revision_id)
        if revision.document_id != document_id:
            raise ValidationError(
                f"Revision {request.revision_id} does not belong to document {document_id}"
            )

        with self.database.transaction() as connection:
            self.actors.require_known(connection, actor_id)

            if idempotency_key:
                hash_val = request_hash(
                    {
                        "revision_id": request.revision_id,
                        "exact": request.exact,
                        "start": request.start,
                        "end": request.end,
                        "body": request.body,
                    }
                )
                replay = self.idempotency.mutation_record(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="create_comment",
                    request_hash=hash_val,
                )
                if replay and replay.resource_id:
                    existing = self._get_in_connection(connection, replay.resource_id)
                    if existing:
                        return existing

            comment_id = f"cmt_{uuid.uuid4().hex[:16]}"
            now = utc_now()
            connection.execute(
                """
                INSERT INTO document_comments (
                    comment_id, document_id, revision_id, exact, prefix, suffix,
                    "start", "end", body, resolved_at, created_by, created_at, version
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)
                """,
                (
                    comment_id,
                    document_id,
                    request.revision_id,
                    request.exact,
                    request.prefix,
                    request.suffix,
                    request.start,
                    request.end,
                    request.body,
                    actor_id,
                    now,
                ),
            )
            if idempotency_key:
                self.idempotency.record_mutation(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="create_comment",
                    request_hash=hash_val,
                    resource_type="comment",
                    resource_id=comment_id,
                    completed=True,
                )

            return DocumentComment(
                comment_id=comment_id,
                document_id=document_id,
                revision_id=request.revision_id,
                exact=request.exact,
                prefix=request.prefix,
                suffix=request.suffix,
                start=request.start,
                end=request.end,
                body=request.body,
                resolved_at=None,
                created_by=actor_id,
                created_at=now,
                version=1,
            )

    def list_comments(
        self,
        document_id: str,
        *,
        include_resolved: bool = True,
    ) -> list[DocumentComment]:
        with self.database.connection() as connection:
            if include_resolved:
                rows = connection.execute(
                    """
                    SELECT comment_id, document_id, revision_id, exact, prefix, suffix,
                           "start", "end", body, resolved_at, created_by, created_at, version
                    FROM document_comments
                    WHERE document_id = ?
                    ORDER BY (resolved_at IS NOT NULL) ASC, created_at ASC
                    """,
                    (document_id,),
                ).fetchall()
            else:
                rows = connection.execute(
                    """
                    SELECT comment_id, document_id, revision_id, exact, prefix, suffix,
                           "start", "end", body, resolved_at, created_by, created_at, version
                    FROM document_comments
                    WHERE document_id = ? AND resolved_at IS NULL
                    ORDER BY created_at ASC
                    """,
                    (document_id,),
                ).fetchall()

            return [self._row_to_comment(row) for row in rows]

    def get_comment(self, comment_id: str) -> DocumentComment:
        with self.database.connection() as connection:
            comment = self._get_in_connection(connection, comment_id)
            if comment is None:
                raise NotFoundError(f"Comment not found: {comment_id}")
            return comment

    def resolve_comment(
        self,
        *,
        comment_id: str,
        resolved: bool,
        expected_version: int,
        actor_id: str,
    ) -> DocumentComment:
        with self.database.transaction() as connection:
            self.actors.require_known(connection, actor_id)
            row = connection.execute(
                """
                SELECT comment_id, document_id, revision_id, exact, prefix, suffix,
                       "start", "end", body, resolved_at, created_by, created_at, version
                FROM document_comments
                WHERE comment_id = ?
                """,
                (comment_id,),
            ).fetchone()
            if row is None:
                raise NotFoundError(f"Comment not found: {comment_id}")

            current_version = row["version"]
            if current_version != expected_version:
                raise ConflictError(
                    "Comment version mismatch",
                    details={
                        "comment_id": comment_id,
                        "current_version": current_version,
                        "expected_version": expected_version,
                    },
                )

            next_version = current_version + 1
            now = utc_now()
            resolved_at = now if resolved else None

            connection.execute(
                """
                UPDATE document_comments
                SET resolved_at = ?, version = ?
                WHERE comment_id = ?
                """,
                (resolved_at, next_version, comment_id),
            )

            return DocumentComment(
                comment_id=comment_id,
                document_id=row["document_id"],
                revision_id=row["revision_id"],
                exact=row["exact"],
                prefix=row["prefix"],
                suffix=row["suffix"],
                start=row["start"],
                end=row["end"],
                body=row["body"],
                resolved_at=resolved_at,
                created_by=row["created_by"],
                created_at=row["created_at"],
                version=next_version,
            )

    def _get_in_connection(
        self, connection: sqlite3.Connection, comment_id: str
    ) -> DocumentComment | None:
        row = connection.execute(
            """
            SELECT comment_id, document_id, revision_id, exact, prefix, suffix,
                   "start", "end", body, resolved_at, created_by, created_at, version
            FROM document_comments
            WHERE comment_id = ?
            """,
            (comment_id,),
        ).fetchone()
        if row is None:
            return None
        return self._row_to_comment(row)

    def _row_to_comment(self, row: sqlite3.Row) -> DocumentComment:
        return DocumentComment(
            comment_id=row["comment_id"],
            document_id=row["document_id"],
            revision_id=row["revision_id"],
            exact=row["exact"],
            prefix=row["prefix"],
            suffix=row["suffix"],
            start=row["start"],
            end=row["end"],
            body=row["body"],
            resolved_at=row["resolved_at"],
            created_by=row["created_by"],
            created_at=row["created_at"],
            version=row["version"],
        )
