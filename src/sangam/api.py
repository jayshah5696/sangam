from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from sangam.application import build_application_services
from sangam.config import Settings
from sangam.errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    IdempotencyError,
    InvalidPathError,
    MaterializationError,
    NotFoundError,
    SangamError,
    ValidationError,
)
from sangam.schemas import (
    Actor,
    AgentToken,
    BackupSet,
    BackupVerification,
    CreateAgentToken,
    CreateDocument,
    CreateFolder,
    CreateTag,
    DeleteDocument,
    Document,
    DocumentSummary,
    DuplicateDocument,
    Folder,
    IssuedAgentToken,
    OperationEvent,
    PathMutation,
    ReconciliationReport,
    ReindexPath,
    RestoreDocument,
    Revision,
    RevisionDiff,
    Tag,
    UpdateDocument,
    UpdateDocumentMetadata,
    UpdateFolderMetadata,
)
from sangam.security import Principal

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or Settings()
    services = build_application_services(resolved_settings)
    documents = services.documents
    reconciliation = services.reconciliation
    backups = services.backups
    workspace = services.workspace_access
    identity = services.identity
    activity = services.activity
    authorization = services.authorization

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        try:
            application.state.startup_reconciliation = reconciliation.scan()
        except MaterializationError as error:
            logger.exception("Startup materialization remains pending: %s", error.message)
            application.state.startup_reconciliation_error = error

        async def maintain_backups() -> None:
            while True:
                try:
                    await asyncio.to_thread(backups.create_if_due)
                except Exception:
                    logger.exception("Scheduled backup failed")
                await asyncio.sleep(resolved_settings.backup_check_interval_seconds)

        backup_task: asyncio.Task[None] | None = None
        if resolved_settings.backups_enabled:
            backup_task = asyncio.create_task(maintain_backups())
        yield
        if backup_task:
            backup_task.cancel()
            with suppress(asyncio.CancelledError):
                await backup_task

    app = FastAPI(
        title="Sangam API",
        version="0.1.0",
        openapi_url="/api/v1/openapi.json",
        docs_url="/api/v1/docs",
        lifespan=lifespan,
    )
    app.state.services = services

    @app.middleware("http")
    async def operation_context(request: Request, call_next):
        request.state.operation_id = str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Operation-ID"] = request.state.operation_id
        return response

    def resolve_principal(
        request: Request,
        authorization_header: str | None = Header(default=None, alias="Authorization"),
    ) -> Principal:
        operation_id = request.state.operation_id
        if authorization_header:
            scheme, separator, credential = authorization_header.partition(" ")
            if not separator or scheme.casefold() != "bearer" or not credential:
                raise AuthenticationError("Authorization must use a Bearer token")
            return identity.authenticate(credential, operation_id=operation_id)
        if resolved_settings.auth_mode == "single_user":
            return Principal.trusted_human(operation_id=operation_id)
        asserted_identity = request.headers.get(resolved_settings.trusted_identity_header)
        if asserted_identity != resolved_settings.trusted_identity_value:
            raise AuthenticationError("A trusted human identity assertion is required")
        return Principal.trusted_human(operation_id=operation_id)

    principal_dependency = Depends(resolve_principal)

    def require_administrator(
        request: Request, principal: Principal = principal_dependency
    ) -> Principal:
        try:
            authorization.require_administrator(principal)
        except AuthorizationError as error:
            activity.record(
                principal=principal,
                action="admin",
                resource_type="administration",
                path=request.url.path,
                outcome="denied",
                error_code=error.code,
            )
            raise
        return principal

    admin_dependency = Depends(require_administrator)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(SangamError)
    async def handle_sangam_error(_request: Request, error: SangamError) -> JSONResponse:
        status = 500
        if isinstance(error, AuthenticationError):
            status = 401
        elif isinstance(error, AuthorizationError):
            status = 403
        elif isinstance(error, NotFoundError):
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

    @app.get("/api/v1/actors", response_model=list[Actor])
    def list_actors(_principal: Principal = admin_dependency) -> list[Actor]:
        return identity.list_actors()

    @app.get("/api/v1/agent-tokens", response_model=list[AgentToken])
    def list_agent_tokens(
        _principal: Principal = admin_dependency,
    ) -> list[AgentToken]:
        return identity.list_tokens()

    @app.post("/api/v1/agent-tokens", response_model=IssuedAgentToken, status_code=201)
    def issue_agent_token(
        body: CreateAgentToken,
        principal: Principal = admin_dependency,
    ) -> IssuedAgentToken:
        issued = identity.issue_agent_token(
            actor_id=body.actor_id,
            display_name=body.display_name,
            label=body.label,
            scopes=body.scopes,
            expires_at=body.expires_at,
        )
        activity.record(
            principal=principal,
            action="issue",
            resource_type="agent_token",
            resource_id=issued.token_id,
            outcome="accepted",
        )
        return issued

    @app.post("/api/v1/agent-tokens/{token_id}/rotate", response_model=IssuedAgentToken)
    def rotate_agent_token(
        token_id: str,
        principal: Principal = admin_dependency,
    ) -> IssuedAgentToken:
        issued = identity.rotate_token(token_id)
        activity.record(
            principal=principal,
            action="rotate",
            resource_type="agent_token",
            resource_id=issued.token_id,
            outcome="accepted",
        )
        return issued

    @app.delete("/api/v1/agent-tokens/{token_id}", response_model=AgentToken)
    def revoke_agent_token(
        token_id: str,
        principal: Principal = admin_dependency,
    ) -> AgentToken:
        revoked = identity.revoke_token(token_id)
        activity.record(
            principal=principal,
            action="revoke",
            resource_type="agent_token",
            resource_id=token_id,
            outcome="accepted",
        )
        return revoked

    @app.get("/api/v1/activity", response_model=list[OperationEvent])
    def list_activity(
        actor_id: str | None = Query(default=None, max_length=120),
        actor_kind: str | None = Query(
            default="agent", pattern="^(human|agent|integration|client|system)$"
        ),
        outcome: str | None = Query(default=None, pattern="^(accepted|denied|conflict|failed)$"),
        limit: int = Query(default=100, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        _principal: Principal = admin_dependency,
    ) -> list[OperationEvent]:
        return activity.list_events(
            actor_id=actor_id,
            actor_kind=actor_kind,
            outcome=outcome,
            limit=limit,
            offset=offset,
        )

    @app.get("/api/v1/documents", response_model=list[DocumentSummary])
    def list_documents(
        include_deleted: bool = Query(default=False),
        limit: int = Query(default=100, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        principal: Principal = principal_dependency,
    ) -> list[DocumentSummary]:
        return workspace.list_documents(
            principal, include_deleted=include_deleted, limit=limit, offset=offset
        )

    @app.get("/api/v1/search", response_model=list[DocumentSummary])
    def search_documents(
        q: str = Query(default="", max_length=500),
        tag_id: str | None = Query(default=None),
        category: str | None = Query(default=None, max_length=120),
        actor_id: str | None = Query(default=None, max_length=120),
        sort: str = Query(default="relevance", pattern="^(relevance|updated|title|path)$"),
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
        principal: Principal = principal_dependency,
    ) -> list[DocumentSummary]:
        return workspace.search_documents(
            principal,
            query=q,
            tag_id=tag_id,
            category=category,
            actor_id=actor_id,
            sort=sort,
            limit=limit,
            offset=offset,
        )

    @app.post("/api/v1/search/reindex")
    def rebuild_search_index(
        principal: Principal = principal_dependency,
    ) -> dict[str, int]:
        authorization.require_administrator(principal)
        return {"indexed_documents": documents.rebuild_search_index()}

    @app.get("/api/v1/tags", response_model=list[Tag])
    def list_tags(principal: Principal = principal_dependency) -> list[Tag]:
        return workspace.list_tags(principal)

    @app.post("/api/v1/tags", response_model=Tag, status_code=201)
    def create_tag(
        body: CreateTag,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Tag:
        return workspace.create_tag(
            principal,
            name=body.name,
            color=body.color,
            idempotency_key=idempotency_key,
        )

    @app.get("/api/v1/folders", response_model=list[Folder])
    def list_folders(principal: Principal = principal_dependency) -> list[Folder]:
        return workspace.list_folders(principal)

    @app.post("/api/v1/folders", response_model=Folder, status_code=201)
    def create_folder(
        body: CreateFolder,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Folder:
        return workspace.create_folder(
            principal,
            path=body.path,
            category=body.category,
            tag_ids=body.tag_ids,
            idempotency_key=idempotency_key,
        )

    @app.patch("/api/v1/folders/{folder_id}", response_model=Folder)
    def update_folder_metadata(
        folder_id: str,
        body: UpdateFolderMetadata,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Folder:
        return workspace.update_folder_metadata(
            principal,
            folder_id=folder_id,
            expected_metadata_version=body.expected_metadata_version,
            category=body.category,
            tag_ids=body.tag_ids,
            idempotency_key=idempotency_key,
        )

    @app.post("/api/v1/documents", response_model=Document, status_code=201)
    def create_document(
        body: CreateDocument,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Document:
        return workspace.create_document(
            principal,
            title=body.title,
            content=body.content,
            path=body.path,
            idempotency_key=idempotency_key,
        )

    @app.get("/api/v1/documents/{document_id}", response_model=Document)
    def get_document(document_id: str, principal: Principal = principal_dependency) -> Document:
        return workspace.get_document(principal, document_id)

    @app.patch("/api/v1/documents/{document_id}", response_model=Document)
    def update_document(
        document_id: str,
        body: UpdateDocument,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Document:
        return workspace.update_document(
            principal,
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            content=body.content,
            title=body.title,
            summary=body.summary,
            idempotency_key=idempotency_key,
        )

    @app.post("/api/v1/documents/{document_id}/duplicate", response_model=Document, status_code=201)
    def duplicate_document(
        document_id: str,
        body: DuplicateDocument,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Document:
        return workspace.duplicate_document(
            principal,
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            title=body.title,
            path=body.path,
            idempotency_key=idempotency_key,
        )

    @app.patch("/api/v1/documents/{document_id}/metadata", response_model=Document)
    def update_document_metadata(
        document_id: str,
        body: UpdateDocumentMetadata,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Document:
        return workspace.update_document_metadata(
            principal,
            document_id=document_id,
            expected_metadata_version=body.expected_metadata_version,
            category=body.category,
            tag_ids=body.tag_ids,
            idempotency_key=idempotency_key,
        )

    @app.post("/api/v1/documents/{document_id}/materialize", response_model=Document)
    def materialize_document(
        document_id: str,
        body: PathMutation,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Document:
        return workspace.materialize_document(
            principal,
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            path=body.path,
            summary=body.summary,
            idempotency_key=idempotency_key,
        )

    @app.post("/api/v1/documents/{document_id}/move", response_model=Document)
    def move_document(
        document_id: str,
        body: PathMutation,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Document:
        return workspace.move_document(
            principal,
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            path=body.path,
            summary=body.summary,
            idempotency_key=idempotency_key,
        )

    @app.delete("/api/v1/documents/{document_id}", response_model=Document)
    def delete_document(
        document_id: str,
        body: DeleteDocument,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Document:
        return workspace.delete_document(
            principal,
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            summary=body.summary,
            idempotency_key=idempotency_key,
        )

    @app.get("/api/v1/documents/{document_id}/history", response_model=list[Revision])
    def history(document_id: str, principal: Principal = principal_dependency) -> list[Revision]:
        return workspace.history(principal, document_id)

    @app.get("/api/v1/documents/{document_id}/diff", response_model=RevisionDiff)
    def revision_diff(
        document_id: str,
        from_revision_id: str = Query(),
        to_revision_id: str | None = Query(default=None),
        principal: Principal = principal_dependency,
    ) -> RevisionDiff:
        return workspace.revision_diff(
            principal,
            document_id=document_id,
            from_revision_id=from_revision_id,
            to_revision_id=to_revision_id,
        )

    @app.post("/api/v1/documents/{document_id}/restore", response_model=Document)
    def restore_document(
        document_id: str,
        body: RestoreDocument,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Document:
        return workspace.restore_document(
            principal,
            document_id=document_id,
            expected_revision_id=body.expected_revision_id,
            revision_id=body.revision_id,
            summary=body.summary,
            idempotency_key=idempotency_key,
        )

    @app.get("/api/v1/reconciliation", response_model=ReconciliationReport)
    def reconciliation_status(
        _principal: Principal = admin_dependency,
    ) -> ReconciliationReport:
        return ReconciliationReport(
            repaired_document_ids=[], conflicts=reconciliation.list_conflicts()
        )

    @app.post("/api/v1/reconciliation/scan", response_model=ReconciliationReport)
    def reconciliation_scan(
        _principal: Principal = admin_dependency,
    ) -> ReconciliationReport:
        return reconciliation.scan()

    @app.post("/api/v1/reconciliation/reindex", response_model=Document, status_code=201)
    def reconciliation_reindex(
        body: ReindexPath,
        _principal: Principal = admin_dependency,
    ) -> Document:
        return reconciliation.reindex_path(body.path)

    @app.post("/api/v1/reconciliation/{conflict_id}/accept-disk", response_model=Document)
    def reconciliation_accept_disk(
        conflict_id: str,
        _principal: Principal = admin_dependency,
    ) -> Document:
        return reconciliation.accept_disk_content(conflict_id)

    @app.post("/api/v1/reconciliation/{conflict_id}/restore-database", response_model=Document)
    def reconciliation_restore_database(
        conflict_id: str,
        _principal: Principal = admin_dependency,
    ) -> Document:
        return reconciliation.restore_database_content(conflict_id)

    @app.post("/api/v1/reconciliation/{conflict_id}/recognize-move", response_model=Document)
    def reconciliation_recognize_move(
        conflict_id: str,
        _principal: Principal = admin_dependency,
    ) -> Document:
        return reconciliation.recognize_move(conflict_id)

    @app.post("/api/v1/reconciliation/{conflict_id}/ignore", response_model=ReconciliationReport)
    def reconciliation_ignore(
        conflict_id: str,
        _principal: Principal = admin_dependency,
    ) -> ReconciliationReport:
        return reconciliation.ignore_unknown_file(conflict_id)

    @app.get("/api/v1/backups", response_model=list[BackupSet])
    def list_backups(
        _principal: Principal = admin_dependency,
    ) -> list[BackupSet]:
        return backups.list()

    @app.post("/api/v1/backups", response_model=BackupSet, status_code=201)
    def create_backup(
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = admin_dependency,
    ) -> BackupSet:
        return backups.create(actor_id=principal.actor_id, idempotency_key=idempotency_key)

    @app.post("/api/v1/backups/{backup_id}/verify", response_model=BackupVerification)
    def verify_backup(
        backup_id: str,
        _principal: Principal = admin_dependency,
    ) -> BackupVerification:
        return backups.verify(backup_id)

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
