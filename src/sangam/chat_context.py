from __future__ import annotations

from dataclasses import dataclass

from agents import RunContextWrapper
from chatkit.agents import AgentContext

from sangam.security import Principal


@dataclass(frozen=True)
class ChatRequestContext:
    principal: Principal
    document_id: str | None = None


AgentRunContext = AgentContext[ChatRequestContext]
ToolContext = RunContextWrapper[AgentRunContext]
