from __future__ import annotations

import re
import uuid
from typing import TYPE_CHECKING

from sangam.db import Database, utc_now
from sangam.errors import ConflictError, NotFoundError, ValidationError
from sangam.schemas import Project, ProjectDocument

if TYPE_CHECKING:
    import sqlite3


def _clean_snippet(raw: str | None) -> str | None:
    if not raw:
        return None
    cleaned = re.sub(r"[#*_`>~\[\]]", "", raw).strip()
    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    if not lines:
        return None
    first = lines[0]
    return first[:160] + "…" if len(first) > 160 else first


class ProjectService:
    """Lightweight project coordinator for organizing drafts, sources, and review work."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def list_projects(self, *, include_archived: bool = False) -> list[Project]:
        with self.database.connection() as connection:
            cursor = connection.execute(
                """
                SELECT
                    project_id,
                    name,
                    description,
                    primary_document_id,
                    resume_hint,
                    archived,
                    metadata_version,
                    created_at,
                    updated_at
                FROM projects
                WHERE (? OR archived = 0)
                ORDER BY updated_at DESC
                """,
                (1 if include_archived else 0,),
            )
            rows = cursor.fetchall()
            return [self._hydrate_project(connection, row) for row in rows]

    def get_project(self, project_id: str) -> Project:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT
                    project_id,
                    name,
                    description,
                    primary_document_id,
                    resume_hint,
                    archived,
                    metadata_version,
                    created_at,
                    updated_at
                FROM projects
                WHERE project_id = ?
                """,
                (project_id,),
            ).fetchone()
            if not row:
                raise NotFoundError(f"Project not found: {project_id}")
            return self._hydrate_project(connection, row)

    def create_project(
        self,
        *,
        name: str,
        description: str | None = None,
        primary_document_id: str | None = None,
        resume_hint: str | None = None,
        document_ids: list[str] | None = None,
    ) -> Project:
        normalized_name = name.strip()
        if not normalized_name:
            raise ValidationError("Project name cannot be empty")
        project_id = str(uuid.uuid4())
        now = utc_now()
        with self.database.transaction() as connection:
            if primary_document_id:
                doc = connection.execute(
                    "SELECT document_id FROM documents WHERE document_id = ? AND deleted = 0",
                    (primary_document_id,),
                ).fetchone()
                if not doc:
                    raise NotFoundError(f"Primary document not found: {primary_document_id}")

            connection.execute(
                """
                INSERT INTO projects(
                    project_id,
                    name,
                    description,
                    primary_document_id,
                    resume_hint,
                    archived,
                    metadata_version,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)
                """,
                (
                    project_id,
                    normalized_name,
                    description.strip() if description else None,
                    primary_document_id,
                    resume_hint.strip() if resume_hint else None,
                    now,
                    now,
                ),
            )

            all_docs: list[str] = []
            if primary_document_id:
                all_docs.append(primary_document_id)
            if document_ids:
                for doc_id in document_ids:
                    if doc_id not in all_docs:
                        all_docs.append(doc_id)

            for order, doc_id in enumerate(all_docs):
                connection.execute(
                    """
                    INSERT OR IGNORE INTO project_documents(
                        project_id,
                        document_id,
                        role,
                        context_summary,
                        resume_hint,
                        sort_order,
                        created_at
                    ) VALUES (?, ?, 'draft', NULL, NULL, ?, ?)
                    """,
                    (project_id, doc_id, order, now),
                )

            row = connection.execute(
                """
                SELECT
                    project_id,
                    name,
                    description,
                    primary_document_id,
                    resume_hint,
                    archived,
                    metadata_version,
                    created_at,
                    updated_at
                FROM projects
                WHERE project_id = ?
                """,
                (project_id,),
            ).fetchone()
            return self._hydrate_project(connection, row)

    def update_project(
        self,
        project_id: str,
        *,
        expected_metadata_version: int | None = None,
        name: str | None = None,
        description: str | None = None,
        primary_document_id: str | None = None,
        resume_hint: str | None = None,
        archived: bool | None = None,
    ) -> Project:
        now = utc_now()
        with self.database.transaction() as connection:
            current = connection.execute(
                "SELECT * FROM projects WHERE project_id = ?", (project_id,)
            ).fetchone()
            if not current:
                raise NotFoundError(f"Project not found: {project_id}")

            if (
                expected_metadata_version is not None
                and current["metadata_version"] != expected_metadata_version
            ):
                raise ConflictError(
                    "Project metadata version changed before update",
                    details={
                        "expected_version": expected_metadata_version,
                        "current_version": current["metadata_version"],
                    },
                )

            new_name = name.strip() if name is not None else current["name"]
            if not new_name:
                raise ValidationError("Project name cannot be empty")
            new_description = (
                description.strip() if description is not None else current["description"]
            )
            new_primary = (
                primary_document_id
                if primary_document_id is not None
                else current["primary_document_id"]
            )
            if new_primary:
                doc = connection.execute(
                    "SELECT document_id FROM documents WHERE document_id = ? AND deleted = 0",
                    (new_primary,),
                ).fetchone()
                if not doc:
                    raise NotFoundError(f"Primary document not found: {new_primary}")
            new_resume = resume_hint.strip() if resume_hint is not None else current["resume_hint"]
            new_archived = int(archived) if archived is not None else current["archived"]

            connection.execute(
                """
                UPDATE projects
                SET name = ?,
                    description = ?,
                    primary_document_id = ?,
                    resume_hint = ?,
                    archived = ?,
                    metadata_version = metadata_version + 1,
                    updated_at = ?
                WHERE project_id = ?
                """,
                (
                    new_name,
                    new_description,
                    new_primary,
                    new_resume,
                    new_archived,
                    now,
                    project_id,
                ),
            )

            row = connection.execute(
                "SELECT * FROM projects WHERE project_id = ?", (project_id,)
            ).fetchone()
            return self._hydrate_project(connection, row)

    def delete_project(self, project_id: str) -> None:
        with self.database.transaction() as connection:
            deleted = connection.execute(
                "DELETE FROM projects WHERE project_id = ?", (project_id,)
            ).rowcount
            if not deleted:
                raise NotFoundError(f"Project not found: {project_id}")

    def add_project_document(
        self,
        project_id: str,
        *,
        document_id: str,
        role: str = "draft",
        context_summary: str | None = None,
        resume_hint: str | None = None,
    ) -> ProjectDocument:
        raw = role.strip().lower() if role else "draft"
        if raw in {"source", "sources"}:
            normalized_role = "source"
        elif raw in {"note", "notes"}:
            normalized_role = "note"
        elif raw in {"output", "outputs"}:
            normalized_role = "output"
        else:
            normalized_role = "draft"
        now = utc_now()
        with self.database.transaction() as connection:
            project = connection.execute(
                "SELECT project_id FROM projects WHERE project_id = ?", (project_id,)
            ).fetchone()
            if not project:
                raise NotFoundError(f"Project not found: {project_id}")

            doc = connection.execute(
                """
                SELECT d.document_id, d.title, d.path, d.content_type, d.updated_at,
                       substr(r.content, 1, 300) AS snippet
                FROM documents d
                LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
                WHERE d.document_id = ? AND d.deleted = 0
                """,
                (document_id,),
            ).fetchone()
            if not doc:
                raise NotFoundError(f"Document not found: {document_id}")

            connection.execute(
                """
                INSERT INTO project_documents(
                    project_id,
                    document_id,
                    role,
                    context_summary,
                    resume_hint,
                    sort_order,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, 0, ?)
                ON CONFLICT(project_id, document_id) DO UPDATE SET
                    role = excluded.role,
                    context_summary = COALESCE(excluded.context_summary, project_documents.context_summary),
                    resume_hint = COALESCE(excluded.resume_hint, project_documents.resume_hint)
                """,
                (
                    project_id,
                    document_id,
                    normalized_role,
                    context_summary.strip() if context_summary else None,
                    resume_hint.strip() if resume_hint else None,
                    now,
                ),
            )
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE project_id = ?", (now, project_id)
            )

            return ProjectDocument(
                project_id=project_id,
                document_id=document_id,
                role=normalized_role,
                context_summary=context_summary.strip() if context_summary else None,
                resume_hint=resume_hint.strip() if resume_hint else None,
                sort_order=0,
                created_at=now,
                title=doc["title"],
                path=doc["path"],
                content_type=doc["content_type"],
                updated_at=doc["updated_at"],
                snippet=_clean_snippet(doc["snippet"]),
            )

    def remove_project_document(self, project_id: str, document_id: str) -> None:
        now = utc_now()
        with self.database.transaction() as connection:
            project = connection.execute(
                "SELECT project_id, primary_document_id FROM projects WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            if not project:
                raise NotFoundError(f"Project not found: {project_id}")

            deleted = connection.execute(
                "DELETE FROM project_documents WHERE project_id = ? AND document_id = ?",
                (project_id, document_id),
            ).rowcount
            if not deleted:
                raise NotFoundError(
                    f"Document {document_id} is not in project {project_id}"
                )

            if project["primary_document_id"] == document_id:
                connection.execute(
                    "UPDATE projects SET primary_document_id = NULL, updated_at = ? WHERE project_id = ?",
                    (now, project_id),
                )
            else:
                connection.execute(
                    "UPDATE projects SET updated_at = ? WHERE project_id = ?", (now, project_id)
                )

    def _hydrate_project(self, connection: sqlite3.Connection, row: sqlite3.Row) -> Project:
        doc_rows = connection.execute(
            """
            SELECT
                pd.project_id,
                pd.document_id,
                pd.role,
                pd.context_summary,
                pd.resume_hint,
                pd.sort_order,
                pd.created_at,
                d.title,
                d.path,
                d.content_type,
                d.updated_at,
                substr(r.content, 1, 300) AS snippet
            FROM project_documents pd
            JOIN documents d ON d.document_id = pd.document_id
            LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
            WHERE pd.project_id = ? AND d.deleted = 0
            ORDER BY pd.sort_order ASC, pd.created_at ASC
            """,
            (row["project_id"],),
        ).fetchall()

        documents = [
            ProjectDocument(
                project_id=d["project_id"],
                document_id=d["document_id"],
                role=d["role"],
                context_summary=d["context_summary"],
                resume_hint=d["resume_hint"],
                sort_order=d["sort_order"],
                created_at=d["created_at"],
                title=d["title"],
                path=d["path"],
                content_type=d["content_type"],
                updated_at=d["updated_at"],
                snippet=_clean_snippet(d["snippet"]),
            )
            for d in doc_rows
        ]

        primary_doc: ProjectDocument | None = None
        if row["primary_document_id"]:
            primary_doc = next(
                (d for d in documents if d.document_id == row["primary_document_id"]), None
            )
        if not primary_doc:
            primary_doc = next((d for d in documents if d.role == "draft"), None)
        if not primary_doc and documents:
            primary_doc = documents[0]

        return Project(
            project_id=row["project_id"],
            name=row["name"],
            description=row["description"],
            primary_document_id=row["primary_document_id"],
            resume_hint=row["resume_hint"],
            archived=bool(row["archived"]),
            metadata_version=row["metadata_version"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            documents=documents,
            primary_document=primary_doc,
        )
