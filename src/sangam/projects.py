from __future__ import annotations

import json
import uuid
from collections.abc import Callable
from functools import wraps
from typing import Concatenate, TypeVar

from chatkit.types import ThreadMetadata
from pydantic import BaseModel

from sangam.access import Audited, writes
from sangam.activity import ActivityService
from sangam.authorization import AuthorizationPolicy
from sangam.db import Database, utc_now
from sangam.errors import ConflictError, NotFoundError, ValidationError, validate_metadata_text
from sangam.idempotency import IdempotencyStore, request_hash
from sangam.schemas import (
    AddProjectAnnotation,
    AddProjectDocument,
    AddProjectThread,
    CreateProject,
    ProjectAnnotationItem,
    ProjectDetail,
    ProjectDocumentItem,
    ProjectLayout,
    ProjectSummary,
    ProjectTab,
    ProjectThreadItem,
    UpdateProject,
    UpdateProjectDocument,
)
from sangam.security import Principal
from sangam.service import DocumentService

M = TypeVar("M", bound=BaseModel)


def atomic[T, **P](
    method: Callable[Concatenate[ProjectService, Principal, P], T],
) -> Callable[Concatenate[ProjectService, Principal, P], T]:
    """Authorize before reference lookup; serialize reads, writes and audit in one transaction."""

    @wraps(method)
    def run(self: ProjectService, principal: Principal, *args: P.args, **kwargs: P.kwargs) -> T:
        AuthorizationPolicy.require_administrator(principal)
        with self.database.transaction():
            return method(self, principal, *args, **kwargs)

    return run


class DeletedProjectReference(BaseModel):
    """The recorded result of a removal, so a replayed removal has something to return."""


