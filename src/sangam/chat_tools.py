from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

from agents import function_tool
from chatkit.agents import ClientToolCall
from chatkit.types import CustomTask

from sangam.access import WorkspaceAccessService
from sangam.chat_context import ToolContext
from sangam.chat_proposals import ChatProposalService
from sangam.errors import NotFoundError, SangamError, ValidationError


@dataclass(frozen=True)
class ToolPolicy:
    name: str
    title: str
    effect: str
    approval: str


TOOL_POLICIES: tuple[ToolPolicy, ...] = (
    ToolPolicy("get_editor_selection", "Read editor selection", "read", "none"),
    ToolPolicy("search_workspace", "Search workspace", "read", "none"),
    ToolPolicy("read_document", "Read document", "read", "none"),
    ToolPolicy("read_pdf_page", "Read PDF page", "read", "none"),
    ToolPolicy("propose_update", "Prepare edit proposal", "proposal", "human_review"),
    ToolPolicy("create_document", "Create document", "write", "client_confirmation"),
    ToolPolicy("publish_document", "Publish document", "external", "client_confirmation"),
)


class ChatToolset:
    """Workspace-grounded tools exposed to the OpenAI Agents runner."""

    def __init__(
        self,
        *,
        workspace: WorkspaceAccessService,
        proposals: ChatProposalService,
        max_result_bytes: int,
    ) -> None:
        self.workspace = workspace
        self.proposals = proposals
        self.max_result_bytes = max_result_bytes
        self.policies = {item.name: item for item in TOOL_POLICIES}

    def as_agent_tools(self) -> list[Any]:
        return [
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
                    "Create a Markdown document only when the user explicitly requests it."
                ),
            ),
            function_tool(
                self.publish_document,
                description_override=(
                    "Request a browser confirmation before publishing a document. "
                    "This tool never publishes without the user's separate approval."
                ),
            ),
        ]

    async def get_editor_selection(self, ctx: ToolContext) -> None:
        ctx.context.client_tool_call = ClientToolCall(
            name="get_editor_selection",
            arguments={"document_id": ctx.context.request_context.document_id},
        )

    async def search_workspace(self, ctx: ToolContext, query: str, limit: int = 5) -> str:
        limit = max(1, min(limit, 10))

        def operation() -> dict[str, Any]:
            documents = self.workspace.search_documents(
                ctx.context.request_context.principal,
                query=query,
                tag_id=None,
                category=None,
                actor_id=None,
                sort="relevance",
                limit=limit,
            )
            return {
                "results": [
                    self._document_source(document, snippet=document.search_snippet)
                    for document in documents
                ]
            }

        return await self._run_tool(ctx, self.policies["search_workspace"], query, operation)

    async def read_document(self, ctx: ToolContext, document_id: str) -> str:
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
        def operation() -> dict[str, Any]:
            proposal = self.proposals.create(
                ctx.context.request_context.principal,
                thread_id=ctx.context.thread.id,
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                content=content,
                summary=summary,
            )
            return {
                "proposal_id": proposal.proposal_id,
                "status": proposal.status,
                "message": "Waiting for human diff review and approval.",
            }

        return await self._run_tool(ctx, self.policies["propose_update"], summary, operation)

    async def create_document(self, ctx: ToolContext, title: str, content: str) -> None:
        normalized_title = " ".join(title.strip().split())
        if not normalized_title:
            raise ValidationError("Document title is required")
        ctx.context.client_tool_call = ClientToolCall(
            name="confirm_create_document",
            arguments={
                "title": normalized_title[:240],
                "content": self._bounded_text(content, self.max_result_bytes),
                "content_type": "text/markdown",
            },
        )

    async def publish_document(
        self, ctx: ToolContext, document_id: str, slug: str, access_policy: str
    ) -> None:
        if access_policy not in {"private", "unlisted", "public"}:
            raise ValidationError("Unsupported publication access policy")
        document = self.workspace.get_document(ctx.context.request_context.principal, document_id)
        if document.content_type == "application/pdf":
            raise ValidationError("PDF documents cannot be published")
        ctx.context.client_tool_call = ClientToolCall(
            name="confirm_publish_document",
            arguments={
                "document_id": document.document_id,
                "document_title": document.title,
                "slug": slug,
                "access_policy": access_policy,
            },
        )

    async def _run_tool(
        self,
        ctx: ToolContext,
        policy: ToolPolicy,
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
            payload = operation()
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
        return self._bounded_text(json.dumps(payload, ensure_ascii=False), self.max_result_bytes)

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
