from __future__ import annotations

from collections.abc import Callable
from urllib.parse import urlsplit

from chatkit.server import NonStreamingResult, StreamingResult
from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import StreamingResponse

from sangam.chat import ChatRequestContext, SangamChatServer
from sangam.errors import ValidationError
from sangam.schemas import (
    ApplyChatProposal,
    ChatModelSelectionUpdate,
    ChatModelSettings,
    ChatProposal,
    ChatRuntimeConfig,
    CreateProviderConnection,
    DismissChatProposal,
    ProviderConnection,
    ProviderConnectionTest,
    UpdateProviderConnection,
)
from sangam.security import Principal

PrincipalResolver = Callable[..., Principal]


def create_chat_router(
    *,
    chat: SangamChatServer,
    resolve_principal: PrincipalResolver,
    require_administrator: PrincipalResolver,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["chat"])
    principal_dependency = Depends(resolve_principal)
    admin_dependency = Depends(require_administrator)

    @router.get("/chat/config", response_model=ChatRuntimeConfig)
    def runtime_config(
        request: Request,
        origin: str | None = Header(default=None),
        _principal: Principal = principal_dependency,
    ) -> ChatRuntimeConfig:
        return chat.runtime_config(request_is_loopback=_request_is_loopback(request, origin))

    @router.get("/chat/models", response_model=ChatModelSettings)
    def get_models(_principal: Principal = principal_dependency) -> ChatModelSettings:
        # The catalog contains no provider credentials and authenticated chat clients
        # need it to render valid model choices. Only the mutations below are global
        # operator actions.
        return chat.model_catalog.as_schema()

    @router.put("/chat/models", response_model=ChatModelSettings)
    def update_models(
        body: ChatModelSelectionUpdate,
        _principal: Principal = admin_dependency,
    ) -> ChatModelSettings:
        return chat.model_catalog.update(
            expected_version=body.expected_version,
            workspace_enabled=body.workspace_enabled,
            default_model=body.default_model,
            enabled_models=body.enabled_models,
            unknown_model_overrides=body.unknown_model_overrides,
        )

    @router.post("/chat/models/refresh", response_model=ChatModelSettings)
    def refresh_models(_principal: Principal = admin_dependency) -> ChatModelSettings:
        return chat.model_catalog.refresh("openrouter")

    @router.post(
        "/chat/connections/{connection_id}/models/refresh",
        response_model=ChatModelSettings,
    )
    def refresh_connection_models(
        connection_id: str, _principal: Principal = admin_dependency
    ) -> ChatModelSettings:
        return chat.model_catalog.refresh(connection_id)

    @router.get("/chat/connections", response_model=list[ProviderConnection])
    def list_connections(
        _principal: Principal = principal_dependency,
    ) -> list[ProviderConnection]:
        return [_connection_schema(item) for item in chat.provider_connections.list()]

    @router.post("/chat/connections", response_model=ProviderConnection, status_code=201)
    def create_connection(
        body: CreateProviderConnection,
        principal: Principal = admin_dependency,
    ) -> ProviderConnection:
        result = chat.provider_connections.create(**body.model_dump())
        chat.workspace.activity.record(
            principal=principal,
            action="create",
            resource_type="provider_connection",
            resource_id=result.connection_id,
            outcome="accepted",
        )
        return _connection_schema(result)

    @router.put("/chat/connections/{connection_id}", response_model=ProviderConnection)
    def update_connection(
        connection_id: str,
        body: UpdateProviderConnection,
        principal: Principal = admin_dependency,
    ) -> ProviderConnection:
        result = chat.provider_connections.update(connection_id, **body.model_dump())
        chat.workspace.activity.record(
            principal=principal,
            action="update",
            resource_type="provider_connection",
            resource_id=result.connection_id,
            outcome="accepted",
        )
        return _connection_schema(result)

    @router.post("/chat/connections/{connection_id}/test", response_model=ProviderConnectionTest)
    def test_connection(
        connection_id: str,
        principal: Principal = admin_dependency,
    ) -> ProviderConnectionTest:
        connection, models = chat.provider_connections.test(connection_id)
        chat.workspace.activity.record(
            principal=principal,
            action="test",
            resource_type="provider_connection",
            resource_id=connection.connection_id,
            outcome="accepted",
        )
        return ProviderConnectionTest(
            connection=_connection_schema(connection),
            discovered_models=len(models),
            message=f"Connected and discovered {len(models)} models.",
        )

    @router.post("/chatkit")
    async def chatkit_endpoint(
        request: Request,
        document_id: str | None = Header(default=None, alias="X-Sangam-Document-ID"),
        revision_id: str | None = Header(default=None, alias="X-Sangam-Revision-ID"),
        workspace_context: str | None = Header(default=None, alias="X-Sangam-Workspace-Context"),
        principal: Principal = principal_dependency,
    ) -> Response:
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                declared_length = int(content_length)
            except ValueError as error:
                raise ValidationError("Chat request Content-Length is invalid") from error
            if declared_length > chat.config.max_request_bytes:
                raise ValidationError("Chat request exceeds the configured size limit")
        body = await request.body()
        if len(body) > chat.config.max_request_bytes:
            raise ValidationError("Chat request exceeds the configured size limit")
        result = await chat.process(
            body,
            context=ChatRequestContext(
                principal=principal,
                document_id=document_id,
                requested_revision_id=revision_id,
                workspace_context=workspace_context == "1",
            ),
        )
        if isinstance(result, StreamingResult):
            return StreamingResponse(
                result,
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache, no-store",
                    "X-Accel-Buffering": "no",
                },
            )
        if not isinstance(result, NonStreamingResult):
            raise TypeError("Unsupported ChatKit result")
        return Response(content=result.json, media_type="application/json")

    @router.get("/chat/proposals", response_model=list[ChatProposal])
    def list_proposals(
        thread_id: str | None = Query(default=None),
        document_id: str | None = Query(default=None),
        principal: Principal = principal_dependency,
    ) -> list[ChatProposal]:
        return chat.proposals.list(principal, thread_id=thread_id, document_id=document_id)

    @router.post("/chat/proposals/{proposal_id}/apply", response_model=ChatProposal)
    def apply_proposal(
        proposal_id: str,
        body: ApplyChatProposal,
        idempotency_key: str = Header(alias="Idempotency-Key"),
        principal: Principal = principal_dependency,
    ) -> ChatProposal:
        return chat.proposals.apply(
            principal,
            proposal_id=proposal_id,
            expected_revision_id=body.expected_revision_id,
            idempotency_key=idempotency_key,
        )

    @router.post("/chat/proposals/{proposal_id}/dismiss", response_model=ChatProposal)
    def dismiss_proposal(
        proposal_id: str,
        body: DismissChatProposal,
        principal: Principal = principal_dependency,
    ) -> ChatProposal:
        return chat.proposals.dismiss(principal, proposal_id, body.reason)

    return router


def _request_is_loopback(request: Request, origin: str | None) -> bool:
    # Browsers send Origin for this same-origin API request. Prefer it so a
    # reverse proxy cannot make a public browser look like localhost.
    candidate = origin or str(request.base_url)
    try:
        hostname = (urlsplit(candidate).hostname or "").lower().rstrip(".")
    except ValueError:
        return False
    return hostname in {"localhost", "127.0.0.1", "::1"}


def _connection_schema(value) -> ProviderConnection:
    return ProviderConnection(
        connection_id=value.connection_id,
        name=value.name,
        preset=value.preset,
        protocol=value.protocol,
        base_url=value.base_url,
        credential_env=value.credential_env,
        credential_present=value.credential_present,
        enabled=value.enabled,
        version=value.version,
        status=value.status,
        last_checked_at=value.last_checked_at,
        last_error=value.last_error,
    )
