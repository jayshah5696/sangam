from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import urlencode

from agents import function_tool
from chatkit.agents import ClientToolCall
from chatkit.types import CustomTask

from sangam.access import WorkspaceAccessService
from sangam.chat_capabilities import (
    ChatCapability,
    ChatCapabilityRegistry,
    CreateDocumentInput,
    ProposeUpdateInput,
    PublishDocumentInput,
    ReadDocumentInput,
    ReadPdfPageInput,
    WorkspaceSearchInput,
)
from sangam.chat_context import ToolContext
from sangam.chat_effects import ChatEffectService
from sangam.chat_evidence import ChatEvidenceRepository
from sangam.chat_proposals import ChatProposalService
from sangam.errors import NotFoundError, SangamError, ValidationError


class ChatToolset:
    """Workspace-grounded tools exposed to the OpenAI Agents runner."""

    def __init__(
        self,
        *,
        workspace: WorkspaceAccessService,
        proposals: ChatProposalService,
        registry: ChatCapabilityRegistry,
        effects: ChatEffectService,
        evidence: ChatEvidenceRepository,
        max_result_bytes: int,
    ) -> None:
        self.workspace = workspace
        self.proposals = proposals
        self.registry = registry
        self.effects = effects
        self.evidence = evidence
        self.max_result_bytes = max_result_bytes
        self.policies = registry.by_id

    def as_agent_tools(self, capabilities: tuple[ChatCapability, ...] | None = None) -> list[Any]:
        tools = [
            function_tool(
                self.get_editor_selection,
                description_override="Read selected text from the active Sangam editor.",
            ),
            function_tool(
                self.search_workspace,
                description_override="Search authorized Sangam documents.",
            ),
            function_tool(
                self.read_document,
                description_override="Read one authorized Markdown or HTML document.",
            ),
            function_tool(
                self.read_pdf_page,
                description_override="Read one PDF page and its current annotations.",
            ),
            function_tool(
                self.propose_update,
                description_override=(
                    "Create a full-content edit proposal against an exact document revision. "
                    "This never applies the edit."
                ),
            ),
            function_tool(
                self.create_document,
                description_override=(
                    "When the user explicitly requests a new Markdown document, call this tool "
                    "immediately with the complete title and content. The tool opens Sangam's "
                    "browser confirmation UI. Never ask for confirmation in prose before "
                    "calling it."
                ),
            ),
            function_tool(
                self.publish_document,
                description_override=(
                    "When the user explicitly requests publication, call this tool immediately. "
                    "The tool opens Sangam's browser confirmation UI and never publishes without "
                    "approval, so never ask for confirmation in prose before calling it."
                ),
            ),
        ]
        selected_capabilities = (
            capabilities if capabilities is not None else self.registry.capabilities
        )
        allowed = {capability.capability_id for capability in selected_capabilities}
        return [tool for tool in tools if tool.name in allowed]

    async def get_editor_selection(self, ctx: ToolContext) -> str:
        request_context = ctx.context.request_context

        def operation() -> dict[str, Any]:
            return {
                "document_id": request_context.document_id,
                "revision_id": request_context.pinned_revision_id,
                "selected_text": request_context.selection_text,
                "selection_digest": request_context.selection_digest,
                "pdf_page_number": request_context.pdf_page_number,
                "annotation_id": request_context.annotation_id,
            }

        return await self._run_tool(
            ctx,
            self.policies["get_editor_selection"],
            f"{len(request_context.selection_text)} selected characters",
            operation,
        )

    async def search_workspace(self, ctx: ToolContext, query: str, limit: int = 5) -> str:
        validated = WorkspaceSearchInput.model_validate({"query": query, "limit": limit})

        def operation() -> dict[str, Any]:
            documents = self.workspace.search_documents(
                ctx.context.request_context.principal,
                query=validated.query,
                tag_id=None,
                category=None,
                actor_id=None,
                sort="relevance",
                limit=validated.limit,
            )
            return {
                "results": [
                    self._document_source(document, snippet=document.search_snippet)
                    for document in documents
                ]
            }

        return await self._run_tool(
            ctx, self.policies["search_workspace"], validated.query, operation
        )

    async def read_document(self, ctx: ToolContext, document_id: str) -> str:
        validated = ReadDocumentInput.model_validate({"document_id": document_id})
        document_id = validated.document_id

        def operation() -> dict[str, Any]:
            document = self.workspace.get_document(
                ctx.context.request_context.principal, document_id
            )
            if document.content_type == "application/pdf":
                raise ValidationError("Use read_pdf_page for PDF documents")
            pinned_revision = ctx.context.request_context.pinned_revision_id
            if (
                pinned_revision
                and ctx.context.request_context.document_id == document_id
                and pinned_revision != document.current_revision_id
            ):
                revision = next(
                    (
                        item
                        for item in self.workspace.history(
                            ctx.context.request_context.principal, document_id
                        )
                        if item.revision_id == pinned_revision
                    ),
                    None,
                )
                if revision is None:
                    raise NotFoundError(f"Pinned document revision not found: {pinned_revision}")
                return {
                    "source": self._document_source(document, revision_id=revision.revision_id),
                    "content": self._bounded_text(revision.content),
                }
            return {
                "source": self._document_source(document),
                "content": self._bounded_text(document.content),
            }

        return await self._run_tool(ctx, self.policies["read_document"], document_id, operation)

    async def read_pdf_page(self, ctx: ToolContext, document_id: str, page_number: int) -> str:
        validated = ReadPdfPageInput.model_validate(
            {"document_id": document_id, "page_number": page_number}
        )
        document_id = validated.document_id
        page_number = validated.page_number

        def operation() -> dict[str, Any]:
            principal = ctx.context.request_context.principal
            document = self.workspace.get_document(principal, document_id)
            if document.content_type != "application/pdf":
                raise ValidationError("The requested document is not a PDF")
            pages = self.workspace.pdf_pages(principal, document_id)
            page = next((item for item in pages if item.page_number == page_number), None)
            if page is None:
                raise NotFoundError(f"PDF page not found: {page_number}")
            annotations = self.workspace.list_annotations(
                principal,
                document_id,
                page_number=page_number,
                query="",
                include_deleted=False,
            )
            return {
                "source": self._document_source(document, page_number=page_number),
                "text": self._bounded_text(page.text),
                "annotations": [
                    {
                        "annotation_id": annotation.annotation_id,
                        "type": annotation.annotation_type,
                        "selected_text": annotation.selected_text,
                        "note": annotation.note,
                        "tags": annotation.tags,
                    }
                    for annotation in annotations[:20]
                ],
            }

        return await self._run_tool(
            ctx,
            self.policies["read_pdf_page"],
            f"{document_id} page {page_number}",
            operation,
        )

    async def propose_update(
        self,
        ctx: ToolContext,
        document_id: str,
        expected_revision_id: str,
        content: str,
        summary: str,
    ) -> str:
        validated = ProposeUpdateInput.model_validate(
            {
                "document_id": document_id,
                "expected_revision_id": expected_revision_id,
                "content": content,
                "summary": summary,
            }
        )

        def operation() -> dict[str, Any]:
            proposal = self.proposals.create(
                ctx.context.request_context.principal,
                thread_id=ctx.context.thread.id,
                document_id=validated.document_id,
                expected_revision_id=validated.expected_revision_id,
                content=validated.content,
                summary=validated.summary,
            )
            return {
                "proposal_id": proposal.proposal_id,
                "status": proposal.status,
                "message": "Waiting for human diff review and approval.",
            }

        return await self._run_tool(
            ctx, self.policies["propose_update"], validated.summary, operation
        )

    async def create_document(self, ctx: ToolContext, title: str, content: str) -> None:
        normalized_title = " ".join(title.strip().split())
        arguments = CreateDocumentInput.model_validate(
            {
                "title": normalized_title,
                "content": content,
                "content_type": "text/markdown",
            }
        ).model_dump(mode="json")
        await self._request_effect(
            ctx,
            capability=self.policies["create_document"],
            arguments=arguments,
            preview=arguments,
        )

    async def publish_document(
        self, ctx: ToolContext, document_id: str, slug: str, access_policy: str
    ) -> None:
        document = self.workspace.get_document(ctx.context.request_context.principal, document_id)
        if document.content_type == "application/pdf":
            raise ValidationError("PDF documents cannot be published")
        arguments = PublishDocumentInput.model_validate(
            {
                "document_id": document.document_id,
                "revision_id": document.current_revision_id,
                "slug": slug,
                "access_policy": access_policy,
            }
        ).model_dump(mode="json")
        await self._request_effect(
            ctx,
            capability=self.policies["publish_document"],
            arguments=arguments,
            preview={**arguments, "document_title": document.title},
        )

    async def _request_effect(
        self,
        ctx: ToolContext,
        *,
        capability: ChatCapability,
        arguments: dict[str, object],
        preview: dict[str, object],
    ) -> None:
        request_context = ctx.context.request_context
        if not request_context.run_id:
            raise RuntimeError("Durable chat effects require a persisted run")
        tool_call_id = getattr(ctx, "tool_call_id", None)
        if not tool_call_id:
            raise RuntimeError("Durable chat effects require a tool call ID")
        effect = self.effects.propose(
            request_context.principal,
            run_id=request_context.run_id,
            thread_id=ctx.context.thread.id,
            tool_call_id=tool_call_id,
            capability=capability,
            arguments=arguments,
            preview=preview,
        )
        self.evidence.record_tool(
            run_id=request_context.run_id,
            tool_call_id=tool_call_id,
            capability_id=capability.capability_id,
            capability_version=capability.version,
            effect_class=capability.effect,
            approval_policy=capability.approval,
            outcome="pending_approval",
            duration_ms=0,
            result_bytes=0,
            citation_count=0,
            error_class=None,
        )
        ctx.context.client_tool_call = ClientToolCall(
            name="review_chat_effect",
            arguments={
                "effect_id": effect.effect_id,
                "capability_id": effect.capability_id,
                "argument_digest": effect.argument_digest,
            },
        )

    async def _run_tool(
        self,
        ctx: ToolContext,
        policy: ChatCapability,
        detail: str,
        operation: Callable[[], dict[str, Any]],
    ) -> str:
        task = CustomTask(
            title=policy.title,
            content=self._bounded_text(detail, 500),
            status_indicator="loading",
        )
        await ctx.context.add_workflow_task(task)
        workflow_item = ctx.context.workflow_item
        if workflow_item is None:
            raise RuntimeError("ChatKit did not create a workflow item for the tool call")
        task_index = workflow_item.workflow.tasks.index(task)
        started = time.monotonic()
        outcome = "accepted"
        try:
            payload = await asyncio.wait_for(
                asyncio.to_thread(operation), timeout=policy.timeout_seconds
            )
            payload = policy.result_schema.model_validate(payload).model_dump(mode="json")
        except TimeoutError:
            outcome = "failed"
            payload = {
                "ok": False,
                "error": {
                    "code": "tool_timeout",
                    "message": (
                        f"{policy.title} exceeded its {policy.timeout_seconds:g} second limit."
                    ),
                    "details": {},
                },
            }
        except SangamError as error:
            outcome = "failed"
            payload = {
                "ok": False,
                "error": {
                    "code": error.code,
                    "message": error.message,
                    "details": error.details,
                },
            }
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        citations = _citation_count(payload)
        payload["_trace"] = {
            "tool": policy.name,
            "effect": policy.effect,
            "approval": policy.approval,
            "outcome": outcome,
            "duration_ms": duration_ms,
            "citations": citations,
        }
        task.status_indicator = "complete"
        task.content = f"{outcome.capitalize()} · {policy.effect} · {duration_ms} ms" + (
            f" · {citations} citation{'s' if citations != 1 else ''}" if citations else ""
        )
        await ctx.context.update_workflow_task(task, task_index)
        result = self._bounded_text(
            json.dumps(payload, ensure_ascii=False),
            min(self.max_result_bytes, policy.max_result_bytes),
        )
        request_context = getattr(ctx.context, "request_context", None)
        run_id = getattr(request_context, "run_id", None)
        if run_id:
            self.evidence.record_tool(
                run_id=run_id,
                tool_call_id=getattr(ctx, "tool_call_id", None),
                capability_id=policy.capability_id,
                capability_version=policy.version,
                effect_class=policy.effect,
                approval_policy=policy.approval,
                outcome=outcome,
                duration_ms=duration_ms,
                result_bytes=len(result.encode("utf-8")),
                citation_count=citations,
                error_class=(
                    str(payload.get("error", {}).get("code"))
                    if isinstance(payload.get("error"), dict)
                    else None
                ),
            )
        return result

    def _document_source(
        self,
        document: Any,
        *,
        page_number: int | None = None,
        snippet: str | None = None,
        revision_id: str | None = None,
    ) -> dict[str, Any]:
        data = {
            "document_id": document.document_id,
            "title": document.title,
            "revision_id": revision_id or document.current_revision_id,
        }
        if page_number is not None:
            data["page_number"] = page_number
        deeplink = f"chatkit-link://document?{urlencode(data)}"
        return {**data, "path": document.path, "snippet": snippet, "citation": deeplink}

    @staticmethod
    def _bounded_text(value: str, limit: int = 40_000) -> str:
        encoded = value.encode("utf-8")
        if len(encoded) <= limit:
            return value
        return encoded[:limit].decode("utf-8", errors="ignore") + "\n[truncated]"


def _citation_count(value: object) -> int:
    if isinstance(value, dict):
        return int("citation" in value) + sum(_citation_count(item) for item in value.values())
    if isinstance(value, list):
        return sum(_citation_count(item) for item in value)
    return 0
