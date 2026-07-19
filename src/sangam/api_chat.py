from __future__ import annotations

from collections.abc import Callable

from chatkit.server import NonStreamingResult, StreamingResult
from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.responses import StreamingResponse

from sangam.chat import ChatRequestContext, SangamChatServer
from sangam.schemas import (
    ApplyChatProposal,
    ChatProposal,
    ChatRuntimeConfig,
    DismissChatProposal,
)
from sangam.security import Principal

PrincipalResolver = Callable[..., Principal]


def create_chat_router(
    *, chat: SangamChatServer, resolve_principal: PrincipalResolver
) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["chat"])
    principal_dependency = Depends(resolve_principal)

    @router.get("/chat/config", response_model=ChatRuntimeConfig)
    def runtime_config(_principal: Principal = principal_dependency) -> ChatRuntimeConfig:
        return chat.runtime_config()

    @router.post("/chatkit")
    async def chatkit_endpoint(
        request: Request,
        document_id: str | None = Header(default=None, alias="X-Sangam-Document-ID"),
        principal: Principal = principal_dependency,
    ) -> Response:
        result = await chat.process(
            await request.body(),
            context=ChatRequestContext(principal=principal, document_id=document_id),
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
