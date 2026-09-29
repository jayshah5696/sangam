from __future__ import annotations

import json
import logging
import re
import uuid

from sangam.activity import ActivityService
from sangam.db import Database, utc_now
from sangam.errors import NotFoundError
from sangam.schemas import (
    AddProjectAnnotation,
    AddProjectDocument,
    AddProjectThread,
    CreateProject,
    ProjectAnnotationItem,
    ProjectDetail,
    ProjectDocumentItem,
    ProjectSummary,
    ProjectThreadItem,
    UpdateProject,
    UpdateProjectDocument,
)
from sangam.security import Principal
from sangam.service import DocumentService

logger = logging.getLogger(__name__)


def _slugify(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", value.strip().lower()).strip("-")
    return cleaned or "project"


def _available_brief_path(database: Database, slug: str) -> str:
    base = f"projects/{slug}/brief.md"
    with database.connection() as connection:
        row = connection.execute(
            "SELECT 1 FROM documents WHERE path = ? AND deleted = 0", (base,)
        ).fetchone()
        if not row:
            return base
        for index in range(2, 100):
            candidate = f"projects/{slug}-{index}/brief.md"
            row = connection.execute(
                "SELECT 1 FROM documents WHERE path = ? AND deleted = 0", (candidate,)
            ).fetchone()
            if not row:
                return candidate
    return f"projects/{slug}-{uuid.uuid4().hex[:6]}/brief.md"


class ProjectService:
    """Manages persistent project homes, source membership, and workbench state."""

    def __init__(
        self,
        *,
        database: Database,
        documents: DocumentService,
        activity: ActivityService,
    ) -> None:
        self.database = database
        self.documents = documents
        self.activity = activity

    def list_projects(self) -> list[ProjectSummary]:
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT
                    p.project_id,
                    p.name,
                    p.description,
                    p.brief_document_id,
                    d.title AS brief_document_title,
                    p.active_thread_id,
                    p.created_by,
                    p.created_at,
                    p.updated_at,
                    (SELECT COUNT(*) FROM project_documents pd
                     JOIN documents md ON md.document_id = pd.document_id AND md.deleted = 0
                     WHERE pd.project_id = p.project_id) AS document_count,
                    (SELECT COUNT(*) FROM project_threads pt
                     JOIN chat_threads ct ON ct.thread_id = pt.thread_id
                     WHERE pt.project_id = p.project_id) AS thread_count,
                    (SELECT COUNT(*) FROM project_annotations pa
                     JOIN annotations ma ON ma.annotation_id = pa.annotation_id AND ma.deleted = 0
                     WHERE pa.project_id = p.project_id) AS annotation_count
                FROM projects p
                LEFT JOIN documents d ON d.document_id = p.brief_document_id AND d.deleted = 0
                ORDER BY p.updated_at DESC, p.created_at DESC
                """
            ).fetchall()
            return [
                ProjectSummary(
                    project_id=row["project_id"],
                    name=row["name"],
                    description=row["description"],
                    brief_document_id=row["brief_document_id"],
                    brief_document_title=row["brief_document_title"],
                    active_thread_id=row["active_thread_id"],
                    document_count=row["document_count"],
                    thread_count=row["thread_count"],
                    annotation_count=row["annotation_count"],
                    created_by=row["created_by"],
                    created_at=row["created_at"],
                    updated_at=row["updated_at"],
                )
                for row in rows
            ]

    def get_project(self, project_id: str) -> ProjectDetail:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT
                    p.project_id,
                    p.name,
                    p.description,
                    p.brief_document_id,
                    d.title AS brief_document_title,
                    p.workbench_state_json,
                    p.active_thread_id,
                    p.created_by,
                    p.created_at,
                    p.updated_at,
                    (SELECT COUNT(*) FROM project_documents pd
                     JOIN documents md ON md.document_id = pd.document_id AND md.deleted = 0
                     WHERE pd.project_id = p.project_id) AS document_count,
                    (SELECT COUNT(*) FROM project_threads pt
                     JOIN chat_threads ct ON ct.thread_id = pt.thread_id
                     WHERE pt.project_id = p.project_id) AS thread_count,
                    (SELECT COUNT(*) FROM project_annotations pa
                     JOIN annotations ma ON ma.annotation_id = pa.annotation_id AND ma.deleted = 0
                     WHERE pa.project_id = p.project_id) AS annotation_count
                FROM projects p
                LEFT JOIN documents d ON d.document_id = p.brief_document_id AND d.deleted = 0
                WHERE p.project_id = ?
                """,
                (project_id,),
            ).fetchone()
            if not row:
                raise NotFoundError(f"Project '{project_id}' was not found")

            doc_rows = connection.execute(
                """
                SELECT
                    pd.project_id,
                    pd.document_id,
                    d.title AS document_title,
                    d.path AS document_path,
                    d.content_type,
                    pd.role,
                    pd.pinned_page,
                    pd.notes,
                    pd.created_at
                FROM project_documents pd
                JOIN documents d ON d.document_id = pd.document_id AND d.deleted = 0
                WHERE pd.project_id = ?
                ORDER BY
                    CASE pd.role
                        WHEN 'draft' THEN 1
                        WHEN 'source' THEN 2
                        WHEN 'note' THEN 3
                        WHEN 'output' THEN 4
                        ELSE 5
                    END,
                    pd.created_at ASC
                """,
                (project_id,),
            ).fetchall()
            documents = [
                ProjectDocumentItem(
                    project_id=d["project_id"],
                    document_id=d["document_id"],
                    document_title=d["document_title"],
                    document_path=d["document_path"],
                    content_type=d["content_type"],
                    role=d["role"],
                    pinned_page=d["pinned_page"],
                    notes=d["notes"],
                    created_at=d["created_at"],
                )
                for d in doc_rows
            ]

            thread_rows = connection.execute(
                """
                SELECT
                    pt.project_id,
                    pt.thread_id,
                    pt.created_at,
                    ct.data_json
                FROM project_threads pt
                JOIN chat_threads ct ON ct.thread_id = pt.thread_id
                WHERE pt.project_id = ?
                ORDER BY pt.created_at ASC
                """,
                (project_id,),
            ).fetchall()
            threads: list[ProjectThreadItem] = []
            for t in thread_rows:
                title = None
                try:
                    payload = json.loads(t["data_json"])
                    title = payload.get("title") or payload.get("name")
                except (json.JSONDecodeError, TypeError):
                    pass
                threads.append(
                    ProjectThreadItem(
                        project_id=t["project_id"],
                        thread_id=t["thread_id"],
                        title=title,
                        created_at=t["created_at"],
                    )
                )

            ann_rows = connection.execute(
                """
                SELECT
                    pa.project_id,
                    pa.annotation_id,
                    a.document_id,
                    a.page_number,
                    a.annotation_type,
                    a.selected_text,
                    a.note,
                    pa.created_at
                FROM project_annotations pa
                JOIN annotations a ON a.annotation_id = pa.annotation_id AND a.deleted = 0
                WHERE pa.project_id = ?
                ORDER BY pa.created_at ASC
                """,
                (project_id,),
            ).fetchall()
            annotations = [
                ProjectAnnotationItem(
                    project_id=a["project_id"],
                    annotation_id=a["annotation_id"],
                    document_id=a["document_id"],
                    page_number=a["page_number"],
                    annotation_type=a["annotation_type"],
                    selected_text=a["selected_text"],
                    note=a["note"],
                    created_at=a["created_at"],
                )
                for a in ann_rows
            ]

            return ProjectDetail(
                project_id=row["project_id"],
                name=row["name"],
                description=row["description"],
                brief_document_id=row["brief_document_id"],
                brief_document_title=row["brief_document_title"],
                workbench_state_json=row["workbench_state_json"],
                active_thread_id=row["active_thread_id"],
                document_count=row["document_count"],
                thread_count=row["thread_count"],
                annotation_count=row["annotation_count"],
                created_by=row["created_by"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                documents=documents,
                threads=threads,
                annotations=annotations,
            )

    def create_project(
        self,
        principal: Principal,
        request: CreateProject,
    ) -> ProjectDetail:
        now = utc_now()
        project_id = f"proj_{uuid.uuid4().hex[:16]}"
        brief_document_id = request.brief_document_id

        if brief_document_id:
            with self.database.connection() as connection:
                doc = connection.execute(
                    "SELECT document_id FROM documents WHERE document_id = ? AND deleted = 0",
                    (brief_document_id,),
                ).fetchone()
                if not doc:
                    raise NotFoundError(f"Brief document '{brief_document_id}' was not found")
        elif request.create_brief:
            slug = _slugify(request.name)
            brief_path = _available_brief_path(self.database, slug)
            desc = request.description or "Document project purpose, scope, and key questions."
            brief_content = (
                f"# {request.name}\n\n"
                f"## Purpose\n\n{desc}\n\n"
                f"## Working Notes & Unresolved Decisions\n\n"
                f"- [ ] Establish core questions and source material\n"
            )
            brief_doc = self.documents.create_document(
                title=f"{request.name} Brief",
                content=brief_content,
                path=brief_path,
                content_type="text/markdown",
                actor_id=principal.actor_id,
                idempotency_key=f"brief_{uuid.uuid4().hex[:16]}",
            )
            brief_document_id = brief_doc.document_id

        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO projects (
                    project_id, name, description, brief_document_id, workbench_state_json,
                    active_thread_id, created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)
                """,
                (
                    project_id,
                    request.name.strip(),
                    request.description.strip() if request.description else None,
                    brief_document_id,
                    principal.actor_id,
                    now,
                    now,
                ),
            )
            if brief_document_id:
                connection.execute(
                    """
                    INSERT INTO project_documents (
                        project_id, document_id, role, pinned_page, notes, created_at
                    ) VALUES (?, ?, 'draft', NULL, 'Project brief', ?)
                    """,
                    (project_id, brief_document_id, now),
                )

        self.activity.record(
            principal=principal,
            action="create",
            resource_type="project",
            outcome="accepted",
            resource_id=project_id,
            details={"title": request.name.strip(), "project_id": project_id},
        )
        return self.get_project(project_id)

    def update_project(
        self,
        principal: Principal,
        project_id: str,
        request: UpdateProject,
    ) -> ProjectDetail:
        now = utc_now()
        with self.database.connection() as connection:
            existing = connection.execute(
                """
                SELECT project_id, name, description, brief_document_id,
                       workbench_state_json, active_thread_id
                FROM projects WHERE project_id = ?
                """,
                (project_id,),
            ).fetchone()
            if not existing:
                raise NotFoundError(f"Project '{project_id}' was not found")

            if request.brief_document_id is not None:
                doc = connection.execute(
                    "SELECT document_id FROM documents WHERE document_id = ? AND deleted = 0",
                    (request.brief_document_id,),
                ).fetchone()
                if not doc:
                    raise NotFoundError(
                        f"Brief document '{request.brief_document_id}' was not found"
                    )

            if request.active_thread_id is not None:
                thread = connection.execute(
                    "SELECT thread_id FROM chat_threads WHERE thread_id = ?",
                    (request.active_thread_id,),
                ).fetchone()
                if not thread:
                    raise NotFoundError(f"Thread '{request.active_thread_id}' was not found")

        name = request.name.strip() if request.name is not None else existing["name"]
        description = (
            request.description.strip()
            if request.description is not None
            else existing["description"]
        )
        brief_document_id = (
            request.brief_document_id
            if request.brief_document_id is not None
            else existing["brief_document_id"]
        )
        workbench_state_json = (
            request.workbench_state_json
            if request.workbench_state_json is not None
            else existing["workbench_state_json"]
        )
        active_thread_id = (
            request.active_thread_id
            if request.active_thread_id is not None
            else existing["active_thread_id"]
        )

        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE projects
                SET name = ?, description = ?, brief_document_id = ?,
                    workbench_state_json = ?, active_thread_id = ?, updated_at = ?
                WHERE project_id = ?
                """,
                (
                    name,
                    description,
                    brief_document_id,
                    workbench_state_json,
                    active_thread_id,
                    now,
                    project_id,
                ),
            )
            if request.brief_document_id is not None:
                connection.execute(
                    """
                    INSERT INTO project_documents (
                        project_id, document_id, role, pinned_page, notes, created_at
                    ) VALUES (?, ?, 'draft', NULL, 'Project brief', ?)
                    ON CONFLICT(project_id, document_id) DO NOTHING
                    """,
                    (project_id, request.brief_document_id, now),
                )

        self.activity.record(
            principal=principal,
            action="update",
            resource_type="project",
            outcome="accepted",
            resource_id=project_id,
            details={"title": name, "project_id": project_id},
        )
        return self.get_project(project_id)

    def delete_project(self, principal: Principal, project_id: str) -> None:
        with self.database.connection() as connection:
            existing = connection.execute(
                "SELECT name FROM projects WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            if not existing:
                raise NotFoundError(f"Project '{project_id}' was not found")

        with self.database.transaction() as connection:
            connection.execute("DELETE FROM projects WHERE project_id = ?", (project_id,))

        self.activity.record(
            principal=principal,
            action="delete",
            resource_type="project",
            outcome="accepted",
            resource_id=project_id,
            details={"title": existing["name"], "project_id": project_id},
        )

    def add_document(
        self,
        principal: Principal,
        project_id: str,
        request: AddProjectDocument,
    ) -> ProjectDocumentItem:
        now = utc_now()
        with self.database.connection() as connection:
            project = connection.execute(
                "SELECT project_id, name FROM projects WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            if not project:
                raise NotFoundError(f"Project '{project_id}' was not found")

            doc = connection.execute(
                """
                SELECT document_id, title, path, content_type
                FROM documents WHERE document_id = ? AND deleted = 0
                """,
                (request.document_id,),
            ).fetchone()
            if not doc:
                raise NotFoundError(f"Document '{request.document_id}' was not found")

        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO project_documents (
                    project_id, document_id, role, pinned_page, notes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(project_id, document_id) DO UPDATE SET
                    role = excluded.role,
                    pinned_page = excluded.pinned_page,
                    notes = excluded.notes
                """,
                (
                    project_id,
                    request.document_id,
                    request.role,
                    request.pinned_page,
                    request.notes.strip() if request.notes else None,
                    now,
                ),
            )
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE project_id = ?",
                (now, project_id),
            )

        self.activity.record(
            principal=principal,
            action="add_document",
            resource_type="project",
            outcome="accepted",
            resource_id=project_id,
            details={
                "project_id": project_id,
                "title": doc["title"],
                "role": request.role,
                "pinned_page": request.pinned_page,
            },
        )

        return ProjectDocumentItem(
            project_id=project_id,
            document_id=doc["document_id"],
            document_title=doc["title"],
            document_path=doc["path"],
            content_type=doc["content_type"],
            role=request.role,
            pinned_page=request.pinned_page,
            notes=request.notes.strip() if request.notes else None,
            created_at=now,
        )

    def update_document(
        self,
        principal: Principal,
        project_id: str,
        document_id: str,
        request: UpdateProjectDocument,
    ) -> ProjectDocumentItem:
        now = utc_now()
        with self.database.connection() as connection:
            existing = connection.execute(
                """
                SELECT pd.project_id, pd.document_id, pd.role, pd.pinned_page, pd.notes,
                       pd.created_at, d.title AS document_title, d.path AS document_path,
                       d.content_type
                FROM project_documents pd
                JOIN documents d ON d.document_id = pd.document_id AND d.deleted = 0
                WHERE pd.project_id = ? AND pd.document_id = ?
                """,
                (project_id, document_id),
            ).fetchone()
            if not existing:
                raise NotFoundError(f"Document '{document_id}' is not in project '{project_id}'")

        role = request.role if request.role is not None else existing["role"]
        pinned_page = (
            request.pinned_page if request.pinned_page is not None else existing["pinned_page"]
        )
        notes = request.notes.strip() if request.notes is not None else existing["notes"]

        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE project_documents
                SET role = ?, pinned_page = ?, notes = ?
                WHERE project_id = ? AND document_id = ?
                """,
                (role, pinned_page, notes, project_id, document_id),
            )
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE project_id = ?",
                (now, project_id),
            )

        self.activity.record(
            principal=principal,
            action="update_document",
            resource_type="project",
            outcome="accepted",
            resource_id=project_id,
            details={
                "project_id": project_id,
                "title": existing["document_title"],
                "role": role,
                "pinned_page": pinned_page,
            },
        )

        return ProjectDocumentItem(
            project_id=project_id,
            document_id=document_id,
            document_title=existing["document_title"],
            document_path=existing["document_path"],
            content_type=existing["content_type"],
            role=role,
            pinned_page=pinned_page,
            notes=notes,
            created_at=existing["created_at"],
        )

    def remove_document(
        self,
        principal: Principal,
        project_id: str,
        document_id: str,
    ) -> None:
        now = utc_now()
        with self.database.connection() as connection:
            existing = connection.execute(
                """
                SELECT document_id FROM project_documents
                WHERE project_id = ? AND document_id = ?
                """,
                (project_id, document_id),
            ).fetchone()
            if not existing:
                raise NotFoundError(f"Document '{document_id}' is not in project '{project_id}'")

        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM project_documents WHERE project_id = ? AND document_id = ?",
                (project_id, document_id),
            )
            connection.execute(
                """
                UPDATE projects SET brief_document_id = NULL
                WHERE project_id = ? AND brief_document_id = ?
                """,
                (project_id, document_id),
            )
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE project_id = ?",
                (now, project_id),
            )

        self.activity.record(
            principal=principal,
            action="remove_document",
            resource_type="project",
            outcome="accepted",
            resource_id=project_id,
            details={"project_id": project_id},
        )

    def add_thread(
        self,
        principal: Principal,
        project_id: str,
        request: AddProjectThread,
    ) -> ProjectThreadItem:
        now = utc_now()
        with self.database.connection() as connection:
            project = connection.execute(
                "SELECT project_id, active_thread_id FROM projects WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            if not project:
                raise NotFoundError(f"Project '{project_id}' was not found")

            thread = connection.execute(
                "SELECT thread_id, data_json FROM chat_threads WHERE thread_id = ?",
                (request.thread_id,),
            ).fetchone()
            if not thread:
                raise NotFoundError(f"Thread '{request.thread_id}' was not found")

        title = None
        try:
            payload = json.loads(thread["data_json"])
            title = payload.get("title") or payload.get("name")
        except (json.JSONDecodeError, TypeError):
            pass

        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO project_threads (project_id, thread_id, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT(project_id, thread_id) DO NOTHING
                """,
                (project_id, request.thread_id, now),
            )
            if not project["active_thread_id"]:
                connection.execute(
                    """
                    UPDATE projects SET active_thread_id = ?, updated_at = ?
                    WHERE project_id = ?
                    """,
                    (request.thread_id, now, project_id),
                )
            else:
                connection.execute(
                    "UPDATE projects SET updated_at = ? WHERE project_id = ?",
                    (now, project_id),
                )

        self.activity.record(
            principal=principal,
            action="add_thread",
            resource_type="project",
            outcome="accepted",
            resource_id=project_id,
            details={"project_id": project_id, "thread_id": request.thread_id},
        )

        return ProjectThreadItem(
            project_id=project_id,
            thread_id=request.thread_id,
            title=title,
            created_at=now,
        )

    def remove_thread(
        self,
        principal: Principal,
        project_id: str,
        thread_id: str,
    ) -> None:
        now = utc_now()
        with self.database.connection() as connection:
            existing = connection.execute(
                "SELECT thread_id FROM project_threads WHERE project_id = ? AND thread_id = ?",
                (project_id, thread_id),
            ).fetchone()
            if not existing:
                raise NotFoundError(f"Thread '{thread_id}' is not in project '{project_id}'")

        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM project_threads WHERE project_id = ? AND thread_id = ?",
                (project_id, thread_id),
            )
            connection.execute(
                """
                UPDATE projects SET active_thread_id = NULL
                WHERE project_id = ? AND active_thread_id = ?
                """,
                (project_id, thread_id),
            )
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE project_id = ?",
                (now, project_id),
            )

        self.activity.record(
            principal=principal,
            action="remove_thread",
            resource_type="project",
            outcome="accepted",
            resource_id=project_id,
            details={"project_id": project_id, "thread_id": thread_id},
        )

    def add_annotation(
        self,
        principal: Principal,
        project_id: str,
        request: AddProjectAnnotation,
    ) -> ProjectAnnotationItem:
        now = utc_now()
        with self.database.connection() as connection:
            project = connection.execute(
                "SELECT project_id FROM projects WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            if not project:
                raise NotFoundError(f"Project '{project_id}' was not found")

            ann = connection.execute(
                """
                SELECT annotation_id, document_id, page_number, annotation_type,
                       selected_text, note
                FROM annotations WHERE annotation_id = ? AND deleted = 0
                """,
                (request.annotation_id,),
            ).fetchone()
            if not ann:
                raise NotFoundError(f"Annotation '{request.annotation_id}' was not found")

        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO project_annotations (project_id, annotation_id, created_at)
                VALUES (?, ?, ?)
                ON CONFLICT(project_id, annotation_id) DO NOTHING
                """,
                (project_id, request.annotation_id, now),
            )
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE project_id = ?",
                (now, project_id),
            )

        self.activity.record(
            principal=principal,
            action="add_annotation",
            resource_type="project",
            outcome="accepted",
            resource_id=project_id,
            details={"project_id": project_id},
        )

        return ProjectAnnotationItem(
            project_id=project_id,
            annotation_id=ann["annotation_id"],
            document_id=ann["document_id"],
            page_number=ann["page_number"],
            annotation_type=ann["annotation_type"],
            selected_text=ann["selected_text"],
            note=ann["note"],
            created_at=now,
        )

    def remove_annotation(
        self,
        principal: Principal,
        project_id: str,
        annotation_id: str,
    ) -> None:
        now = utc_now()
        with self.database.connection() as connection:
            existing = connection.execute(
                """
                SELECT annotation_id FROM project_annotations
                WHERE project_id = ? AND annotation_id = ?
                """,
                (project_id, annotation_id),
            ).fetchone()
            if not existing:
                raise NotFoundError(
                    f"Annotation '{annotation_id}' is not in project '{project_id}'"
                )

        with self.database.transaction() as connection:
            connection.execute(
                "DELETE FROM project_annotations WHERE project_id = ? AND annotation_id = ?",
                (project_id, annotation_id),
            )
            connection.execute(
                "UPDATE projects SET updated_at = ? WHERE project_id = ?",
                (now, project_id),
            )

        self.activity.record(
            principal=principal,
            action="remove_annotation",
            resource_type="project",
            outcome="accepted",
            resource_id=project_id,
            details={"project_id": project_id},
        )
