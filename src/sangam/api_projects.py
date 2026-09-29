from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Depends, Query

from sangam.projects import ProjectService
from sangam.schemas import (
    AddProjectDocument,
    CreateProject,
    Project,
    ProjectDocument,
    UpdateProject,
)
from sangam.security import Principal

PrincipalResolver = Callable[..., Principal]


def create_projects_router(
    *, projects: ProjectService, require_principal: PrincipalResolver
) -> APIRouter:
    """Build the Phase 7 / Issue 306 lightweight project REST API."""
    router = APIRouter(prefix="/api/v1/projects", tags=["projects"])
    principal_dependency = Depends(require_principal)

    @router.get("", response_model=list[Project])
    def list_projects(
        include_archived: bool = Query(default=False),
        _principal: Principal = principal_dependency,
    ) -> list[Project]:
        return projects.list_projects(include_archived=include_archived)

    @router.post("", response_model=Project, status_code=201)
    def create_project(
        body: CreateProject,
        _principal: Principal = principal_dependency,
    ) -> Project:
        return projects.create_project(
            name=body.name,
            description=body.description,
            primary_document_id=body.primary_document_id,
            resume_hint=body.resume_hint,
            document_ids=body.document_ids,
        )

    @router.get("/{project_id}", response_model=Project)
    def get_project(
        project_id: str,
        _principal: Principal = principal_dependency,
    ) -> Project:
        return projects.get_project(project_id)

    @router.patch("/{project_id}", response_model=Project)
    def update_project(
        project_id: str,
        body: UpdateProject,
        _principal: Principal = principal_dependency,
    ) -> Project:
        return projects.update_project(
            project_id,
            expected_metadata_version=body.expected_metadata_version,
            name=body.name,
            description=body.description,
            primary_document_id=body.primary_document_id,
            resume_hint=body.resume_hint,
            archived=body.archived,
        )

    @router.delete("/{project_id}", status_code=204)
    def delete_project(
        project_id: str,
        _principal: Principal = principal_dependency,
    ) -> None:
        projects.delete_project(project_id)

    @router.post("/{project_id}/documents", response_model=ProjectDocument, status_code=201)
    def add_project_document(
        project_id: str,
        body: AddProjectDocument,
        _principal: Principal = principal_dependency,
    ) -> ProjectDocument:
        return projects.add_project_document(
            project_id,
            document_id=body.document_id,
            role=body.role,
            context_summary=body.context_summary,
            resume_hint=body.resume_hint,
        )

    @router.delete("/{project_id}/documents/{document_id}", status_code=204)
    def remove_project_document(
        project_id: str,
        document_id: str,
        _principal: Principal = principal_dependency,
    ) -> None:
        projects.remove_project_document(project_id, document_id)

    return router
