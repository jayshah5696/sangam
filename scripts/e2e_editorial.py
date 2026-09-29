"""Isolated browser fixture app. Never imported by the production server."""

import json
import uuid

from agents.tool_context import ToolContext
from chatkit.agents import AgentContext
from pydantic import BaseModel, ConfigDict

from sangam.api import create_app
from sangam.chat_context import ChatRequestContext
from sangam.config import Settings
from sangam.schemas import ChatProposal, Document
from sangam.security import Principal

settings = Settings()
app = create_app(settings)


class EditorialSeed(BaseModel):
    model_config = ConfigDict(extra="forbid")
    thread_id: str
    document_id: str


class EditorialFixture(BaseModel):
    proposal: ChatProposal
    source: Document


@app.post("/__e2e/editorial", response_model=EditorialFixture)
async def seed_editorial(payload: EditorialSeed) -> EditorialFixture:
    services = app.state.services
    chat = services.chat
    principal = Principal.trusted_human(
        actor_id=settings.trusted_human_actor_id,
        display_name=settings.trusted_human_display_name,
        operation_id=f"editorial-seed-{uuid.uuid4().hex}",
    )
    chat.proposals.repository.require_thread_owner(payload.thread_id, principal)
    workspace = chat.toolset.workspace
    document = workspace.get_document(principal, payload.document_id)
    source = workspace.create_document(
        principal,
        title="Editorial supporting source",
        content="# Supporting source 📚\n\nExact evidence for the editorial change.\n",
        content_type="text/markdown",
        path=None,
        idempotency_key=uuid.uuid4().hex,
    )
    context = chat.evidence.create_turn_context(
        principal,
        entry_point="document",
        document_id=document.document_id,
        revision_id=document.current_revision_id,
        selected_text="",
    )
    run = chat.evidence.begin_run(
        principal,
        thread_id=payload.thread_id,
        user_item_id=None,
        context_id=context.context_id,
        connection_id="openrouter",
        model_ref="openai/gpt-5.4-nano",
        capability_manifest=(),
    )
    request_context = ChatRequestContext(
        principal=principal,
        document_id=document.document_id,
        pinned_revision_id=document.current_revision_id,
        context_snapshot_id=context.context_id,
        run_id=run,
    )
    thread = await chat.store_adapter.load_thread(payload.thread_id, request_context)
    agent = AgentContext(thread=thread, store=chat.store_adapter, request_context=request_context)
    arguments = {
        "document_id": document.document_id,
        "expected_revision_id": document.current_revision_id,
        "content": "# Editorial draft\n\nThe agent's original proposed wording.\n",
        "summary": f"Editorial change {payload.thread_id}",
        "rationale": "Make the draft match the source passage.",
        "judgment_needed": "Check that the wording remains accurate.",
        "model_opinion": (
            "An external writing guide suggests a shorter tone; this has not been verified."
        ),
        "citations": [
            {
                "document_id": source.document_id,
                "snippet": "Exact evidence for the editorial change.",
            }
        ],
    }
    tool = next(tool for tool in chat.tools if tool.name == "propose_update")
    tool_context = ToolContext(
        context=agent,
        tool_name=tool.name,
        tool_call_id="editorial-propose",
        tool_arguments=json.dumps(arguments),
    )
    result = await tool.on_invoke_tool(tool_context, tool_context.tool_arguments)
    proposal_id = json.loads(result)["proposal_id"]
    read_tool = next(tool for tool in chat.tools if tool.name == "read_document")
    read_context = ToolContext(
        context=agent,
        tool_name=read_tool.name,
        tool_call_id="editorial-late-read",
        tool_arguments=json.dumps({"document_id": source.document_id}),
    )
    await read_tool.on_invoke_tool(read_context, read_context.tool_arguments)
    chat.evidence.complete_run(run, status="completed")
    proposal = next(
        p
        for p in chat.proposals.list(
            principal, thread_id=payload.thread_id, document_id=document.document_id
        )
        if p.proposal_id == proposal_id
    )
    return EditorialFixture(proposal=proposal, source=source)
