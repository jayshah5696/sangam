from __future__ import annotations

import re
import sqlite3
from collections.abc import Sequence
from dataclasses import dataclass

from sangam.db import Database
from sangam.schemas import Document


@dataclass(frozen=True)
class SearchMatch:
    document_id: str
    snippet: str


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

    def search(self, query: str) -> list[SearchMatch] | None:
        terms = re.findall(r"[\w-]+", query, flags=re.UNICODE)
        if not terms:
            return None
        expression = " AND ".join(f'"{term}"*' for term in terms)
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT document_id,
                    snippet(document_search, -1, '[[', ']]', ' … ', 24) AS snippet
                FROM document_search
                WHERE document_search MATCH ?
                ORDER BY bm25(document_search)
                """,
                (expression,),
            ).fetchall()
        return [SearchMatch(document_id=row["document_id"], snippet=row["snippet"]) for row in rows]

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
                document.content,
                " ".join(tag.name for tag in document.tags),
                document.category or "",
                revision_search["authors"] or "",
                revision_search["summaries"] or "",
            ),
        )
