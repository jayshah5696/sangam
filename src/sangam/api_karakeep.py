from __future__ import annotations

from collections.abc import Callable

from fastapi import APIRouter, Depends, Header, Query

from sangam.karakeep import KarakeepService
from sangam.schemas import (
    ApplyKarakeepRefresh,
    ImportKarakeepBookmark,
    KarakeepBookmarkPage,
    KarakeepConnection,
    KarakeepImport,
    KarakeepImportDetail,
)
from sangam.security import Principal

PrincipalResolver = Callable[..., Principal]


def create_karakeep_router(
    *, karakeep: KarakeepService, require_administrator: PrincipalResolver
) -> APIRouter:
    """Build the human-admin Phase 6 import and refresh API."""
    router = APIRouter(prefix="/api/v1/karakeep", tags=["karakeep"])
    admin_dependency = Depends(require_administrator)

    @router.get("/health", response_model=KarakeepConnection)
    def health(_principal: Principal = admin_dependency) -> KarakeepConnection:
        return karakeep.connection_health()

    @router.get("/bookmarks", response_model=KarakeepBookmarkPage)
    def search_bookmarks(
        q: str = Query(min_length=1, max_length=500),
        limit: int = Query(default=30, ge=1, le=100),
        cursor: str | None = Query(default=None, max_length=1000),
        _principal: Principal = admin_dependency,
    ) -> KarakeepBookmarkPage:
        return karakeep.search_bookmarks(query=q, limit=limit, cursor=cursor)

    @router.get("/imports", response_model=list[KarakeepImport])
    def list_imports(_principal: Principal = admin_dependency) -> list[KarakeepImport]:
        return karakeep.list_imports()

    @router.get("/imports/by-document/{document_id}", response_model=KarakeepImportDetail)
    def document_import(
        document_id: str, _principal: Principal = admin_dependency
    ) -> KarakeepImportDetail:
        return karakeep.get_document_import(document_id)

    @router.get("/imports/{import_id}", response_model=KarakeepImportDetail)
    def import_detail(
        import_id: str, _principal: Principal = admin_dependency
    ) -> KarakeepImportDetail:
        return karakeep.get_import(import_id)

    @router.post("/imports", response_model=KarakeepImportDetail, status_code=201)
    def import_bookmark(
        body: ImportKarakeepBookmark,
        _idempotency_key: str = Header(alias="Idempotency-Key"),
        _principal: Principal = admin_dependency,
    ) -> KarakeepImportDetail:
        return karakeep.import_bookmark(body.bookmark_id)

    @router.post("/imports/{import_id}/refresh", response_model=KarakeepImportDetail)
    def refresh_import(
        import_id: str,
        _idempotency_key: str = Header(alias="Idempotency-Key"),
        _principal: Principal = admin_dependency,
    ) -> KarakeepImportDetail:
        return karakeep.refresh_import(import_id)

    @router.post("/imports/{import_id}/apply", response_model=KarakeepImportDetail)
    def apply_refresh(
        import_id: str,
        body: ApplyKarakeepRefresh,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = admin_dependency,
    ) -> KarakeepImportDetail:
        return karakeep.apply_refresh(
            import_id=import_id,
            expected_revision_id=body.expected_revision_id,
            content=body.content,
            actor_id=principal.actor_id,
            idempotency_key=idempotency_key,
        )

    return router
