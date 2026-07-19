from __future__ import annotations

import re
import sqlite3
from collections.abc import Sequence

from sangam.db import Database
from sangam.schemas import Document


class SearchIndex:
    def __init__(self, database: Database) -> None:
        self.database = database

    def rebuild(self, documents: Sequence[Document]) -> None:
        with self.database.transaction() as connection:
            connection.execute("DELETE FROM document_search")
            for document in documents:
                self._replace(connection, document)

    def sync(self, document: Document) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM document_search WHERE document_id = ?",
                (document.document_id,),
            )
            self._replace(connection, document)

    @staticmethod
    def compile_expression(query: str) -> str | None:
        terms = re.findall(r"[\w-]+", query, flags=re.UNICODE)
        if not terms:
            return None
        return " AND ".join(f'"{term}"*' for term in terms)

    @staticmethod
    def _replace(connection: sqlite3.Connection, document: Document) -> None:
        if document.deleted:
            return
        revision_search = connection.execute(
            """
            SELECT
                group_concat(DISTINCT r.actor_id || ' ' || a.display_name) AS authors,
                group_concat(r.summary, ' ') AS summaries
            FROM revisions r
            JOIN actors a ON a.actor_id = r.actor_id
            WHERE r.document_id = ?
            """,
            (document.document_id,),
        ).fetchone()
        pdf_search = connection.execute(
            """
            SELECT
                (SELECT group_concat('Page ' || page_number || ' ' || text, ' ')
                    FROM pdf_pages WHERE document_id = ?) AS pages,
                (SELECT group_concat(
                    COALESCE(selected_text, '') || ' ' || COALESCE(note, '') || ' ' || tags_json,
                    ' '
                ) FROM annotations WHERE document_id = ? AND deleted = 0) AS annotations
            """,
            (document.document_id, document.document_id),
        ).fetchone()
        connection.execute(
            """
            INSERT INTO document_search(
                document_id, title, path, content, tags, category, authors, revision_summaries
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                document.document_id,
                document.title,
                document.path or "",
                " ".join(
                    value
                    for value in (
                        document.content,
                        pdf_search["pages"],
                        pdf_search["annotations"],
                    )
                    if value
                ),
                " ".join(tag.name for tag in document.tags),
                document.category or "",
                revision_search["authors"] or "",
                revision_search["summaries"] or "",
            ),
        )
