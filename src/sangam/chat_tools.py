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
from sangam.capabilities import Capability
from sangam.chat_capabilities import (
    AnnotatePdfInput,
    AnnotationChange,
    ApplyWorkspaceOrganizationPlanInput,
    ChatCapability,
    ChatCapabilityRegistry,
    CreateDocumentInput,
    InspectProjectsInput,
    InspectWorkspaceOrganizationInput,
    ProjectChange,
    ProposalCitationInput,
    ProposeUpdateInput,
    PublicationChange,
    PublishDocumentInput,
    ReadDocumentInput,
    ReadPdfPageInput,
    ReadRevisionHistoryInput,
    UpdateProjectInput,
    UpdatePublicationInput,
    WorkspaceSearchInput,
)
from sangam.chat_context import ToolContext
from sangam.chat_effects import ChatEffectService
from sangam.chat_evidence import ChatEvidenceRepository
from sangam.chat_proposals import ChatProposalService
from sangam.chat_runtime import BoundedChatAdmission
from sangam.errors import NotFoundError, SangamError, ValidationError
from sangam.projects import ProjectService
from sangam.schemas import OrganizationOperation, ProjectSummary
from sangam.security import IdentityService, Principal


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
        runtime: BoundedChatAdmission,
        identity: IdentityService,
        projects: ProjectService,
        max_result_bytes: int,
    ) -> None:
        self.workspace = workspace
        self.proposals = proposals
        self.registry = registry
        self.effects = effects
        self.evidence = evidence
        self.runtime = runtime
        self.identity = identity
        self.projects = projects
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
                description_override=(
                    "Search authorized Sangam documents, optionally filtered by tag_id, "
                    "category, or content_type. Paginated: pass offset to page past the "
                    "first limit results."
                ),
            ),
            function_tool(
                self.read_revision_history,
                description_override=(
                    "List a document's revisions (newest first), or pass from_revision_id "
                    "to get a unified diff against to_revision_id (default: current)."
                ),
            ),
            function_tool(
                self.inspect_projects,
                description_override=(
                    "List projects, or pass project_id to open one with its member "
                    "documents, roles, and pinned pages."
                ),
            ),
            function_tool(
                self.inspect_workspace_organization,
                description_override=(
                    "Inspect bounded authorized workspace organization metadata before planning. "
                    "Use stable IDs and observed revision or metadata versions from this result."
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
                    "for HTML. Sangam pauses it for exact review in Review mode and "
                    "runs it without a prompt in YOLO mode. Never ask for confirmation "
                    "in prose before calling it."
                ),
            ),
            function_tool(
                self.apply_workspace_organization_plan,
                description_override=(
                    "After inspecting exact resources, call this tool for the user's requested "
                    "folder, move, category, or existing-tag changes. Include every observed "
                    "precondition and exact before/after path or metadata value. Sangam pauses "
                    "it for exact review in Review mode and runs it without a prompt in YOLO mode."
                ),
            ),
            function_tool(
                self.update_project,
                description_override=(
                    "Request one exact project change: create or edit a project, its member "
                    "documents, conversations, or annotations. Inspect projects first and use "
                    "stable IDs. Sangam "
                    "pauses it for exact review in Review mode and runs it without a prompt "
                    "in YOLO mode."
                ),
            ),
            function_tool(
                self.annotate_pdf,
                description_override=(
                    "When the user explicitly asks, add a note, comment, bookmark, or citation "
                    "marker to a PDF page, or edit or delete an annotation using the id and "
                    "version from read_pdf_page. Sangam pauses it for exact review in Review "
                    "mode and runs it without a prompt in YOLO mode."
                ),
            ),
            function_tool(
                self.update_publication,
                description_override=(
                    "When the user explicitly asks, withdraw a publication or change its slug, "
                    "access policy, or published revision. Use the publication id and version "
                    "from read_document. Sangam pauses it for exact review in Review mode and "
                    "runs it without a prompt in YOLO mode."
                ),
            ),
            function_tool(
                self.publish_document,
                description_override=(
                    "When the user explicitly requests publication, call this tool immediately. "
                    "Sangam pauses it for exact review in Review mode and runs it without a prompt "
                    "in YOLO mode, so never ask for confirmation in prose before calling it."
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

        def operation(principal: Principal) -> dict[str, Any]:
            if request_context.run_id and request_context.document_id:
                document = self.workspace.get_document(principal, request_context.document_id)
                self.evidence.record_run_source(
                    request_context.run_id,
                    document_id=document.document_id,
                    revision_id=request_context.pinned_revision_id,
                    title=document.title,
                    path=document.path,
                    page_number=request_context.pdf_page_number,
                )
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
        self,
        ctx: ToolContext,
        query: str,
        limit: int = 5,
        offset: int = 0,
        tag_id: str | None = None,
        category: str | None = None,
        content_type: Literal["text/markdown", "text/html", "application/pdf"] | None = None,
        sort: Literal["relevance", "updated", "title", "path"] = "relevance",
    ) -> str:
        validated = WorkspaceSearchInput.model_validate(
            {
                "query": query,
                "limit": limit,
                "offset": offset,
                "tag_id": tag_id,
                "category": category,
                "content_type": content_type,
                "sort": sort,
            }
        )

        def operation(principal: Principal) -> dict[str, Any]:
            documents = self.workspace.search_documents(
                principal,
                query=validated.query,
                tag_id=validated.tag_id,
                category=validated.category,
                actor_id=None,
                content_type=validated.content_type,
                sort=validated.sort,
                limit=validated.limit,
                offset=validated.offset,
            )
            run_id = ctx.context.request_context.run_id
            if run_id:
                for document in documents:
                    self.evidence.record_run_source(
                        run_id,
                        document_id=document.document_id,
                        revision_id=document.current_revision_id,
                        title=document.title,
                        path=document.path or "",
                    )
            return {
                "results": [
                    self._document_source(
                        document,
                        snippet=document.search_snippet,
                        # A hit inside a PDF names the page, so it can be cited there.
                        page_number=next(
                            (
                                match.page_number
                                for match in document.search_matches or []
                                if match.page_number is not None
                            ),
                            None,
                        ),
                    )
                    for document in documents
                ]
            }

        return await self._run_tool(
            ctx, self.policies["search_workspace"], validated.query, operation
        )

    async def inspect_workspace_organization(
        self,
        ctx: ToolContext,
        item_type: Literal["document", "folder", "tag"] | None = None,
        path_prefix: str | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> str:
        validated = InspectWorkspaceOrganizationInput.model_validate(
            {
                "item_type": item_type,
                "path_prefix": path_prefix,
                "offset": offset,
                "limit": limit,
            }
        )

        def operation(principal: Principal) -> dict[str, Any]:
            page = self.workspace.inspect_workspace_organization(
                principal,
                item_type=validated.item_type,
                path_prefix=validated.path_prefix,
                offset=validated.offset,
                limit=validated.limit,
            )
            return page.model_dump(mode="json")

        return await self._run_tool(
            ctx,
            self.policies["inspect_workspace_organization"],
            validated.path_prefix or validated.item_type or "workspace",
            operation,
        )

    async def read_document(
        self, ctx: ToolContext, document_id: str, offset: int = 0, limit: int = 20_000
    ) -> str:
        validated = ReadDocumentInput.model_validate(
            {"document_id": document_id, "offset": offset, "limit": limit}
        )
        document_id = validated.document_id

        def operation(principal: Principal) -> dict[str, Any]:
            document = self.workspace.get_document(principal, document_id)
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
                revision = self.workspace.get_revision(principal, document_id, pinned_revision)
                content = revision.content
                revision_id = revision.revision_id
            total_chars = len(content)
            run_id = ctx.context.request_context.run_id
            if run_id:
                self.evidence.record_run_source(
                    run_id,
                    document_id=document.document_id,
                    revision_id=revision_id,
                    title=document.title,
                    path=document.path or "",
                )
            backlinks = self.workspace.get_document_backlinks(
                principal, document_id=document_id, limit=20
            )
            publication = (
                self.workspace.document_publication(principal, document_id)
                if self.workspace.policy.allows(principal, Capability.PUBLISH, document.path)
                else None
            )
            return {
                "publication": None
                if publication is None
                else {
                    "publication_id": publication.publication_id,
                    "version": publication.version,
                    "slug": publication.slug,
                    "access_policy": publication.access_policy,
                    "active": publication.active,
                    "published_revision_id": publication.revision_id,
                    "url": publication.url,
                },
                "source": self._document_source(document, revision_id=revision_id, detail=True),
                "backlinks": [
                    self._document_source(linking, snippet=linking.search_snippet)
                    for linking in backlinks
                ],
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

        def operation(principal: Principal) -> dict[str, Any]:
            document = self.workspace.get_document(principal, document_id)
            if document.content_type != "application/pdf":
                raise ValidationError("The requested document is not a PDF")
            pages = self.workspace.pdf_pages(principal, document_id)
            page = next((item for item in pages if item.page_number == page_number), None)
            if page is None:
                raise NotFoundError(f"PDF page not found: {page_number}")
            run_id = ctx.context.request_context.run_id
            if run_id:
                self.evidence.record_run_source(
                    run_id,
                    document_id=document.document_id,
                    revision_id=document.current_revision_id,
                    title=document.title,
                    path=document.path or "",
                    page_number=page_number,
                )
            annotations = self.workspace.list_annotations(
                principal,
                document_id,
                page_number=page_number,
                query="",
                include_deleted=False,
            )
            return {
                "source": self._document_source(document, page_number=page_number, detail=True),
                "text": self._bounded_text(page.text),
                "annotations": [
                    {
                        "annotation_id": annotation.annotation_id,
                        "version": annotation.version,
                        "color": annotation.color,
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

    async def read_revision_history(
        self,
        ctx: ToolContext,
        document_id: str,
        from_revision_id: str | None = None,
        to_revision_id: str | None = None,
        limit: int = 20,
        cursor: str | None = None,
    ) -> str:
        validated = ReadRevisionHistoryInput.model_validate(
            {
                "document_id": document_id,
                "from_revision_id": from_revision_id,
                "to_revision_id": to_revision_id,
                "limit": limit,
                "cursor": cursor,
            }
        )

        def operation(principal: Principal) -> dict[str, Any]:
            document = self.workspace.get_document(
                principal, validated.document_id, include_deleted=True
            )
            result: dict[str, Any] = {"source": self._document_source(document, detail=True)}
            if validated.from_revision_id:
                diff = self.workspace.revision_diff(
                    principal,
                    document_id=validated.document_id,
                    from_revision_id=validated.from_revision_id,
                    to_revision_id=validated.to_revision_id,
                )
                text = diff.unified_diff
                result["diff"] = {
                    "from_revision_id": diff.from_revision_id,
                    "to_revision_id": diff.to_revision_id,
                    "unified_diff": self._bounded_text(text, 29_000),
                    "additions": diff.additions,
                    "deletions": diff.deletions,
                    "truncated": len(text.encode("utf-8")) > 29_000,
                }
                return result
            page = self.workspace.revision_page(
                principal, validated.document_id, limit=validated.limit, cursor=validated.cursor
            )
            result["revisions"] = [
                {
                    "revision_id": item.revision_id,
                    "parent_revision_id": item.parent_revision_id,
                    "actor_id": item.actor_id,
                    "operation": item.operation,
                    "summary": item.summary,
                    "created_at": item.created_at,
                }
                for item in page.items
            ]
            result["next_cursor"] = page.next_cursor
            return result

        return await self._run_tool(
            ctx, self.policies["read_revision_history"], validated.document_id, operation
        )

    async def inspect_projects(self, ctx: ToolContext, project_id: str | None = None) -> str:
        validated = InspectProjectsInput.model_validate({"project_id": project_id})

        def operation(principal: Principal) -> dict[str, Any]:
            if validated.project_id is None:
                return {
                    "projects": [
                        self._project_summary(project)
                        for project in self.projects.list_projects(principal)
                    ]
                }
            detail = self.projects.get_project(validated.project_id, principal)
            return {
                "projects": [],
                "project": {
                    **self._project_summary(detail),
                    "active_document_id": detail.active_document_id,
                    "active_thread_id": detail.active_thread_id,
                    "threads": [
                        {"thread_id": thread.thread_id, "title": thread.title}
                        for thread in detail.threads
                    ],
                    "annotations": [
                        {
                            "annotation_id": item.annotation_id,
                            "document_id": item.document_id,
                            "page_number": item.page_number,
                            "annotation_type": item.annotation_type,
                            "note": item.note,
                        }
                        for item in detail.annotations
                    ],
                    "documents": [
                        {
                            "document_id": member.document_id,
                            "title": member.document_title,
                            "path": member.document_path,
                            "role": member.role,
                            "pinned_page": member.pinned_page,
                            "notes": member.notes,
                            "source_updated": member.source_updated,
                        }
                        for member in detail.documents
                    ],
                },
            }

        return await self._run_tool(
            ctx,
            self.policies["inspect_projects"],
            validated.project_id or "all projects",
            operation,
        )

    async def annotate_pdf(self, ctx: ToolContext, change: AnnotationChange) -> str | None:
        arguments = AnnotatePdfInput.model_validate({"change": change}).model_dump(mode="json")
        return await self._request_effect(
            ctx,
            capability=self.policies["annotate_pdf"],
            arguments=arguments,
            preview=arguments,
        )

    async def update_publication(self, ctx: ToolContext, change: PublicationChange) -> str | None:
        arguments = UpdatePublicationInput.model_validate({"change": change}).model_dump(
            mode="json"
        )
        return await self._request_effect(
            ctx,
            capability=self.policies["update_publication"],
            arguments=arguments,
            preview=arguments,
        )

    async def update_project(self, ctx: ToolContext, change: ProjectChange) -> str | None:
        arguments = UpdateProjectInput.model_validate({"change": change}).model_dump(mode="json")
        return await self._request_effect(
            ctx,
            capability=self.policies["update_project"],
            arguments=arguments,
            preview=arguments,
        )

    @staticmethod
    def _project_summary(project: ProjectSummary) -> dict[str, Any]:
        return {
            "project_id": project.project_id,
            "name": project.name,
            "description": project.description,
            "brief_document_id": project.brief_document_id,
            "version": project.version,
            "document_count": project.document_count,
        }

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
        rationale: str | None = None,
        judgment_needed: str | None = None,
        model_opinion: str | None = None,
        citations: list[ProposalCitationInput] | None = None,
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
                "rationale": rationale,
                "judgment_needed": judgment_needed,
                "model_opinion": model_opinion,
                "citations": citations or [],
            }
        )

        def operation(principal: Principal) -> dict[str, Any]:
            request_context = ctx.context.request_context
            context_id = (
                request_context.context_snapshot_id
                if request_context.document_id is not None
                and request_context.pinned_revision_id is not None
                else None
            )
            proposal = self.proposals.create(
                principal,
                thread_id=ctx.context.thread.id,
                document_id=validated.document_id,
                expected_revision_id=validated.expected_revision_id,
                content=validated.content,
                summary=validated.summary,
                mode=validated.mode,
                anchor=validated.anchor,
                replace_all=validated.replace_all,
                context_id=context_id,
                run_id=request_context.run_id,
                rationale=validated.rationale,
                judgment_needed=validated.judgment_needed,
                model_opinion=validated.model_opinion,
                citations=validated.citations,
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
        self,
        ctx: ToolContext,
        title: str,
        content: str,
        content_type: str,
        path: str | None = None,
    ) -> str | None:
        normalized_title = " ".join(title.strip().split())
        arguments = CreateDocumentInput.model_validate(
            {
                "title": normalized_title,
                "content": content,
                "content_type": content_type,
                "path": path,
            }
        ).model_dump(mode="json")
        return await self._request_effect(
            ctx,
            capability=self.policies["create_document"],
            arguments=arguments,
            preview=arguments,
        )

    async def apply_workspace_organization_plan(
        self, ctx: ToolContext, operations: list[OrganizationOperation]
    ) -> str | None:
        validated = ApplyWorkspaceOrganizationPlanInput.model_validate({"operations": operations})
        arguments = validated.model_dump(mode="json")
        counts: dict[str, int] = {}
        for operation in validated.operations:
            counts[operation.kind] = counts.get(operation.kind, 0) + 1
        summary = ", ".join(
            f"{count} {kind.replace('_', ' ')}" for kind, count in sorted(counts.items())
        )
        return await self._request_effect(
            ctx,
            capability=self.policies["apply_workspace_organization_plan"],
            arguments=arguments,
            preview={**arguments, "summary": summary},
        )

    async def publish_document(
        self, ctx: ToolContext, document_id: str, slug: str, access_policy: str
    ) -> str | None:
        document = await self.runtime.run_sync(
            lambda: self.workspace.get_document(
                self.identity.reauthorize(ctx.context.request_context.principal), document_id
            )
        )
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
        if await self.runtime.run_sync(self.evidence.cancel_requested, request_context.run_id):
            raise ValidationError("The chat run was cancelled before this effect was requested")
        tool_call_id = getattr(ctx, "tool_call_id", None)
        if not tool_call_id:
            raise RuntimeError("Durable chat effects require a tool call ID")
        try:
            effect = await self.runtime.run_sync(
                self.effects.propose,
                request_context.principal,
                run_id=request_context.run_id,
                thread_id=ctx.context.thread.id,
                tool_call_id=tool_call_id,
                capability=capability,
                arguments=arguments,
                preview=preview,
            )
        except SangamError as error:
            await self.runtime.run_sync(
                self.evidence.record_tool,
                run_id=request_context.run_id,
                tool_call_id=tool_call_id,
                capability_id=capability.capability_id,
                capability_version=capability.version,
                effect_class=capability.effect,
                approval_policy=capability.approval,
                outcome="rejected",
                duration_ms=0,
                result_bytes=0,
                citation_count=0,
                error_class=error.code,
            )
            return json.dumps(
                {
                    "ok": False,
                    "error": {
                        "code": error.code,
                        "message": error.message,
                        "details": error.details,
                    },
                }
            )

        await self.runtime.run_sync(
            self.evidence.record_tool,
            run_id=request_context.run_id,
            tool_call_id=tool_call_id,
            capability_id=capability.capability_id,
            capability_version=capability.version,
            effect_class=capability.effect,
            approval_policy=capability.approval,
            outcome="accepted" if effect.status == "completed" else "pending_approval",
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
        return None

    async def _run_tool(
        self,
        ctx: ToolContext,
        policy: ChatCapability,
        detail: str,
        operation: Callable[[Principal], dict[str, Any]],
    ) -> str:
        """Run one tool against the run principal's current grants, bounded and traced."""
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
            run_id = ctx.context.request_context.run_id
            if run_id:
                cancelled = await self.runtime.run_sync(self.evidence.cancel_requested, run_id)
                if cancelled:
                    raise ValidationError("The chat run was cancelled before this tool executed")
            run_principal = ctx.context.request_context.principal
            payload = await asyncio.wait_for(
                self.runtime.run_sync(lambda: operation(self.identity.reauthorize(run_principal))),
                timeout=policy.timeout_seconds,
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
        run_id = ctx.context.request_context.run_id
        if run_id:
            await self.runtime.run_sync(
                self.evidence.record_tool,
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
        detail: bool = False,
    ) -> dict[str, Any]:
        """A citable source. `detail` adds what the UI shows beside a document."""
        data = {
            "document_id": document.document_id,
            "title": document.title,
            "revision_id": revision_id or document.current_revision_id,
        }
        if page_number is not None:
            data["page_number"] = page_number
        deeplink = f"chatkit-link://document?{urlencode(data)}"
        source: dict[str, Any] = {
            **data,
            "path": document.path,
            "snippet": snippet,
            "citation": deeplink,
        }
        if detail:
            source.update(
                category=document.category,
                tags=[tag.name for tag in document.tags],
                trust_level=document.trust_level,
                deleted=document.deleted,
                pdf_extraction_status=document.pdf_extraction_status,
                pdf_page_count=document.pdf_page_count,
            )
        return source

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
