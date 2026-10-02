from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, Response, status
from pydantic import BaseModel

from sangam.authorization import AuthorizationPolicy
from sangam.projects import DeletedProjectReference, ProjectService
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
M = TypeVar("M", bound=BaseModel)


def create_projects_router(
    *,
    projects: ProjectService,
    resolve_principal: PrincipalResolver,
) -> APIRouter:
    """Build the Project Home and Workbench State API."""
    router = APIRouter(prefix="/api/v1/projects", tags=["projects"])

    resolved_principal = Depends(resolve_principal)

    def administrator(principal: Principal = resolved_principal) -> Principal:
        AuthorizationPolicy.require_administrator(principal)
        return principal

    def mutation_key(key: str | None = Header(default=None, alias="Idempotency-Key")) -> str:
        return key or str(uuid4())

    principal_dependency = Depends(administrator)
    key_dependency = Depends(mutation_key)

    def mutate(
        principal: Principal,
        key: str,
        operation: str,
        body: BaseModel,
        response_type: type[M],
        mutation: Callable[[], M],
    ) -> M:
        return projects.execute(
            principal,
            key=key,
            operation=operation,
            payload=body.model_dump(exclude_unset=True),
            response_type=response_type,
            mutation=mutation,
        )

    def remove(
        principal: Principal, key: str, operation: str, mutation: Callable[[], None]
    ) -> None:
        def run() -> DeletedProjectReference:
            mutation()
            return DeletedProjectReference()

        mutate(principal, key, operation, DeletedProjectReference(), DeletedProjectReference, run)

    @router.get("", response_model=list[ProjectSummary])
    def list_projects(_principal: Principal = principal_dependency) -> list[ProjectSummary]:
        return projects.list_projects(_principal)

    @router.get("/available-threads", response_model=list[ProjectThreadItem])
    def available_threads(principal: Principal = principal_dependency) -> list[ProjectThreadItem]:
        return projects.available_threads(principal)

    @router.post("", response_model=ProjectDetail, status_code=status.HTTP_201_CREATED)
    def create_project(
        body: CreateProject,
        principal: Principal = principal_dependency,
        key: str = key_dependency,
    ) -> ProjectDetail:
        return projects.create_project_once(principal, key, body)

    @router.get("/{project_id}", response_model=ProjectDetail)
    def get_project(
        project_id: str,
        _principal: Principal = principal_dependency,
    ) -> ProjectDetail:
        return projects.get_project(project_id, _principal)

    @router.patch("/{project_id}", response_model=ProjectDetail)
    def update_project(
        project_id: str,
        body: UpdateProject,
        principal: Principal = principal_dependency,
        key: str = key_dependency,
    ) -> ProjectDetail:
        return mutate(
            principal,
            key,
            f"project:update:{project_id}",
            body,
            ProjectDetail,
            lambda: projects.update_project(principal, project_id, body),
        )

    @router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_project(
        project_id: str,
        principal: Principal = principal_dependency,
        key: str = key_dependency,
    ) -> Response:
        remove(
            principal,
            key,
            f"project:delete:{project_id}",
            lambda: projects.delete_project(principal, project_id),
        )
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
        key: str = key_dependency,
    ) -> ProjectDocumentItem:
        return projects.add_document_once(principal, key, project_id, body)

    @router.patch("/{project_id}/documents/{document_id}", response_model=ProjectDocumentItem)
    def update_project_document(
        project_id: str,
        document_id: str,
        body: UpdateProjectDocument,
        principal: Principal = principal_dependency,
        key: str = key_dependency,
    ) -> ProjectDocumentItem:
        return mutate(
            principal,
            key,
            f"project:update-document:{project_id}:{document_id}",
            body,
            ProjectDocumentItem,
            lambda: projects.update_document(principal, project_id, document_id, body),
        )

    @router.delete("/{project_id}/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
    def remove_project_document(
        project_id: str,
        document_id: str,
        principal: Principal = principal_dependency,
        key: str = key_dependency,
    ) -> Response:
        projects.remove_document_once(principal, key, project_id, document_id)
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
        key: str = key_dependency,
    ) -> ProjectThreadItem:
        return mutate(
            principal,
            key,
            f"project:add-thread:{project_id}",
            body,
            ProjectThreadItem,
            lambda: projects.add_thread(principal, project_id, body),
        )

    @router.delete("/{project_id}/threads/{thread_id}", status_code=status.HTTP_204_NO_CONTENT)
    def remove_project_thread(
        project_id: str,
        thread_id: str,
        principal: Principal = principal_dependency,
        key: str = key_dependency,
    ) -> Response:
        remove(
            principal,
            key,
            f"project:remove-thread:{project_id}:{thread_id}",
            lambda: projects.remove_thread(principal, project_id, thread_id),
        )
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
        key: str = key_dependency,
    ) -> ProjectAnnotationItem:
        return mutate(
            principal,
            key,
            f"project:add-annotation:{project_id}",
            body,
            ProjectAnnotationItem,
            lambda: projects.add_annotation(principal, project_id, body),
        )

    @router.delete(
        "/{project_id}/annotations/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT
    )
    def remove_project_annotation(
        project_id: str,
        annotation_id: str,
        principal: Principal = principal_dependency,
        key: str = key_dependency,
    ) -> Response:
        remove(
            principal,
            key,
            f"project:remove-annotation:{project_id}:{annotation_id}",
            lambda: projects.remove_annotation(principal, project_id, annotation_id),
        )
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
