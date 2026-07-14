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

    def search_document_ids(self, query: str) -> list[str] | None:
        terms = re.findall(r"[\w-]+", query, flags=re.UNICODE)
        if not terms:
            return None
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
        return [row["document_id"] for row in rows]

    @staticmethod
    def _replace(connection: sqlite3.Connection, document: Document) -> None:
        if document.deleted:
            return
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
