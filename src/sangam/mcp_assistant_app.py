"""Typed App actions over the existing assistant request and conversation service."""

import asyncio
from typing import Literal

from pydantic import JsonValue

from sangam.application import ApplicationServices
from sangam.assistant_requests import submission_fingerprint
from sangam.errors import NotFoundError, SangamError, ValidationError
from sangam.mcp_errors import McpMutationError
from sangam.mcp_models import (
    AssistantAppAction,
    AssistantCancelApp,
    AssistantGetApp,
    AssistantMessagesApp,
    AssistantOperation,
    AssistantSubmitApp,
    CancelAssistant,
    GetAssistant,
    ReadConversation,
    SearchHit,
    SubmitAssistant,
    WorkspaceLayout,
)
from sangam.mcp_state import McpState
from sangam.security import Principal


class AssistantApp:
    def __init__(self, services: ApplicationServices, state: McpState):
        self.services, self.state = services, state

    def prepare(self, principal: Principal, action: AssistantSubmitApp) -> SubmitAssistant:
        workspace = self.state.read(principal, action.workspace_id)
        reference = SearchHit.model_validate(workspace["document"])
        document = self.services.workspace_access.get_document(principal, reference.document_id)
        if action.document_id != document.document_id or action.revision_id is None:
            raise ValidationError("Send an explicit saved revision of the active document.")
        layout = WorkspaceLayout.model_validate(workspace["layout"])
        visible = {tab.document_id for tab in layout.tabs}
        if any(source.document_id not in visible for source in action.context_documents):
            raise ValidationError(
                "Assistant tab context must belong to the current readable layout."
            )
        if action.selection_text:
            if workspace["draft"] is not None:
                raise ValidationError(
                    "Save or discard the document draft before sending a selected passage."
                )
            if document.content_type == "text/markdown":
                revision = self.services.workspace_access.get_revision(
                    principal, document.document_id, action.revision_id
                )
                if action.selection_text not in revision.content:
                    raise ValidationError(
                        "The selected passage is not part of the supplied saved revision."
                    )
        return SubmitAssistant.model_validate(action.model_dump(exclude={"type", "workspace_id"}))

    def accepted(self, principal: Principal, request_key: str) -> bool:
        with self.state.database.connection() as connection:
            return (
                connection.execute(
                    "SELECT 1 FROM assistant_requests WHERE actor_id=? AND request_key=?",
                    (principal.actor_id, request_key),
                ).fetchone()
                is not None
            )

    def authorize_reference(self, principal: Principal, action: AssistantAppAction) -> None:
        self.state.read(principal, action.workspace_id)
        with self.state.database.connection() as connection:
            if isinstance(action, AssistantMessagesApp):
                row = connection.execute(
                    "SELECT 1 FROM assistant_requests "
                    "WHERE actor_id=? AND workspace_id=? AND conversation_id=? LIMIT 1",
                    (principal.actor_id, action.workspace_id, action.conversation_id),
                ).fetchone()
            else:
                row = connection.execute(
                    "SELECT 1 FROM assistant_requests "
                    "WHERE actor_id=? AND workspace_id=? AND request_key=?",
                    (principal.actor_id, action.workspace_id, action.request_key),
                ).fetchone()
        if row is None:
            raise NotFoundError(
                "The assistant reference does not belong to this document workspace."
            )

    async def invoke(
        self, principal: Principal, action: AssistantAppAction
    ) -> dict[str, JsonValue]:
        requests = self.services.assistant_requests
        if isinstance(action, AssistantSubmitApp):
            query = SubmitAssistant.model_validate(
                action.model_dump(exclude={"type", "workspace_id"})
            )
            try:
                # Recovery uses the accepted context, independent of later tab/draft changes.
                if not await asyncio.to_thread(self.accepted, principal, query.request_key):
                    query = await asyncio.to_thread(self.prepare, principal, action)
                value = await requests.submit(
                    principal, query, None, workspace_id=action.workspace_id
                )
                return value.model_dump(mode="json")
            except SangamError as error:
                outcome: Literal["rejected", "committed", "unknown"] = "unknown"
                try:
                    current = await asyncio.to_thread(self.services.identity.reauthorize, principal)
                    with self.state.database.connection() as connection:
                        row = connection.execute(
                            "SELECT request_hash FROM assistant_requests "
                            "WHERE actor_id=? AND request_key=?",
                            (current.actor_id, query.request_key),
                        ).fetchone()
                    if row and row["request_hash"] == submission_fingerprint(query):
                        await asyncio.to_thread(requests.authorize, current, query.request_key)
                        outcome = "committed"
                    else:
                        outcome = "rejected"
                except SangamError:
                    pass
                raise McpMutationError(error, query.request_key, outcome) from error
        await asyncio.to_thread(self.authorize_reference, principal, action)
        payload = action.model_dump(exclude={"type", "workspace_id"})
        operation: AssistantOperation
        if isinstance(action, AssistantGetApp):
            operation = GetAssistant.model_validate(payload)
        elif isinstance(action, AssistantCancelApp):
            operation = CancelAssistant.model_validate(payload)
        else:
            operation = ReadConversation.model_validate(payload)
        return await requests.invoke(principal, operation, None)
