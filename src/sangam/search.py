from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterable

from sangam.db import Database
from sangam.schemas import Document


class SearchIndex:
    def __init__(self, database: Database) -> None:
        self.database = database

    def rebuild(self, documents: Iterable[Document]) -> None:
        with self.database.transaction() as connection:
            connection.execute("DELETE FROM document_search")
            for document in documents:
                self.replace(connection, document.document_id)

    def sync(self, document: Document) -> None:
        """Index canonical state under the writer lock, never a caller's stale snapshot."""
        with self.database.transaction() as connection:
            self.replace(connection, document.document_id)

    def repair_pending(self) -> int:
        """Repair only committed source changes whose index update was interrupted."""
        repaired = 0
        while True:
            with self.database.transaction() as connection:
                rows = connection.execute(
                    "SELECT document_id FROM search_dirty_documents ORDER BY document_id LIMIT 100"
                ).fetchall()
                if not rows:
                    return repaired
                for row in rows:
                    self.replace(connection, row["document_id"])
                repaired += len(rows)

    @staticmethod
    def compile_expression(query: str) -> str | None:
        terms = re.findall(r"[\w-]+", query, flags=re.UNICODE)
        if not terms:
            return None
        return " AND ".join(f'"{term}"*' for term in terms)

    @staticmethod
    def replace(connection: sqlite3.Connection, document_id: str) -> None:
        """Index one document's committed state on ``connection`` and clear its dirty marker.

        Writers that change many documents in one transaction call this per document
        so the index commits with them.
        """
        connection.execute("DELETE FROM document_search WHERE document_id = ?", (document_id,))
        connection.execute(
            "DELETE FROM search_dirty_documents WHERE document_id = ?", (document_id,)
        )
        document = connection.execute(
            """
            SELECT d.title, d.path, d.category, d.deleted, r.content,
                (SELECT group_concat(t.name, ' ') FROM document_tags dt
                 JOIN tags t ON t.tag_id = dt.tag_id WHERE dt.document_id = d.document_id) AS tags
            FROM documents d LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
            WHERE d.document_id = ?
            """,
            (document_id,),
        ).fetchone()
        if document is None or document["deleted"]:
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
            (document_id,),
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
            (document_id, document_id),
        ).fetchone()
        connection.execute(
            """
            INSERT INTO document_search(
                document_id, title, path, content, tags, category, authors, revision_summaries
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                document_id,
                document["title"],
                document["path"] or "",
                " ".join(
                    value
                    for value in (
                        document["content"],
                        pdf_search["pages"],
                        pdf_search["annotations"],
                    )
                    if value
                ),
                document["tags"] or "",
                document["category"] or "",
                revision_search["authors"] or "",
                revision_search["summaries"] or "",
            ),
        )
