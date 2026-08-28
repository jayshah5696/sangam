from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from typing import Any, Literal
from urllib.parse import urlencode

from agents import function_tool
from chatkit.agents import ClientToolCall
from chatkit.types import CustomTask

from sangam.access import WorkspaceAccessService
from sangam.chat_capabilities import (
    ApplyOrganizationPlanInput,
    ChatCapability,
    ChatCapabilityRegistry,
    CreateDocumentInput,
    InspectOrganizationInput,
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
        auto_approve_check: Callable[[], bool] | None = None,
    ) -> None:
        self.workspace = workspace
        self.proposals = proposals
        self.registry = registry
        self.effects = effects
        self.evidence = evidence
        self.max_result_bytes = max_result_bytes
        self.policies = registry.by_id
        self._auto_approve_check = auto_approve_check or (lambda: False)

    def as_agent_tools(self, capabilities: tuple[ChatCapability, ...] | None = None) -> list[Any]:
        tools = [
            function_tool(
                self.inspect_workspace_organization,
                description_override=(
                    "Inspect workspace folders, documents, and tags. Use to discover "
                    "current paths, revision IDs, metadata versions, and tag assignments "
                    "before proposing an organization plan. Paginated: pass offset to "
                    "page past the first limit results."
                ),
            ),
            function_tool(
                self.apply_workspace_organization_plan,
                description_override=(
                    "Execute an exact workspace organization plan. Each operation must "
                    "include observed preconditions (revision IDs, metadata versions, "
                    "source paths). Supported operation kinds: move_document, move_folder, "
                    "create_folder, update_document_metadata, update_folder_metadata. "
                    "The plan is shown to the user for one approval before execution. "
                    "Never claim changes were made before approval."
                ),
            ),
            function_tool(
                self.get_editor_selection,
                description_override="Read selected text from the active Sangam editor.",
            ),
            function_tool(
                self.search_workspace,
                description_override=(
                    "Search authorized Sangam documents. Paginated: pass offset to "
                    "page past the first limit results."
                ),
            ),
            function_tool(
                self.read_document,
                description_override=(
                    "Read one authorized Markdown or HTML document. Long documents are "
                    "paginated: pass offset (character position) to page through; check "
                    "total_chars and truncated in the result."
                ),
            ),
            function_tool(
                self.read_pdf_page,
                description_override="Read one PDF page and its current annotations.",
            ),
            function_tool(
                self.propose_update,
                description_override=(
                    "Create a revision-pinned edit proposal. Prefer patch modes: "
                    "mode='replace' replaces an exact anchor string with new text (set "
                    "replace_all for every occurrence); mode='insert_before'/"
                    "'insert_after' insert relative to an anchor; mode='append' adds to "
                    "the end. Use mode='full' only for small documents. This never "
                    "applies the edit; a human reviews the diff."
                ),
            ),
            function_tool(
                self.create_document,
                description_override=(
                    "When the user explicitly requests a new document, call this tool "
                    "immediately with the complete title, content, and content_type. "
                    "Set content_type to 'text/markdown' for Markdown or 'text/html' "
                    "for HTML. The tool opens Sangam's browser confirmation UI. Never "
                    "ask for confirmation in prose before calling it."
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

    async def search_workspace(
        self, ctx: ToolContext, query: str, limit: int = 5, offset: int = 0
    ) -> str:
        validated = WorkspaceSearchInput.model_validate(
            {"query": query, "limit": limit, "offset": offset}
        )

        def operation() -> dict[str, Any]:
            documents = self.workspace.search_documents(
                ctx.context.request_context.principal,
                query=validated.query,
                tag_id=None,
                category=None,
                actor_id=None,
                sort="relevance",
                limit=validated.limit,
                offset=validated.offset,
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

    async def read_document(
        self, ctx: ToolContext, document_id: str, offset: int = 0, limit: int = 20_000
    ) -> str:
        validated = ReadDocumentInput.model_validate(
            {"document_id": document_id, "offset": offset, "limit": limit}
        )
        document_id = validated.document_id

        def operation() -> dict[str, Any]:
            document = self.workspace.get_document(
                ctx.context.request_context.principal, document_id
            )
            if document.content_type == "application/pdf":
                raise ValidationError("Use read_pdf_page for PDF documents")
            pinned_revision = ctx.context.request_context.pinned_revision_id
            content = document.content
            revision_id = document.current_revision_id
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
                content = revision.content
                revision_id = revision.revision_id
            total_chars = len(content)
            return {
                "source": self._document_source(document, revision_id=revision_id),
                "content": content[validated.offset : validated.offset + validated.limit],
                "offset": validated.offset,
                "limit": validated.limit,
                "total_chars": total_chars,
                "truncated": validated.offset + validated.limit < total_chars,
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
        summary: str,
        content: str = "",
        mode: Literal["full", "replace", "insert_before", "insert_after", "append"] = "full",
        anchor: str | None = None,
        replace_all: bool = False,
    ) -> str:
        validated = ProposeUpdateInput.model_validate(
            {
                "document_id": document_id,
                "expected_revision_id": expected_revision_id,
                "content": content,
                "mode": mode,
                "anchor": anchor,
                "replace_all": replace_all,
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
                mode=validated.mode,
                anchor=validated.anchor,
                replace_all=validated.replace_all,
            )
            return {
                "proposal_id": proposal.proposal_id,
                "status": proposal.status,
                "message": "Waiting for human diff review and approval.",
            }

        return await self._run_tool(
            ctx, self.policies["propose_update"], validated.summary, operation
        )

    async def create_document(
        self, ctx: ToolContext, title: str, content: str, content_type: str
    ) -> str | None:
        normalized_title = " ".join(title.strip().split())
        arguments = CreateDocumentInput.model_validate(
            {
                "title": normalized_title,
                "content": content,
                "content_type": content_type,
            }
        ).model_dump(mode="json")
        return await self._request_effect(
            ctx,
            capability=self.policies["create_document"],
            arguments=arguments,
            preview=arguments,
        )

    async def publish_document(
        self, ctx: ToolContext, document_id: str, slug: str, access_policy: str
    ) -> str | None:
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
        return await self._request_effect(
            ctx,
            capability=self.policies["publish_document"],
            arguments=arguments,
            preview={**arguments, "document_title": document.title},
        )

    async def inspect_workspace_organization(
        self,
        ctx: ToolContext,
        path_prefix: str | None = None,
        document_ids: list[str] | None = None,
        folder_ids: list[str] | None = None,
        tag_ids: list[str] | None = None,
        include_documents: bool = True,
        include_folders: bool = True,
        include_tags: bool = True,
        offset: int = 0,
        limit: int = 50,
    ) -> str:
        validated = InspectOrganizationInput.model_validate(
            {
                "path_prefix": path_prefix,
                "document_ids": document_ids or [],
                "folder_ids": folder_ids or [],
                "tag_ids": tag_ids or [],
                "include_documents": include_documents,
                "include_folders": include_folders,
                "include_tags": include_tags,
                "offset": offset,
                "limit": limit,
            }
        )

        def operation() -> dict[str, Any]:
            principal = ctx.context.request_context.principal
            all_documents = self.workspace.search_documents(
                principal,
                query="",
                tag_id=None,
                category=None,
                actor_id=None,
                sort="path",
                limit=10000,
                offset=0,
            )
            all_folders = self.workspace.list_folders(principal)
            all_tags = self.workspace.list_tags(principal)

            # Filter documents
            docs = [d for d in all_documents if not d.deleted]
            if validated.path_prefix:
                prefix = validated.path_prefix.rstrip("/") + "/"
                docs = [d for d in docs if d.path and d.path.startswith(prefix)]
            if validated.document_ids:
                id_set = set(validated.document_ids)
                docs = [d for d in docs if d.document_id in id_set]

            # Filter folders
            folders = list(all_folders)
            if validated.path_prefix:
                prefix = validated.path_prefix.rstrip("/")
                folders = [
                    f for f in folders if f.path == prefix or f.path.startswith(prefix + "/")
                ]
            if validated.folder_ids:
                id_set = set(validated.folder_ids)
                folders = [f for f in folders if f.folder_id in id_set]

            # Filter tags
            tags = list(all_tags)
            if validated.tag_ids:
                id_set = set(validated.tag_ids)
                tags = [t for t in tags if t.tag_id in id_set]

            total_documents = len(docs)
            total_folders = len(folders)
            total_tags = len(tags)

            # Paginate documents
            paged_docs = docs[validated.offset : validated.offset + validated.limit]

            result_docs = (
                [
                    {
                        "document_id": d.document_id,
                        "title": d.title,
                        "content_type": d.content_type,
                        "path": d.path,
                        "current_revision_id": d.current_revision_id,
                        "metadata_version": d.metadata_version,
                        "category": d.category,
                        "tag_ids": [t.tag_id for t in d.tags],
                        "deleted": d.deleted,
                    }
                    for d in paged_docs
                ]
                if validated.include_documents
                else []
            )

            result_folders = (
                [
                    {
                        "folder_id": f.folder_id,
                        "path": f.path,
                        "metadata_version": f.metadata_version,
                        "category": f.category,
                        "tag_ids": [t.tag_id for t in f.tags],
                        "document_count": f.document_count,
                    }
                    for f in folders
                ]
                if validated.include_folders
                else []
            )

            result_tags = (
                [{"tag_id": t.tag_id, "name": t.name, "color": t.color} for t in tags]
                if validated.include_tags
                else []
            )

            truncated = validated.offset + validated.limit < total_documents
            return {
                "documents": result_docs,
                "folders": result_folders,
                "tags": result_tags,
                "total_documents": total_documents,
                "total_folders": total_folders,
                "total_tags": total_tags,
                "offset": validated.offset,
                "limit": validated.limit,
                "truncated": truncated,
            }

        detail = f"prefix={validated.path_prefix or '*'} offset={validated.offset}"
        return await self._run_tool(
            ctx, self.policies["inspect_workspace_organization"], detail, operation
        )

    async def apply_workspace_organization_plan(
        self,
        ctx: ToolContext,
        operations_json: str,
        summary: str,
    ) -> str | None:
        """Accept a JSON-encoded list of operations and validate it."""
        try:
            operations = json.loads(operations_json)
        except (json.JSONDecodeError, TypeError) as error:
            raise ValidationError(
                "operations_json must be valid JSON", details={"error": str(error)}
            ) from error
        if not isinstance(operations, list):
            raise ValidationError("operations_json must encode a JSON array")
        validated = ApplyOrganizationPlanInput.model_validate(
            {"operations": operations, "summary": summary}
        )
        arguments = validated.model_dump(mode="json")
        # Build a human-readable preview of the plan
        preview_ops = []
        for op in validated.operations:
            entry = op.model_dump(mode="json")
            preview_ops.append(entry)
        preview: dict[str, object] = {
            "operations": preview_ops,
            "summary": validated.summary,
            "operation_count": len(validated.operations),
        }
        return await self._request_effect(
            ctx,
            capability=self.policies["apply_workspace_organization_plan"],
            arguments=arguments,
            preview=preview,
        )

    async def _request_effect(
        self,
        ctx: ToolContext,
        *,
        capability: ChatCapability,
        arguments: dict[str, object],
        preview: dict[str, object],
    ) -> str | None:
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
        # YOLO mode: auto-approve and execute without user review
        if self._auto_approve_check():
            result = self.effects.decide(
                request_context.principal,
                effect_id=effect.effect_id,
                verdict="approve",
                argument_digest=effect.argument_digest,
                reason="Auto-approved (YOLO mode)",
            )
            result_json = json.dumps(result.client_result)
            self.evidence.record_tool(
                run_id=request_context.run_id,
                tool_call_id=tool_call_id,
                capability_id=capability.capability_id,
                capability_version=capability.version,
                effect_class=capability.effect,
                approval_policy=capability.approval,
                outcome="auto_approved",
                duration_ms=0,
                result_bytes=len(result_json),
                citation_count=0,
                error_class=None,
            )
            return result_json
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