class ProjectService:
    """Small reference-based project model. Membership never grants resource access."""

    def __init__(
        self,
        *,
        database: Database,
        documents: DocumentService,
        activity: ActivityService,
        audited: Audited,
    ) -> None:
        self.database, self.documents, self.activity = database, documents, activity
        self._audited = audited

    def execute(
        self,
        principal: Principal,
        *,
        key: str,
        operation: str,
        payload: dict[str, object],
        response_type: type[M],
        mutation: Callable[[], M],
        action: str,
        project_id: str | None = None,
    ) -> M:
        """Run one project change at most once per idempotency key, under the ledger contract."""
        AuthorizationPolicy.require_administrator(principal)
        return self._audited(
            principal,
            writes(action, "project"),
            lambda: self._execute_once(
                principal,
                key=key,
                operation=operation,
                payload=payload,
                response_type=response_type,
                mutation=mutation,
            ),
            resource_id=project_id,
        )

    def _execute_once(
        self,
        principal: Principal,
        *,
        key: str,
        operation: str,
        payload: dict[str, object],
        response_type: type[M],
        mutation: Callable[[], M],
    ) -> M:
        with self.database.transaction() as conn:
            digest = request_hash(payload)
            record = IdempotencyStore.mutation_record(
                conn, actor_id=principal.actor_id, key=key, operation=operation, request_hash=digest
            )
            if record:
                self.database.set_audit_target(resource_id=record.resource_id)
                row = conn.execute(
                    "SELECT response_json FROM project_mutation_results "
                    "WHERE actor_id=? AND idempotency_key=?",
                    (principal.actor_id, key),
                ).fetchone()
                if row is None:
                    raise ConflictError("Project replay result is unavailable")
                return self._readable_replay(
                    principal, response_type.model_validate_json(row["response_json"])
                )
            result = mutation()
            IdempotencyStore.record_mutation(
                conn,
                actor_id=principal.actor_id,
                key=key,
                operation=operation,
                request_hash=digest,
                resource_type="project",
                resource_id=result.project_id
                if isinstance(
                    result,
                    (ProjectDetail, ProjectDocumentItem, ProjectThreadItem, ProjectAnnotationItem),
                )
                else operation.rsplit(":", 1)[-1],
            )
            conn.execute(
                "INSERT INTO project_mutation_results VALUES (?, ?, ?)",
                (principal.actor_id, key, result.model_dump_json()),
            )
            return result

    # The three changes below are exposed to both the HTTP API and chat. Each runs once
    # per idempotency key under the operation name every caller shares.

    def create_project_once(
        self, principal: Principal, key: str, request: CreateProject
    ) -> ProjectDetail:
        return self.execute(
            principal,
            key=key,
            operation="project:create",
            payload=request.model_dump(exclude_unset=True),
            response_type=ProjectDetail,
            mutation=lambda: self.create_project(principal, request),
            action="create",
        )

    def add_document_once(
        self, principal: Principal, key: str, project_id: str, request: AddProjectDocument
    ) -> ProjectDocumentItem:
        return self.execute(
            principal,
            key=key,
            operation=f"project:add-document:{project_id}",
            payload=request.model_dump(exclude_unset=True),
            response_type=ProjectDocumentItem,
            mutation=lambda: self.add_document(principal, project_id, request),
            action="add_document",
            project_id=project_id,
        )

    def remove_document_once(
        self, principal: Principal, key: str, project_id: str, document_id: str
    ) -> None:
        self._removal(
            principal,
            key,
            f"project:remove-document:{project_id}:{document_id}",
            "remove_document",
            lambda: self.remove_document(principal, project_id, document_id),
            project_id,
        )

    def update_project_once(
        self, principal: Principal, key: str, project_id: str, request: UpdateProject
    ) -> ProjectDetail:
        return self.execute(
            principal,
            key=key,
            operation=f"project:update:{project_id}",
            payload=request.model_dump(exclude_unset=True),
            response_type=ProjectDetail,
            mutation=lambda: self.update_project(principal, project_id, request),
            action="update",
            project_id=project_id,
        )

    def delete_project_once(self, principal: Principal, key: str, project_id: str) -> None:
        self._removal(
            principal,
            key,
            f"project:delete:{project_id}",
            "delete",
            lambda: self.delete_project(principal, project_id),
            project_id,
        )

    def update_document_once(
        self,
        principal: Principal,
        key: str,
        project_id: str,
        document_id: str,
        request: UpdateProjectDocument,
    ) -> ProjectDocumentItem:
        return self.execute(
            principal,
            key=key,
            operation=f"project:update-document:{project_id}:{document_id}",
            payload=request.model_dump(exclude_unset=True),
            response_type=ProjectDocumentItem,
            mutation=lambda: self.update_document(principal, project_id, document_id, request),
            action="update_document",
            project_id=project_id,
        )

    def add_thread_once(
        self, principal: Principal, key: str, project_id: str, request: AddProjectThread
    ) -> ProjectThreadItem:
        return self.execute(
            principal,
            key=key,
            operation=f"project:add-thread:{project_id}",
            payload=request.model_dump(exclude_unset=True),
            response_type=ProjectThreadItem,
            mutation=lambda: self.add_thread(principal, project_id, request),
            action="add_thread",
            project_id=project_id,
        )

    def remove_thread_once(
        self, principal: Principal, key: str, project_id: str, thread_id: str
    ) -> None:
        self._removal(
            principal,
            key,
            f"project:remove-thread:{project_id}:{thread_id}",
            "remove_thread",
            lambda: self.remove_thread(principal, project_id, thread_id),
            project_id,
        )

    def add_annotation_once(
        self, principal: Principal, key: str, project_id: str, request: AddProjectAnnotation
    ) -> ProjectAnnotationItem:
        return self.execute(
            principal,
            key=key,
            operation=f"project:add-annotation:{project_id}",
            payload=request.model_dump(exclude_unset=True),
            response_type=ProjectAnnotationItem,
            mutation=lambda: self.add_annotation(principal, project_id, request),
            action="add_annotation",
            project_id=project_id,
        )

    def remove_annotation_once(
        self, principal: Principal, key: str, project_id: str, annotation_id: str
    ) -> None:
        self._removal(
            principal,
            key,
            f"project:remove-annotation:{project_id}:{annotation_id}",
            "remove_annotation",
            lambda: self.remove_annotation(principal, project_id, annotation_id),
            project_id,
        )

    def _removal(
        self,
        principal: Principal,
        key: str,
        operation: str,
        action: str,
        remove: Callable[[], None],
        project_id: str,
    ) -> None:
        def run() -> DeletedProjectReference:
            remove()
            return DeletedProjectReference()

        self.execute(
            principal,
            key=key,
            operation=operation,
            payload={},
            response_type=DeletedProjectReference,
            mutation=run,
            action=action,
            project_id=project_id,
        )

    def _readable_replay(self, principal: Principal, result: M) -> M:
        """A replay acknowledges the original write but cannot revive unavailable references."""
        if not isinstance(
            result, (ProjectDetail, ProjectDocumentItem, ProjectThreadItem, ProjectAnnotationItem)
        ):
            return result
        current = self.get_project(result.project_id, principal)
        doc_ids = {d.document_id for d in current.documents}
        annotation_ids = {a.annotation_id for a in current.annotations}
        thread_ids = {t.thread_id for t in current.threads}
        if isinstance(result, ProjectDocumentItem) and result.document_id not in doc_ids:
            raise NotFoundError("Replayed document reference is no longer available")
        if isinstance(result, ProjectAnnotationItem) and result.annotation_id not in annotation_ids:
            raise NotFoundError("Replayed passage is no longer available")
        if isinstance(result, ProjectThreadItem) and result.thread_id not in thread_ids:
            raise NotFoundError("Replayed conversation is no longer available")
        if isinstance(result, ProjectDetail):
            documents = [d for d in result.documents if d.document_id in doc_ids]
            annotations = [a for a in result.annotations if a.annotation_id in annotation_ids]
            threads = [t for t in result.threads if t.thread_id in thread_ids]
            layout_json = result.workbench_state_json
            if layout_json:
                layout = ProjectLayout.model_validate_json(layout_json)
                for group in layout.groups():
                    group.tabs = [t for t in group.tabs if t.documentId in doc_ids]
                    if not any(t.documentId == group.activeTabId for t in group.tabs):
                        group.activeTabId = group.tabs[0].documentId if group.tabs else None
                layout.recentlyClosed = []
                layout_json = layout.model_dump_json()
            brief_available = result.brief_document_id in doc_ids
            return result.model_copy(
                update={
                    "documents": documents,
                    "annotations": annotations,
                    "threads": threads,
                    "document_count": len(documents),
                    "annotation_count": len(annotations),
                    "thread_count": len(threads),
                    "brief_document_id": result.brief_document_id if brief_available else None,
                    "brief_document_title": result.brief_document_title
                    if brief_available
                    else None,
                    "active_document_id": result.active_document_id
                    if result.active_document_id in doc_ids
                    else None,
                    "active_thread_id": result.active_thread_id
                    if result.active_thread_id in thread_ids
                    else None,
                    "workbench_state_json": layout_json,
                }
            )
        return result

    def _audit(self, principal: Principal, action: str, project_id: str) -> None:
        """Name the project as the ledger target of the enclosing audited change."""
        del principal, action
        # A brief created in the same transaction may already have named its document.
        self.database.clear_audit_target()
        self.database.set_audit_target(resource_id=project_id)

    def _project(self, project_id: str, expected_version: int | None = None):
        with self.database.connection() as conn:
            row = conn.execute(
                "SELECT * FROM projects WHERE project_id=?", (project_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"Project '{project_id}' was not found")
            if expected_version is not None and row["version"] != expected_version:
                raise ConflictError(
                    "Project changed. Reload before saving.",
                    details={"current_version": row["version"]},
                )
            return row

    def _touch(self, project_id: str) -> None:
        with self.database.connection() as conn:
            conn.execute(
                "UPDATE projects SET updated_at=?, version=version+1 WHERE project_id=?",
                (utc_now(), project_id),
            )

    def _thread(self, principal: Principal, thread_id: str):
        with self.database.connection() as conn:
            row = conn.execute(
                "SELECT * FROM chat_threads WHERE thread_id=? AND created_by=?",
                (thread_id, principal.actor_id),
            ).fetchone()
            if row is None:
                raise NotFoundError(f"Conversation '{thread_id}' was not found")
            if row["document_id"]:
                self.documents.get_document(row["document_id"])
            return row

    @staticmethod
    def _thread_title(data_json: str) -> str | None:
        # Chat store writes versioned payloads, while legacy rows contain the metadata directly.
        data = json.loads(data_json)
        return ThreadMetadata.model_validate(
            data["payload"] if data.get("schema_version") == 1 else data
        ).title

    def available_threads(self, principal: Principal) -> list[ProjectThreadItem]:
        AuthorizationPolicy.require_administrator(principal)
        with self.database.connection() as conn:
            rows = conn.execute(
                """SELECT ct.* FROM chat_threads ct
                LEFT JOIN documents d ON d.document_id=ct.document_id
                WHERE ct.created_by=? AND (ct.document_id IS NULL OR d.deleted=0)
                ORDER BY ct.updated_at DESC""",
                (principal.actor_id,),
            ).fetchall()
            return [
                ProjectThreadItem(
                    project_id="",
                    thread_id=r["thread_id"],
                    title=self._thread_title(r["data_json"]),
                    created_at=r["created_at"],
                )
                for r in rows
            ]

    def list_projects(self, principal: Principal | None = None) -> list[ProjectSummary]:
        if principal:
            AuthorizationPolicy.require_administrator(principal)
        with self.database.connection() as conn:
            rows = conn.execute(
                """SELECT p.project_id, p.name, p.description, p.version,
                b.document_id AS brief_document_id, b.title AS brief_document_title,
                ad.document_id AS active_document_id,
                CASE WHEN ct.created_by=COALESCE(?,p.created_by)
                    AND (ct.document_id IS NULL OR td.deleted=0)
                    THEN ct.thread_id ELSE NULL END AS active_thread_id,
                p.created_by,p.created_at,p.updated_at,
                (SELECT MAX(d.updated_at) FROM project_documents pd JOIN documents d
                    ON d.document_id=pd.document_id AND d.deleted=0
                    WHERE pd.project_id=p.project_id
                    AND d.document_id IS NOT p.brief_document_id) AS last_worked_at,
                (SELECT COUNT(*) FROM project_documents pd JOIN documents d
                    ON d.document_id=pd.document_id AND d.deleted=0
                    WHERE pd.project_id=p.project_id) AS document_count,
                (SELECT COUNT(*) FROM project_threads pt JOIN chat_threads t
                    ON t.thread_id=pt.thread_id
                    LEFT JOIN documents d ON d.document_id=t.document_id
                    WHERE pt.project_id=p.project_id AND t.created_by=COALESCE(?,p.created_by)
                    AND (t.document_id IS NULL OR d.deleted=0)) AS thread_count,
                (SELECT COUNT(*) FROM project_annotations pa JOIN annotations a
                    ON a.annotation_id=pa.annotation_id AND a.deleted=0
                    JOIN documents d ON d.document_id=a.document_id AND d.deleted=0
                    WHERE pa.project_id=p.project_id) AS annotation_count
                FROM projects p LEFT JOIN documents b
                    ON b.document_id=p.brief_document_id AND b.deleted=0
                LEFT JOIN project_documents ap ON ap.project_id=p.project_id
                    AND ap.document_id=p.active_document_id AND ap.role='draft'
                LEFT JOIN documents ad ON ad.document_id=ap.document_id AND ad.deleted=0
                    AND ad.document_id IS NOT p.brief_document_id
                LEFT JOIN chat_threads ct ON ct.thread_id=p.active_thread_id
                LEFT JOIN documents td ON td.document_id=ct.document_id
                ORDER BY p.updated_at DESC,p.project_id""",
                (
                    principal.actor_id if principal else None,
                    principal.actor_id if principal else None,
                ),
            ).fetchall()
            return [ProjectSummary(**dict(row)) for row in rows]

    def get_project(self, project_id: str, principal: Principal | None = None) -> ProjectDetail:
        if principal:
            AuthorizationPolicy.require_administrator(principal)
        row = self._project(project_id)
        with self.database.connection() as conn:
            rows = conn.execute(
                """SELECT pd.*, d.title AS document_title, d.path AS document_path,
                d.content_type, d.current_revision_id, d.updated_at, r.content
                FROM project_documents pd JOIN documents d
                    ON d.document_id=pd.document_id AND d.deleted=0
                JOIN revisions r ON r.revision_id=d.current_revision_id
                WHERE pd.project_id=? ORDER BY pd.created_at, pd.document_id""",
                (project_id,),
            ).fetchall()
            docs = [
                ProjectDocumentItem(
                    **{
                        k: r[k]
                        for k in (
                            "project_id",
                            "document_id",
                            "document_title",
                            "document_path",
                            "content_type",
                            "role",
                            "pinned_page",
                            "notes",
                            "created_at",
                            "source_revision_id",
                            "current_revision_id",
                            "updated_at",
                        )
                    },
                    source_updated=r["source_revision_id"] is not None
                    and r["source_revision_id"] != r["current_revision_id"],
                    excerpt=" ".join(
                        line.strip()
                        for line in (r["content"] or "").splitlines()
                        if line.strip() and not line.lstrip().startswith("#")
                    )[:240],
                )
                for r in rows
            ]
            threads = []
            for t in conn.execute(
                """SELECT pt.*, ct.data_json, ct.created_by, ct.document_id FROM project_threads pt
                    JOIN chat_threads ct ON ct.thread_id=pt.thread_id WHERE pt.project_id=?""",
                (project_id,),
            ):
                if t["created_by"] != (principal.actor_id if principal else row["created_by"]):
                    continue
                if (
                    t["document_id"]
                    and not conn.execute(
                        "SELECT 1 FROM documents WHERE document_id=? AND deleted=0",
                        (t["document_id"],),
                    ).fetchone()
                ):
                    continue
                threads.append(
                    ProjectThreadItem(
                        project_id=project_id,
                        thread_id=t["thread_id"],
                        title=self._thread_title(t["data_json"]),
                        created_at=t["created_at"],
                    )
                )
            annotations = [
                ProjectAnnotationItem(**dict(a))
                for a in conn.execute(
                    """SELECT pa.project_id,
                a.annotation_id, a.document_id, a.page_number, a.annotation_type,
                a.selected_text, a.note, pa.created_at
                FROM project_annotations pa JOIN annotations a
                    ON a.annotation_id=pa.annotation_id AND a.deleted=0
                JOIN documents d ON d.document_id=a.document_id AND d.deleted=0
                WHERE pa.project_id=?""",
                    (project_id,),
                )
            ]
            doc_ids = {d.document_id for d in docs}
            brief = next((d for d in docs if d.document_id == row["brief_document_id"]), None)
            active = next(
                (
                    d
                    for d in docs
                    if d.document_id == row["active_document_id"]
                    and d.role == "draft"
                    and d.document_id != row["brief_document_id"]
                ),
                None,
            )
            layout_json = row["workbench_state_json"]
            if layout_json:
                layout = ProjectLayout.model_validate_json(layout_json)
                for group in layout.groups():
                    group.tabs = [t for t in group.tabs if t.documentId in doc_ids]
                    if group.activeTabId not in doc_ids:
                        group.activeTabId = group.tabs[0].documentId if group.tabs else None
                layout.recentlyClosed = []
                layout_json = layout.model_dump_json()
            return ProjectDetail(
                project_id=project_id,
                name=row["name"],
                description=row["description"],
                brief_document_id=brief.document_id if brief else None,
                brief_document_title=brief.document_title if brief else None,
                active_document_id=active.document_id if active else None,
                active_thread_id=row["active_thread_id"]
                if any(t.thread_id == row["active_thread_id"] for t in threads)
                else None,
                version=row["version"],
                workbench_state_json=layout_json,
                document_count=len(docs),
                thread_count=len(threads),
                annotation_count=len(annotations),
                created_by=row["created_by"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
                last_worked_at=max(
                    (d.updated_at for d in docs if d.document_id != row["brief_document_id"]),
                    default=None,
                ),
                documents=docs,
                threads=threads,
                annotations=annotations,
            )

    @atomic
    def create_project(self, principal: Principal, request: CreateProject) -> ProjectDetail:
        validate_metadata_text(request.name, "Project name")
        validate_metadata_text(request.description, "Project description")
        if not request.name.strip():
            raise ValidationError("Project name cannot be empty")
        project_id, now = f"proj_{uuid.uuid4().hex[:16]}", utc_now()
        brief_id = request.brief_document_id
        if brief_id:
            brief = self.documents.get_document(brief_id)
            if brief.content_type != "text/markdown":
                raise ValidationError("Project brief must be Markdown")
        elif request.create_brief:
            brief = self.documents.create_draft_in_transaction(
                title=f"{request.name} Brief",
                content=(
                    f"# {request.name}\n\n## Purpose\n\n"
                    f"{request.description or 'Describe the purpose of this work.'}\n\n"
                    "## Unresolved decisions\n\n- [ ] Choose the next question to answer\n"
                ),
                actor_id=principal.actor_id,
                idempotency_key=f"project-brief:{project_id}",
            )
            brief_id = brief.document_id
            with self.database.connection() as conn:
                self.activity.record_with_connection(
                    conn,
                    principal=principal,
                    action="create",
                    resource_type="document",
                    resource_id=brief_id,
                    revision_id=brief.current_revision_id,
                    outcome="accepted",
                    details={"title": brief.title, "content_type": brief.content_type},
                )
        with self.database.connection() as conn:
            conn.execute(
                """INSERT INTO projects (project_id,name,description,brief_document_id,
                    created_by,created_at,updated_at)
                VALUES (?,?,?,?,?,?,?)""",
                (
                    project_id,
                    request.name.strip(),
                    request.description,
                    brief_id,
                    principal.actor_id,
                    now,
                    now,
                ),
            )
            if brief_id:
                conn.execute(
                    "INSERT INTO project_documents "
                    "(project_id,document_id,role,created_at,source_revision_id) "
                    "VALUES (?,?,?,?,?)",
                    (project_id, brief_id, "note", now, brief.current_revision_id),
                )
        self._audit(principal, "create", project_id)
        return self.get_project(project_id, principal)

    @atomic
    def update_project(
        self, principal: Principal, project_id: str, request: UpdateProject
    ) -> ProjectDetail:
        row = self._project(project_id, request.expected_version)
        if request.name is not None:
            validate_metadata_text(request.name, "Project name")
        if request.description is not None:
            validate_metadata_text(request.description, "Project description")
        fields = request.model_dump(exclude_unset=True, exclude={"expected_version"})
        with self.database.connection() as conn:
            if request.brief_document_id:
                doc = self.documents.get_document(request.brief_document_id)
                if doc.content_type != "text/markdown":
                    raise ValidationError("Project brief must be Markdown")
                conn.execute(
                    "INSERT INTO project_documents "
                    "(project_id,document_id,role,created_at,source_revision_id) "
                    "VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING",
                    (project_id, doc.document_id, "note", utc_now(), doc.current_revision_id),
                )
            brief_id = fields.get("brief_document_id", row["brief_document_id"])
            active_id = fields.get("active_document_id", row["active_document_id"])
            if active_id:
                member = conn.execute(
                    "SELECT 1 FROM project_documents pd JOIN documents d "
                    "ON d.document_id=pd.document_id AND d.deleted=0 "
                    "WHERE pd.project_id=? AND pd.document_id=? AND pd.role='draft'",
                    (project_id, active_id),
                ).fetchone()
                if not member and "active_document_id" not in fields:
                    fields["active_document_id"] = None
                    active_id = None
                elif not member or active_id == brief_id:
                    raise ValidationError(
                        "Active draft must be a draft member distinct from the purpose brief"
                    )
            if (
                "active_document_id" in fields
                and active_id
                and "workbench_state_json" not in fields
                and row["workbench_state_json"]
            ):
                # Choosing a draft changes selection and keeps the saved sources and splits.
                layout = ProjectLayout.model_validate_json(
                    self.get_project(project_id, principal).workbench_state_json
                )
                group = next(
                    (g for g in layout.groups() if any(t.documentId == active_id for t in g.tabs)),
                    next(g for g in layout.groups() if g.id == layout.activeGroupId),
                )
                if not any(t.documentId == active_id for t in group.tabs):
                    document = self.documents.get_document(active_id)
                    group.tabs.append(
                        ProjectTab(documentId=active_id, title=document.title, pinned=False)
                    )
                group.activeTabId = active_id
                layout.activeGroupId = group.id
                fields["workbench_state_json"] = layout.model_dump_json()
            if request.active_thread_id:
                self._thread(principal, request.active_thread_id)
                if not conn.execute(
                    "SELECT 1 FROM project_threads WHERE project_id=? AND thread_id=?",
                    (project_id, request.active_thread_id),
                ).fetchone():
                    raise ValidationError("Active conversation must be a project member")
            if request.workbench_state_json:
                layout = ProjectLayout.model_validate_json(request.workbench_state_json)
                member_ids = {
                    d.document_id for d in self.get_project(project_id, principal).documents
                }
                if any(t.documentId not in member_ids for g in layout.groups() for t in g.tabs):
                    raise ValidationError("Layout tabs must be live project members")
                selected = next(
                    g.activeTabId for g in layout.groups() if g.id == layout.activeGroupId
                )
                if active_id and selected != active_id:
                    raise ValidationError("Layout selected tab must match the active draft")
                fields["workbench_state_json"] = layout.model_dump_json()
            if fields:
                conn.execute(
                    f"UPDATE projects SET {', '.join(f'{k}=?' for k in fields)} WHERE project_id=?",
                    (*fields.values(), project_id),
                )
        self._touch(project_id)
        self._audit(principal, "update", project_id)
        return self.get_project(project_id, principal)

    @atomic
    def delete_project(self, principal: Principal, project_id: str) -> None:
        self._project(project_id)
        with self.database.connection() as conn:
            conn.execute("DELETE FROM projects WHERE project_id=?", (project_id,))
        self._audit(principal, "delete", project_id)

    @atomic
    def add_document(
        self, principal: Principal, project_id: str, request: AddProjectDocument
    ) -> ProjectDocumentItem:
        project = self._project(project_id)
        doc = self.documents.get_document(request.document_id)
        validate_metadata_text(request.notes, "Document notes")
        with self.database.connection() as conn:
            conn.execute(
                """INSERT INTO project_documents
                    (project_id,document_id,role,pinned_page,notes,created_at,source_revision_id)
                VALUES (?,?,?,?,?,?,?) ON CONFLICT(project_id,document_id) DO NOTHING""",
                (
                    project_id,
                    doc.document_id,
                    request.role,
                    request.pinned_page,
                    request.notes,
                    utc_now(),
                    doc.current_revision_id,
                ),
            )
            if (
                request.role == "draft"
                and not project["active_document_id"]
                and doc.document_id != project["brief_document_id"]
            ):
                conn.execute(
                    "UPDATE projects SET active_document_id=? WHERE project_id=?",
                    (doc.document_id, project_id),
                )
        self._touch(project_id)
        self._audit(principal, "add_document", project_id)
        return next(
            d
            for d in self.get_project(project_id, principal).documents
            if d.document_id == doc.document_id
        )

    @atomic
    def update_document(
        self,
        principal: Principal,
        project_id: str,
        document_id: str,
        request: UpdateProjectDocument,
    ) -> ProjectDocumentItem:
        self._project(project_id, request.expected_version)
        self.documents.get_document(document_id)
        if not any(
            d.document_id == document_id for d in self.get_project(project_id, principal).documents
        ):
            raise NotFoundError("Document is not a project member")
        if request.notes is not None:
            validate_metadata_text(request.notes, "Document notes")
        fields = request.model_dump(exclude_unset=True, exclude={"expected_version"})
        if "role" in fields and fields["role"] is None:
            raise ValidationError("Role cannot be cleared")
        with self.database.connection() as conn:
            if (
                request.source_revision_id
                and not conn.execute(
                    "SELECT 1 FROM revisions WHERE revision_id=? AND document_id=?",
                    (request.source_revision_id, document_id),
                ).fetchone()
            ):
                raise ValidationError("Source revision belongs to another document")
            if fields:
                conn.execute(
                    f"UPDATE project_documents SET {', '.join(f'{k}=?' for k in fields)} "
                    "WHERE project_id=? AND document_id=?",
                    (*fields.values(), project_id, document_id),
                )
            if "role" in fields and fields["role"] != "draft":
                conn.execute(
                    "UPDATE projects SET active_document_id=NULL "
                    "WHERE project_id=? AND active_document_id=?",
                    (project_id, document_id),
                )
        self._touch(project_id)
        self._audit(principal, "update_document", project_id)
        return next(
            d
            for d in self.get_project(project_id, principal).documents
            if d.document_id == document_id
        )

    @atomic
    def remove_document(self, principal: Principal, project_id: str, document_id: str) -> None:
        self._project(project_id)
        with self.database.connection() as conn:
            conn.execute(
                "DELETE FROM project_documents WHERE project_id=? AND document_id=?",
                (project_id, document_id),
            )
            conn.execute(
                """DELETE FROM project_annotations WHERE project_id=? AND annotation_id IN
                (SELECT annotation_id FROM annotations WHERE document_id=?)""",
                (project_id, document_id),
            )
            conn.execute(
                "UPDATE projects SET brief_document_id=NULL "
                "WHERE project_id=? AND brief_document_id=?",
                (project_id, document_id),
            )
            conn.execute(
                "UPDATE projects SET active_document_id=NULL "
                "WHERE project_id=? AND active_document_id=?",
                (project_id, document_id),
            )
        self._touch(project_id)
        self._audit(principal, "remove_document", project_id)

    @atomic
    def add_thread(
        self, principal: Principal, project_id: str, request: AddProjectThread
    ) -> ProjectThreadItem:
        self._project(project_id)
        thread = self._thread(principal, request.thread_id)
        with self.database.connection() as conn:
            conn.execute(
                "INSERT INTO project_threads VALUES (?,?,?) ON CONFLICT DO NOTHING",
                (project_id, request.thread_id, utc_now()),
            )
            conn.execute(
                "UPDATE projects SET active_thread_id=COALESCE(active_thread_id,?) "
                "WHERE project_id=?",
                (request.thread_id, project_id),
            )
        self._touch(project_id)
        self._audit(principal, "add_thread", project_id)
        return ProjectThreadItem(
            project_id=project_id,
            thread_id=request.thread_id,
            title=self._thread_title(thread["data_json"]),
            created_at=utc_now(),
        )

    @atomic
    def remove_thread(self, principal: Principal, project_id: str, thread_id: str) -> None:
        self._project(project_id)
        with self.database.connection() as conn:
            conn.execute(
                "DELETE FROM project_threads WHERE project_id=? AND thread_id=?",
                (project_id, thread_id),
            )
            conn.execute(
                "UPDATE projects SET active_thread_id=NULL "
                "WHERE project_id=? AND active_thread_id=?",
                (project_id, thread_id),
            )
        self._touch(project_id)
        self._audit(principal, "remove_thread", project_id)

    @atomic
    def add_annotation(
        self, principal: Principal, project_id: str, request: AddProjectAnnotation
    ) -> ProjectAnnotationItem:
        self._project(project_id)
        with self.database.connection() as conn:
            row = conn.execute(
                "SELECT document_id FROM annotations WHERE annotation_id=? AND deleted=0",
                (request.annotation_id,),
            ).fetchone()
            if row is None:
                raise NotFoundError("Annotation was not found")
            self.documents.get_document(row["document_id"])
            if not conn.execute(
                "SELECT 1 FROM project_documents WHERE project_id=? AND document_id=?",
                (project_id, row["document_id"]),
            ).fetchone():
                raise ValidationError("Attach the annotation source document first")
            conn.execute(
                "INSERT INTO project_annotations VALUES (?,?,?) ON CONFLICT DO NOTHING",
                (project_id, request.annotation_id, utc_now()),
            )
        self._touch(project_id)
        self._audit(principal, "add_annotation", project_id)
        return next(
            a
            for a in self.get_project(project_id, principal).annotations
            if a.annotation_id == request.annotation_id
        )

    @atomic
    def remove_annotation(self, principal: Principal, project_id: str, annotation_id: str) -> None:
        self._project(project_id)
        with self.database.connection() as conn:
            conn.execute(
                "DELETE FROM project_annotations WHERE project_id=? AND annotation_id=?",
                (project_id, annotation_id),
            )
        self._touch(project_id)
        self._audit(principal, "remove_annotation", project_id)
