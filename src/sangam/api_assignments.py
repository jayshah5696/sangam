from collections.abc import Callable

from fastapi import APIRouter, Depends, Header

from sangam.assignments import (
    Assignment,
    AssignmentControl,
    AssignmentService,
    CreateAssignment,
    ProjectBriefing,
    RefreshProposal,
)
from sangam.security import Principal


def create_assignments_router(
    service: AssignmentService, resolve_principal: Callable[..., Principal]
) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["assignments"])
    principal_dependency = Depends(resolve_principal)

    @router.post("/projects/{project_id}/assignments", response_model=Assignment, status_code=201)
    def create(
        project_id: str,
        body: CreateAssignment,
        principal: Principal = principal_dependency,
        key: str = Header(alias="Idempotency-Key", max_length=200),
    ) -> Assignment:
        return service.create(principal, project_id, body, key)

    @router.get("/projects/{project_id}/assignments", response_model=list[Assignment])
    def assignments(
        project_id: str, principal: Principal = principal_dependency
    ) -> list[Assignment]:
        return service.list_for_project(principal, project_id)

    @router.get("/assignments/{assignment_id}", response_model=Assignment)
    def get(assignment_id: str, principal: Principal = principal_dependency) -> Assignment:
        return service.get(principal, assignment_id)

    @router.post("/assignments/{assignment_id}/control", response_model=Assignment)
    def control(
        assignment_id: str,
        body: AssignmentControl,
        principal: Principal = principal_dependency,
        key: str = Header(alias="Idempotency-Key", max_length=200),
    ) -> Assignment:
        return service.control(principal, assignment_id, body.action, body.content, key)

    @router.post(
        "/chat/proposals/{proposal_id}/refresh", response_model=Assignment, status_code=201
    )
    def refresh(
        proposal_id: str,
        body: RefreshProposal,
        principal: Principal = principal_dependency,
        key: str = Header(alias="Idempotency-Key", max_length=200),
    ) -> Assignment:
        return service.refresh(principal, proposal_id, body, key)

    @router.get("/chat/proposals/{proposal_id}/refresh", response_model=list[Assignment])
    def refresh_history(
        proposal_id: str, principal: Principal = principal_dependency
    ) -> list[Assignment]:
        return service.list_for_proposal(principal, proposal_id)

    @router.get("/projects/{project_id}/briefing", response_model=ProjectBriefing)
    def briefing(project_id: str, principal: Principal = principal_dependency) -> ProjectBriefing:
        return service.briefing(principal, project_id)

    @router.post("/projects/{project_id}/visits", response_model=ProjectBriefing)
    def visit(
        project_id: str,
        principal: Principal = principal_dependency,
        key: str = Header(alias="Idempotency-Key", max_length=200),
    ) -> ProjectBriefing:
        return service.briefing(principal, project_id, visit_key=key)

    return router
