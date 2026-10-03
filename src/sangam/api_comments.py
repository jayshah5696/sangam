from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Depends, Header, Query

from sangam.access import WorkspaceAccessService
from sangam.schemas import (
    CreateDocumentCommentRequest,
    DocumentComment,
    ResolveDocumentCommentRequest,
)
from sangam.security import Principal

PrincipalResolver = Callable[..., Principal]


def create_comments_router(
    *,
    workspace: WorkspaceAccessService,
    resolve_principal: PrincipalResolver,
) -> APIRouter:
    """Build the document comments API under the workspace access boundary."""
    router = APIRouter(prefix="/api/v1")
    principal_dependency = Depends(resolve_principal)

    @router.get(
        "/documents/{document_id}/comments",
        response_model=list[DocumentComment],
    )
    def list_comments(
        document_id: str,
        include_resolved: bool = Query(True),
        principal: Principal = principal_dependency,
    ) -> list[DocumentComment]:
        return workspace.list_comments(
            principal,
            document_id,
            include_resolved=include_resolved,
        )

    @router.post(
        "/documents/{document_id}/comments",
        response_model=DocumentComment,
        status_code=201,
    )
    def create_comment(
        document_id: str,
        request: CreateDocumentCommentRequest,
        idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> DocumentComment:
        return workspace.create_comment(
            principal,
            document_id,
            request,
            idempotency_key=idempotency_key,
        )

    @router.get(
        "/documents/{document_id}/comments/{comment_id}",
        response_model=DocumentComment,
    )
    def get_comment(
        document_id: str,
        comment_id: str,
        principal: Principal = principal_dependency,
    ) -> DocumentComment:
        return workspace.get_comment(
            principal,
            document_id,
            comment_id,
        )

    @router.post(
        "/documents/{document_id}/comments/{comment_id}/resolve",
        response_model=DocumentComment,
    )
    def resolve_comment(
        document_id: str,
        comment_id: str,
        request: ResolveDocumentCommentRequest,
        principal: Principal = principal_dependency,
    ) -> DocumentComment:
        return workspace.resolve_comment(
            principal,
            document_id,
            comment_id,
            request,
        )

    return router
