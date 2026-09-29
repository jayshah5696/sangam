from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Depends, Response, status

from sangam.projects import ProjectService
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

PrincipalResolver = Callable[..., Principal]


def create_projects_router(
    *,
    projects: ProjectService,
    resolve_principal: PrincipalResolver,
) -> APIRouter:
    """Build the Project Home and Workbench State API."""
    router = APIRouter(prefix="/api/v1/projects", tags=["projects"])
    principal_dependency = Depends(resolve_principal)

    @router.get("", response_model=list[ProjectSummary])
    def list_projects(_principal: Principal = principal_dependency) -> list[ProjectSummary]:
        return projects.list_projects()

    @router.post("", response_model=ProjectDetail, status_code=status.HTTP_201_CREATED)
    def create_project(
        body: CreateProject,
        principal: Principal = principal_dependency,
    ) -> ProjectDetail:
        return projects.create_project(principal, body)

    @router.get("/{project_id}", response_model=ProjectDetail)
    def get_project(
        project_id: str,
        _principal: Principal = principal_dependency,
    ) -> ProjectDetail:
        return projects.get_project(project_id)

    @router.patch("/{project_id}", response_model=ProjectDetail)
    def update_project(
        project_id: str,
        body: UpdateProject,
        principal: Principal = principal_dependency,
    ) -> ProjectDetail:
        return projects.update_project(principal, project_id, body)

    @router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_project(
        project_id: str,
        principal: Principal = principal_dependency,
    ) -> Response:
        projects.delete_project(principal, project_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/{project_id}/documents",
        response_model=ProjectDocumentItem,
        status_code=status.HTTP_201_CREATED,
    )
    def add_project_document(
        project_id: str,
        body: AddProjectDocument,
        principal: Principal = principal_dependency,
    ) -> ProjectDocumentItem:
        return projects.add_document(principal, project_id, body)

    @router.patch("/{project_id}/documents/{document_id}", response_model=ProjectDocumentItem)
    def update_project_document(
        project_id: str,
        document_id: str,
        body: UpdateProjectDocument,
        principal: Principal = principal_dependency,
    ) -> ProjectDocumentItem:
        return projects.update_document(principal, project_id, document_id, body)

    @router.delete("/{project_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
    def remove_project_document(
        project_id: str,
        document_id: str,
        principal: Principal = principal_dependency,
    ) -> Response:
        projects.remove_document(principal, project_id, document_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/{project_id}/threads",
        response_model=ProjectThreadItem,
        status_code=status.HTTP_201_CREATED,
    )
    def add_project_thread(
        project_id: str,
        body: AddProjectThread,
        principal: Principal = principal_dependency,
    ) -> ProjectThreadItem:
        return projects.add_thread(principal, project_id, body)

    @router.delete("/{project_id}/threads/{thread_id}", status_code=status.HTTP_204_NO_CONTENT)
    def remove_project_thread(
        project_id: str,
        thread_id: str,
        principal: Principal = principal_dependency,
    ) -> Response:
        projects.remove_thread(principal, project_id, thread_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/{project_id}/annotations",
        response_model=ProjectAnnotationItem,
        status_code=status.HTTP_201_CREATED,
    )
    def add_project_annotation(
        project_id: str,
        body: AddProjectAnnotation,
        principal: Principal = principal_dependency,
    ) -> ProjectAnnotationItem:
        return projects.add_annotation(principal, project_id, body)

    @router.delete(
        "/{project_id}/annotations/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT
    )
    def remove_project_annotation(
        project_id: str,
        annotation_id: str,
        principal: Principal = principal_dependency,
    ) -> Response:
        projects.remove_annotation(principal, project_id, annotation_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
