from __future__ import annotations

import uuid
from collections.abc import Callable

from fastapi import APIRouter, Depends, Header
from pydantic import BaseModel, Field

from sangam.capture import CaptureService
from sangam.schemas import Document
from sangam.security import Principal

PrincipalResolver = Callable[..., Principal]


class CaptureUrlRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    title: str | None = Field(default=None, max_length=240)
    path: str | None = Field(default=None, max_length=500)
    project_id: str | None = Field(default=None, max_length=100)


def create_capture_router(
    *,
    capture: CaptureService,
    require_administrator: PrincipalResolver,
) -> APIRouter:
    """Build the admin-only SSRF-guarded URL capture API."""
    router = APIRouter(prefix="/api/v1/captures", tags=["captures"])
    admin_dependency = Depends(require_administrator)

    @router.post("/url", response_model=Document, status_code=201)
    def capture_url(
        body: CaptureUrlRequest,
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        principal: Principal = admin_dependency,
    ) -> Document:
        key = idempotency_key or f"capture-{uuid.uuid4().hex}"
        return capture.capture_url(
            principal,
            url=body.url,
            title=body.title,
            path=body.path,
            project_id=body.project_id,
            idempotency_key=key,
        )

    return router
