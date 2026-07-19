from __future__ import annotations

from collections.abc import Callable
from urllib.parse import quote

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Query, Request
from fastapi.responses import Response

from sangam.access import WorkspaceAccessService
from sangam.errors import ValidationError
from sangam.pdf_research import PdfResearchService
from sangam.schemas import (
    Annotation,
    AnnotationEvent,
    CreateAnnotation,
    Document,
    PdfPage,
    PdfSearchResult,
    UpdateAnnotation,
)
from sangam.security import Principal

PrincipalResolver = Callable[..., Principal]


def _parse_byte_range(value: str, size: int) -> tuple[int, int]:
    if not value.startswith("bytes=") or "," in value:
        raise ValidationError("Only one byte range is supported")
    raw_start, separator, raw_end = value[6:].partition("-")
    if not separator:
        raise ValidationError("Invalid PDF byte range")
    try:
        if raw_start:
            start = int(raw_start)
            end = int(raw_end) if raw_end else size - 1
        else:
            suffix_length = int(raw_end)
            if suffix_length <= 0:
                raise ValueError
            start = max(0, size - suffix_length)
            end = size - 1
    except ValueError as error:
        raise ValidationError("Invalid PDF byte range") from error
    if start < 0 or start >= size or end < start:
        raise ValidationError("PDF byte range is outside the document")
    return start, min(end, size - 1)


def create_pdf_router(
    *,
    workspace: WorkspaceAccessService,
    pdf_research: PdfResearchService,
    resolve_principal: PrincipalResolver,
    require_administrator: PrincipalResolver,
) -> APIRouter:
    """Build the Phase 5 PDF API while preserving the shared access boundary."""
    router = APIRouter(prefix="/api/v1")
    principal_dependency = Depends(resolve_principal)
    admin_dependency = Depends(require_administrator)

    @router.post("/pdfs", response_model=Document, status_code=201)
    async def import_pdf(
        request: Request,
        background_tasks: BackgroundTasks,
        title: str = Query(min_length=1, max_length=240),
        path: str = Query(min_length=1, max_length=500),
        supersedes_document_id: str | None = Query(default=None),
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Document:
        content_type = request.headers.get("content-type", "").split(";", 1)[0].casefold()
        if content_type != "application/pdf":
            raise ValidationError("PDF imports require Content-Type: application/pdf")
        content = await request.body()
        document = workspace.import_pdf(
            principal,
            title=title,
            path=path,
            content=content,
            supersedes_document_id=supersedes_document_id,
            idempotency_key=idempotency_key,
        )
        background_tasks.add_task(pdf_research.extract_text, document.document_id)
        return document

    @router.get("/pdfs/{document_id}/content")
    def pdf_content(
        document_id: str,
        range_header: str | None = Header(default=None, alias="Range"),
        principal: Principal = principal_dependency,
    ) -> Response:
        document, content = workspace.pdf_bytes(principal, document_id)
        common_headers = {
            "Accept-Ranges": "bytes",
            "Content-Disposition": (
                "inline; filename*=UTF-8''" + quote(document.path.rsplit("/", 1)[-1])
            ),
            "Cache-Control": "private, no-store",
        }
        if not range_header:
            return Response(
                content=content,
                media_type="application/pdf",
                headers={**common_headers, "Content-Length": str(len(content))},
            )
        start, end = _parse_byte_range(range_header, len(content))
        return Response(
            status_code=206,
            content=content[start : end + 1],
            media_type="application/pdf",
            headers={
                **common_headers,
                "Content-Range": f"bytes {start}-{end}/{len(content)}",
                "Content-Length": str(end - start + 1),
            },
        )

    @router.get("/pdfs/{document_id}/pages", response_model=list[PdfPage])
    def pdf_pages(document_id: str, principal: Principal = principal_dependency) -> list[PdfPage]:
        return workspace.pdf_pages(principal, document_id)

    @router.get("/pdfs/{document_id}/search", response_model=list[PdfSearchResult])
    def search_pdf_pages(
        document_id: str,
        q: str = Query(min_length=1, max_length=500),
        principal: Principal = principal_dependency,
    ) -> list[PdfSearchResult]:
        return workspace.search_pdf_pages(principal, document_id, q)

    @router.post("/pdfs/{document_id}/extract", response_model=Document)
    def retry_pdf_extraction(
        document_id: str,
        background_tasks: BackgroundTasks,
        principal: Principal = admin_dependency,
    ) -> Document:
        del principal
        document = pdf_research.retry_extraction(document_id)
        background_tasks.add_task(pdf_research.extract_text, document_id)
        return document

    @router.get("/pdfs/{document_id}/annotations", response_model=list[Annotation])
    def list_annotations(
        document_id: str,
        page_number: int | None = Query(default=None, ge=1),
        q: str = Query(default="", max_length=500),
        include_deleted: bool = Query(default=False),
        principal: Principal = principal_dependency,
    ) -> list[Annotation]:
        return workspace.list_annotations(
            principal,
            document_id,
            page_number=page_number,
            query=q,
            include_deleted=include_deleted,
        )

    @router.post(
        "/pdfs/{document_id}/annotations",
        response_model=Annotation,
        status_code=201,
    )
    def create_annotation(
        document_id: str,
        body: CreateAnnotation,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Annotation:
        return workspace.create_annotation(
            principal,
            document_id=document_id,
            page_number=body.page_number,
            annotation_type=body.annotation_type,
            selected_text=body.selected_text,
            note=body.note,
            geometry=body.geometry,
            tags=body.tags,
            color=body.color,
            idempotency_key=idempotency_key,
        )

    @router.patch("/annotations/{annotation_id}", response_model=Annotation)
    def update_annotation(
        annotation_id: str,
        body: UpdateAnnotation,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Annotation:
        return workspace.update_annotation(
            principal,
            annotation_id=annotation_id,
            expected_version=body.expected_version,
            selected_text=body.selected_text,
            note=body.note,
            geometry=body.geometry,
            tags=body.tags,
            color=body.color,
            idempotency_key=idempotency_key,
        )

    @router.delete("/annotations/{annotation_id}", response_model=Annotation)
    def delete_annotation(
        annotation_id: str,
        expected_version: int = Query(ge=1),
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Annotation:
        return workspace.delete_annotation(
            principal,
            annotation_id=annotation_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
        )

    @router.get(
        "/annotations/{annotation_id}/history",
        response_model=list[AnnotationEvent],
    )
    def annotation_history(
        annotation_id: str, principal: Principal = principal_dependency
    ) -> list[AnnotationEvent]:
        return workspace.annotation_history(principal, annotation_id)

    return router
