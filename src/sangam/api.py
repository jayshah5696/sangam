from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from sangam import __version__
from sangam.api_chat import create_chat_router
from sangam.api_karakeep import create_karakeep_router
from sangam.api_pdf import create_pdf_router
from sangam.application import build_application_services
from sangam.config import Settings
from sangam.errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    IdempotencyError,
    IntegrationError,
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
    CreatePublication,
    CreateTag,
    DeleteDocument,
    Document,
    DocumentSummary,
    DuplicateDocument,
    ExposePublicationRevision,
    Folder,
    IssuedAgentToken,
    IssuedPublication,
    OperationEvent,
    PathMutation,
    Publication,
    PublicationContent,
    PublicationRevision,
    ReconciliationReport,
    ReindexPath,
    RestoreDocument,
    Revision,
    RevisionDiff,
    Tag,
    TrustedPreviewGrant,
    UpdateDocument,
    UpdateDocumentMetadata,
    UpdateDocumentTrust,
    UpdateFolderMetadata,
    UpdatePublication,
)
from sangam.security import Principal, PublicationAccess

logger = logging.getLogger(__name__)


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or Settings()
    services = build_application_services(resolved_settings)
    documents = services.documents
    reconciliation = services.reconciliation
    backups = services.backups
    workspace = services.workspace_access
    identity = services.identity
    authentication = services.authentication
    activity = services.activity
    authorization = services.authorization
    publications = services.publications
    pdf_research = services.pdf_research
    karakeep = services.karakeep
    chat = services.chat
    readiness = services.readiness

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        application.state.startup_reconciliation = None
        application.state.startup_reconciliation_error = None
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
        extraction_cancel = threading.Event()
        extraction_tasks = {
            asyncio.create_task(
                asyncio.to_thread(pdf_research.extract_text, document_id, extraction_cancel)
            )
            for document_id in pdf_research.pending_extractions()
        }
        yield
        if backup_task:
            backup_task.cancel()
            with suppress(asyncio.CancelledError):
                await backup_task
        if extraction_tasks:
            extraction_cancel.set()
            _, pending = await asyncio.wait(
                extraction_tasks,
                timeout=resolved_settings.pdf_extraction_shutdown_timeout_seconds,
            )
            for task in pending:
                task.cancel()
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)

    app = FastAPI(
        title="Sangam API",
        version=__version__,
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
        preview_url = urlsplit(resolved_settings.trusted_preview_base_url)
        preview_origin = f"{preview_url.scheme}://{preview_url.netloc}"
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self' https://cdn.platform.openai.com; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; "
            f"frame-src 'self' {preview_origin} https://*.openai.com; "
            "object-src 'none'; base-uri 'none'; "
            "frame-ancestors 'none'; form-action 'self'",
        )
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault(
            "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
        )
        if request.url.path.startswith(("/api/v1/publications/", "/p/", "/trusted-preview")):
            response.headers["Cache-Control"] = "no-store, max-age=0"
            response.headers["Referrer-Policy"] = "no-referrer"
        return response

    def resolve_principal(
        request: Request,
        authorization_header: str | None = Header(default=None, alias="Authorization"),
        access_jwt_assertion: str | None = Header(default=None, alias="Cf-Access-Jwt-Assertion"),
    ) -> Principal:
        return authentication.resolve(
            authorization_header=authorization_header,
            trusted_identity_assertion=request.headers.get(
                resolved_settings.trusted_identity_header
            ),
            operation_id=request.state.operation_id,
            access_jwt_assertion=access_jwt_assertion,
        )

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

    trusted_preview_api_paths = {
        "/api/v1/trusted-previews/content",
        "/api/v1/trusted-previews/asset",
    }

    @app.middleware("http")
    async def trusted_preview_opaque_origin_cors(request: Request, call_next):
        is_preview_api = request.url.path in trusted_preview_api_paths
        expected_host = resolved_settings.trusted_preview_host
        is_preview_host = not expected_host or request.url.hostname == expected_host
        is_opaque_origin = request.headers.get("origin") == "null"
        if not (is_preview_api and is_preview_host and is_opaque_origin):
            return await call_next(request)

        if request.method == "OPTIONS":
            requested_method = request.headers.get("access-control-request-method", "").upper()
            requested_headers = {
                header.strip().casefold()
                for header in request.headers.get("access-control-request-headers", "").split(",")
                if header.strip()
            }
            if requested_method != "GET" or not requested_headers.issubset({"authorization"}):
                return Response(status_code=400)
            return Response(
                status_code=204,
                headers={
                    "Access-Control-Allow-Origin": "null",
                    "Access-Control-Allow-Methods": "GET",
                    "Access-Control-Allow-Headers": "Authorization",
                    "Cache-Control": "no-store, max-age=0",
                    "Vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
                },
            )

        response = await call_next(request)
        response.headers["Access-Control-Allow-Origin"] = "null"
        vary = {
            value.strip() for value in response.headers.get("Vary", "").split(",") if value.strip()
        }
        vary.add("Origin")
        response.headers["Vary"] = ", ".join(sorted(vary))
        return response

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
        elif isinstance(error, IntegrationError):
            status = 502
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
        return {"status": "ok", "version": __version__}

    @app.get("/api/v1/readiness")
    def readiness_status(request: Request) -> JSONResponse:
        result = readiness.check(
            startup_complete=request.app.state.startup_reconciliation is not None,
            startup_reconciliation_error=request.app.state.startup_reconciliation_error,
        )
        return JSONResponse(status_code=200 if result["status"] == "ready" else 503, content=result)

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
            content_type=body.content_type,
            idempotency_key=idempotency_key,
        )

    app.include_router(
        create_pdf_router(
            workspace=workspace,
            pdf_research=pdf_research,
            resolve_principal=resolve_principal,
            require_administrator=require_administrator,
        )
    )
    app.include_router(
        create_chat_router(
            chat=chat,
            resolve_principal=resolve_principal,
            require_administrator=require_administrator,
        )
    )
    app.include_router(
        create_karakeep_router(
            karakeep=karakeep,
            require_administrator=require_administrator,
        )
    )

    @app.patch("/api/v1/documents/{document_id}/trust", response_model=Document)
    def update_document_trust(
        document_id: str,
        body: UpdateDocumentTrust,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = admin_dependency,
    ) -> Document:
        return documents.update_trust(
            document_id=document_id,
            expected_trust_version=body.expected_trust_version,
            trust_level=body.trust_level,
            actor_id=principal.actor_id,
            idempotency_key=idempotency_key,
        )

    @app.post(
        "/api/v1/documents/{document_id}/trusted-preview",
        response_model=TrustedPreviewGrant,
    )
    def issue_trusted_preview(
        document_id: str,
        revision_id: str = Query(),
        principal: Principal = admin_dependency,
    ) -> TrustedPreviewGrant:
        del principal
        return publications.issue_trusted_preview(document_id=document_id, revision_id=revision_id)

    @app.get("/api/v1/publications", response_model=list[Publication])
    def list_publications(_principal: Principal = admin_dependency) -> list[Publication]:
        return publications.list_publications()

    @app.get("/api/v1/publications/by-document/{document_id}", response_model=Publication | None)
    def get_document_publication(
        document_id: str, _principal: Principal = admin_dependency
    ) -> Publication | None:
        return publications.get_document_publication(document_id)

    @app.post("/api/v1/publications", response_model=IssuedPublication, status_code=201)
    def create_publication(
        body: CreatePublication,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> IssuedPublication:
        return workspace.create_publication(
            principal,
            document_id=body.document_id,
            slug=body.slug,
            access_policy=body.access_policy,
            idempotency_key=idempotency_key,
        )

    @app.patch("/api/v1/publications/{publication_id}", response_model=IssuedPublication)
    def update_publication(
        publication_id: str,
        body: UpdatePublication,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> IssuedPublication:
        return workspace.update_publication(
            principal,
            publication_id=publication_id,
            expected_version=body.expected_version,
            slug=body.slug,
            access_policy=body.access_policy,
            idempotency_key=idempotency_key,
        )

    @app.delete("/api/v1/publications/{publication_id}", response_model=Publication)
    def unpublish(
        publication_id: str,
        expected_version: int = Query(ge=0),
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> Publication:
        return workspace.unpublish(
            principal,
            publication_id=publication_id,
            expected_version=expected_version,
            idempotency_key=idempotency_key,
        )

    @app.post(
        "/api/v1/publications/{publication_id}/revisions",
        response_model=PublicationRevision,
    )
    def expose_publication_revision(
        publication_id: str,
        body: ExposePublicationRevision,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> PublicationRevision:
        return workspace.expose_publication_revision(
            principal,
            publication_id=publication_id,
            revision_id=body.revision_id,
            idempotency_key=idempotency_key,
        )

    @app.post(
        "/api/v1/publications/{publication_id}/rotate-token",
        response_model=IssuedPublication,
    )
    def rotate_publication_token(
        publication_id: str,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> IssuedPublication:
        return workspace.rotate_publication_token(
            principal,
            publication_id=publication_id,
            idempotency_key=idempotency_key,
        )

    @app.get("/api/v1/publications/{slug}/content", response_model=PublicationContent)
    def publication_content(
        slug: str,
        request: Request,
        revision: str | None = Query(default=None),
        authorization_header: str | None = Header(default=None, alias="Authorization"),
    ) -> JSONResponse:
        access = resolve_publication_access(request, authorization_header)
        content = publications.get_content(
            slug=slug,
            revision_id=revision,
            raw_unlisted_token=access.unlisted_token,
            administrator=access.administrator,
        )
        return JSONResponse(
            content=content.model_dump(),
            headers={"Cache-Control": "no-store, max-age=0", "Vary": "Authorization"},
        )

    def resolve_publication_access(
        request: Request, authorization_header: str | None
    ) -> PublicationAccess:
        return authentication.resolve_publication_access(
            authorization_header=authorization_header,
            trusted_identity_assertion=request.headers.get(
                resolved_settings.trusted_identity_header
            ),
            access_jwt_assertion=request.headers.get("Cf-Access-Jwt-Assertion"),
            operation_id=request.state.operation_id,
        )

    @app.get("/api/v1/publications/{slug}/asset", include_in_schema=False)
    def publication_asset(
        slug: str,
        request: Request,
        revision: str = Query(),
        path: str = Query(min_length=1, max_length=1000),
        authorization_header: str | None = Header(default=None, alias="Authorization"),
    ) -> Response:
        access = resolve_publication_access(request, authorization_header)
        asset = publications.get_asset(
            slug=slug,
            revision_id=revision,
            asset_reference=path,
            raw_unlisted_token=access.unlisted_token,
            administrator=access.administrator,
        )
        return Response(
            content=asset.content,
            media_type=asset.media_type,
            headers={
                "Cache-Control": "no-store, max-age=0",
                "Content-Security-Policy": "default-src 'none'",
                "Vary": "Authorization",
            },
        )

    def require_preview_host(request: Request) -> None:
        expected = resolved_settings.trusted_preview_host
        if expected and request.url.hostname != expected:
            raise NotFoundError("Trusted preview endpoint was not found")

    @app.get("/trusted-preview/", response_class=HTMLResponse, include_in_schema=False)
    def trusted_preview_shell(request: Request) -> HTMLResponse:
        require_preview_host(request)
        parents = " ".join(resolved_settings.trusted_preview_parent_origins) or "'none'"
        csp = (
            "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; "
            f"style-src 'unsafe-inline'; frame-ancestors {parents}; "
            "base-uri 'none'; form-action 'none'"
        )
        shell = """<!doctype html><meta charset=\"utf-8\"><title>Trusted Sangam preview</title>
<p id=\"status\">Opening trusted preview…</p><script>
const token = new URLSearchParams(location.hash.slice(1)).get('token');
history.replaceState(null, '', location.pathname);
if (!token) document.getElementById('status').textContent = 'Preview token is missing.';
else fetch('/api/v1/trusted-previews/content', {
  headers: {Authorization: `Sangam-Preview ${token}`}
})
  .then(response => { if (!response.ok) throw new Error(); return response.text(); })
  .then(async html => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const assets = Array.from(parsed.querySelectorAll('[src]')).filter(element => {
      const source = element.getAttribute('src') || '';
      return source && !source.startsWith('/') && !source.startsWith('data:') &&
        !source.startsWith('blob:') && !source.includes('://');
    });
    await Promise.all(assets.map(async element => {
      const source = element.getAttribute('src');
      const response = await fetch(
        `/api/v1/trusted-previews/asset?path=${encodeURIComponent(source)}`,
        {headers: {Authorization: `Sangam-Preview ${token}`}}
      );
      if (!response.ok) throw new Error();
      element.setAttribute('src', URL.createObjectURL(await response.blob()));
    }));
    document.open();
    document.write('<!doctype html>' + parsed.documentElement.outerHTML);
    document.close();
  })
  .catch(() => {
    document.getElementById('status').textContent = 'Preview expired or was revoked.';
  });
</script>"""
        return HTMLResponse(
            shell,
            headers={"Content-Security-Policy": csp, "Cache-Control": "no-store"},
        )

    @app.get("/api/v1/trusted-previews/content", include_in_schema=False)
    def trusted_preview_content(
        request: Request,
        authorization_header: str | None = Header(default=None, alias="Authorization"),
    ) -> HTMLResponse:
        require_preview_host(request)
        scheme, separator, token = (authorization_header or "").partition(" ")
        if not separator or scheme.casefold() != "sangam-preview" or not token.strip():
            raise NotFoundError("Trusted preview grant was not found")
        content = publications.trusted_preview_content(token.strip())
        connect_sources = " ".join(resolved_settings.trusted_preview_connect_src) or "'none'"
        csp = (
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
            f"connect-src {connect_sources}; img-src data: blob:; media-src 'none'; "
            "font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
        )
        wrapped = (
            '<!doctype html><html><head><meta charset="utf-8">'
            f'<meta http-equiv="Content-Security-Policy" content="{csp}">'
            '<meta name="referrer" content="no-referrer"></head><body>'
            f"{content}</body></html>"
        )
        return HTMLResponse(wrapped, headers={"Cache-Control": "no-store, max-age=0"})

    @app.get("/api/v1/trusted-previews/asset", include_in_schema=False)
    def trusted_preview_asset(
        request: Request,
        path: str = Query(min_length=1, max_length=1000),
        authorization_header: str | None = Header(default=None, alias="Authorization"),
    ) -> Response:
        require_preview_host(request)
        scheme, separator, token = (authorization_header or "").partition(" ")
        if not separator or scheme.casefold() != "sangam-preview" or not token.strip():
            raise NotFoundError("Trusted preview asset was not found")
        asset = publications.trusted_preview_asset(raw_token=token.strip(), asset_reference=path)
        return Response(
            content=asset.content,
            media_type=asset.media_type,
            headers={"Cache-Control": "no-store, max-age=0"},
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
