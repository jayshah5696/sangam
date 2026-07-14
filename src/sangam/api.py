from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from sangam.config import Settings
from sangam.errors import (
    ConflictError,
    IdempotencyError,
    InvalidPathError,
    MaterializationError,
    NotFoundError,
    SangamError,
    ValidationError,
)
from sangam.schemas import (
    CreateDocument,
    CreateFolder,
    CreateTag,
    DeleteDocument,
    Document,
    Folder,
    PathMutation,
    ReconciliationReport,
    ReindexPath,
    RestoreDocument,
    Revision,
    Tag,
    UpdateDocument,
    UpdateDocumentMetadata,
    UpdateFolderMetadata,
)
from sangam.service import DocumentService

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or Settings()
    service = DocumentService(resolved_settings)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        try:
            application.state.startup_reconciliation = service.reconcile()
        except MaterializationError as error:
            logger.exception("Startup materialization remains pending: %s", error.message)
            application.state.startup_reconciliation_error = error
        yield

    app = FastAPI(
        title="Sangam API",
        version="0.1.0",
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
        lifespan=lifespan,
    )
    app.state.service = service
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(SangamError)
    async def handle_sangam_error(_request: Request, error: SangamError) -> JSONResponse:
        status = 500
        if isinstance(error, NotFoundError):
            status = 404
        elif isinstance(error, (ConflictError, IdempotencyError)):
            status = 409
        elif isinstance(error, (InvalidPathError, ValidationError)):
            status = 422
        elif isinstance(error, MaterializationError):
            status = 503
        return JSONResponse(
            status_code=status,
            content={
                "error": {
                    "code": error.code,
                    "message": error.message,
                    "details": error.details,
                }
            },
        )

    @app.get("/api/v1/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "version": "0.1.0"}

    @app.get("/api/v1/documents", response_model=list[Document])
    def list_documents(include_deleted: bool = Query(default=False)) -> list[Document]:
        return service.list_documents(include_deleted=include_deleted)

    @app.get("/api/v1/search", response_model=list[Document])
    def search_documents(
        q: str = Query(default="", max_length=500),
        tag_id: str | None = Query(default=None),
        category: str | None = Query(default=None, max_length=120),
    ) -> list[Document]:
        return service.search_documents(query=q, tag_id=tag_id, category=category)

    @app.get("/api/v1/tags", response_model=list[Tag])
    def list_tags() -> list[Tag]:
        return service.list_tags()

    @app.post("/api/v1/tags", response_model=Tag, status_code=201)
    def create_tag(
        body: CreateTag,
        actor_id: str = Header(default="human:jay", alias="X-Actor"),
    ) -> Tag:
        return service.create_tag(name=body.name, color=body.color, actor_id=actor_id)

    @app.get("/api/v1/folders", response_model=list[Folder])
    def list_folders() -> list[Folder]:
        return service.list_folders()

    @app.post("/api/v1/folders", response_model=Folder, status_code=201)
    def create_folder(
        body: CreateFolder,
        actor_id: str = Header(default="human:jay", alias="X-Actor"),
    ) -> Folder:
        return service.create_folder(
            path=body.path,
            category=body.category,
            tag_ids=body.tag_ids,
            actor_id=actor_id,
        )

    @app.patch("/api/v1/folders/{folder_id}", response_model=Folder)
    def update_folder_metadata(
        folder_id: str,
        body: UpdateFolderMetadata,
        actor_id: str = Header(default="human:jay", alias="X-Actor"),
    ) -> Folder:
        return service.update_folder_metadata(
            folder_id=folder_id,
            expected_metadata_version=body.expected_metadata_version,
            category=body.category,
            tag_ids=body.tag_ids,
            actor_id=actor_id,
        )

    @app.post("/api/v1/documents", response_model=Document, status_code=201)
    def create_document(
        body: CreateDocument,
        actor_id: str = Header(default="human:jay", alias="X-Actor"),
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> Document:
        return service.create_document(
            title=body.title,
            content=body.content,
            path=body.path,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    @app.get("/api/v1/documents/{document_id}", response_model=Document)
    def get_document(document_id: str) -> Document:
        return service.get_document(document_id)

    @app.patch("/api/v1/documents/{document_id}", response_model=Document)
    def update_document(
        document_id: str,
        body: UpdateDocument,
        actor_id: str = Header(default="human:jay", alias="X-Actor"),
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> Document:
        return service.update_document(
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            content=body.content,
            title=body.title,
            summary=body.summary,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    @app.patch("/api/v1/documents/{document_id}/metadata", response_model=Document)
    def update_document_metadata(
        document_id: str,
        body: UpdateDocumentMetadata,
        actor_id: str = Header(default="human:jay", alias="X-Actor"),
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> Document:
        return service.update_document_metadata(
            document_id=document_id,
            expected_metadata_version=body.expected_metadata_version,
            category=body.category,
            tag_ids=body.tag_ids,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    @app.post("/api/v1/documents/{document_id}/materialize", response_model=Document)
    def materialize_document(
        document_id: str,
        body: PathMutation,
        actor_id: str = Header(default="human:jay", alias="X-Actor"),
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> Document:
        return service.materialize_document(
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            path=body.path,
            summary=body.summary,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    @app.post("/api/v1/documents/{document_id}/move", response_model=Document)
    def move_document(
        document_id: str,
        body: PathMutation,
        actor_id: str = Header(default="human:jay", alias="X-Actor"),
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> Document:
        return service.move_document(
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            path=body.path,
            summary=body.summary,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    @app.delete("/api/v1/documents/{document_id}", response_model=Document)
    def delete_document(
        document_id: str,
        body: DeleteDocument,
        actor_id: str = Header(default="human:jay", alias="X-Actor"),
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> Document:
        return service.delete_document(
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            summary=body.summary,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    @app.get("/api/v1/documents/{document_id}/history", response_model=list[Revision])
    def history(document_id: str) -> list[Revision]:
        return service.history(document_id)

    @app.post("/api/v1/documents/{document_id}/restore", response_model=Document)
    def restore_document(
        document_id: str,
        body: RestoreDocument,
        actor_id: str = Header(default="human:jay", alias="X-Actor"),
        idempotency_key: str = Header(alias="Idempotency-Key"),
    ) -> Document:
        return service.restore_document(
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            revision_id=body.revision_id,
            summary=body.summary,
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )

    @app.get("/api/v1/reconciliation", response_model=ReconciliationReport)
    def reconciliation_status() -> ReconciliationReport:
        return ReconciliationReport(repaired_document_ids=[], conflicts=service.list_conflicts())

    @app.post("/api/v1/reconciliation/scan", response_model=ReconciliationReport)
    def reconciliation_scan() -> ReconciliationReport:
        return service.reconcile()

    @app.post("/api/v1/reconciliation/reindex", response_model=Document, status_code=201)
    def reconciliation_reindex(body: ReindexPath) -> Document:
        return service.reindex_path(body.path)

    @app.post("/api/v1/reconciliation/{conflict_id}/accept-disk", response_model=Document)
    def reconciliation_accept_disk(conflict_id: str) -> Document:
        return service.accept_disk_content(conflict_id)

    frontend_dist = resolved_settings.frontend_dist
    if frontend_dist.is_dir() and (frontend_dist / "index.html").is_file():
        assets = frontend_dist / "assets"
        if assets.is_dir():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{spa_path:path}", include_in_schema=False)
        def spa(spa_path: str) -> FileResponse:
            candidate = (frontend_dist / spa_path).resolve(strict=False)
            if candidate.is_file() and candidate.is_relative_to(frontend_dist.resolve()):
                return FileResponse(candidate)
            return FileResponse(frontend_dist / "index.html")

    return app
