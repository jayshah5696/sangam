from __future__ import annotations

from dataclasses import dataclass

from agents import RunContextWrapper
from chatkit.agents import AgentContext

from sangam.security import Principal


@dataclass(frozen=True)
class ChatRequestContext:
    principal: Principal
    document_id: str | None = None
    workspace_context: bool = False
    pinned_revision_id: str | None = None
    requested_revision_id: str | None = None
    model_ref: str | None = None


AgentRunContext = AgentContext[ChatRequestContext]
ToolContext = RunContextWrapper[AgentRunContext]
