from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Depends, Response, status

from sangam.saved_views import SavedViewService
from sangam.schemas import SavedView, SaveView
from sangam.security import Principal


def create_saved_views_router(
    *, saved_views: SavedViewService, resolve_principal: Callable[..., Principal]
) -> APIRouter:
    """Saved searches for the workspace owner; saving the same name replaces the view."""
    router = APIRouter(prefix="/api/v1/saved-views", tags=["saved-views"])
    principal_dependency = Depends(resolve_principal)

    @router.get("", response_model=list[SavedView])
    def list_saved_views(principal: Principal = principal_dependency) -> list[SavedView]:
        return saved_views.list(principal)

    @router.post("", response_model=SavedView)
    def save_view(body: SaveView, principal: Principal = principal_dependency) -> SavedView:
        return saved_views.save(principal, body)

    @router.delete("/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_saved_view(view_id: str, principal: Principal = principal_dependency) -> Response:
        saved_views.delete(principal, view_id)
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    return router
