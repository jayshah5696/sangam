"""One compact MCP entry point over Sangam's existing authorized services."""

import asyncio
import hashlib
import json
import sys
from collections.abc import Callable
from contextlib import AsyncExitStack
from functools import partial
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import unquote
from uuid import uuid4

from mcp.server import MCPServer
from mcp.server.apps import Apps
from mcp.server.mcpserver.context import Context
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import Field, JsonValue, TypeAdapter
from pydantic import ValidationError as SchemaError
from pydantic_monty import AsyncMonty, MontyError
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from sangam.application import ApplicationServices
from sangam.assistant_requests import AssistantResult, ConversationPage
from sangam.capabilities import Capability
from sangam.config import Settings
from sangam.errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    IdempotencyError,
    SangamError,
    ValidationError,
)
from sangam.mcp_events import ResourceSubscriptions
from sangam.mcp_inspection import DiffPassage, InspectionReads, ProposalPage, ProposalPassage
from sangam.mcp_models import (
    ActivateDocument,
    AppAction,
    ApplyProposal,
    CancelAssistant,
    CloseDocument,
    CompareDocument,
    CreateProposal,
    DismissProposal,
    DocumentPassage,
    ExecutionFailure,
    ExecutionOutput,
    ExecutionReceipt,
    ExecutionStatus,
    GetAssistant,
    GetProposal,
    GetSkill,
    ListProposals,
    ListSkills,
    OpenDocument,
    OperationInput,
    PdfAnnotations,
    PdfBytes,
    PdfCreateAnnotation,
    PdfReadPage,
    PdfSearch,
    PdfStatus,
    PendingAssistantJob,
    PendingJob,
    ProposalApplyApp,
    ProposalCreateApp,
    ProposalDismissApp,
    ProposalListApp,
    ProposalReadApp,
    ReadConversation,
    ReadDiff,
    ReadDocument,
    ReadHistory,
    ReadSkill,
    RefreshWorkspace,
    RevisionReadApp,
    SearchApp,
    SearchDocuments,
    SearchHit,
    SearchResults,
    SubmitAssistant,
    UpdateDocument,
    UpdateView,
    WaitAssistant,
    WorkspaceOperation,
    WriteResult,
)
from sangam.mcp_pdf import (
    PdfAnnotationResult,
    PdfAnnotationWrite,
    PdfOperations,
    PdfPageResult,
    PdfSearchResult,
    PdfStatusResult,
)
from sangam.mcp_proposals import ProposalMutationError, ProposalOperations, ProposalWriteResult
from sangam.mcp_skills import SkillCatalog, SkillEntry, SkillExports, SkillPassage, SkillsExtension
from sangam.mcp_state import McpState
from sangam.schemas import RevisionPage
from sangam.schemas import UpdateDocument as DocumentUpdate
from sangam.security import Principal

APP_URI = "ui://sangam/document-workspace.html"
JSON_VALUE: TypeAdapter[JsonValue] = TypeAdapter(JsonValue)
JSON_OBJECT: TypeAdapter[dict[str, JsonValue]] = TypeAdapter(dict[str, JsonValue])
OPERATIONS: dict[str, tuple[type[OperationInput], str, str, str, str]] = {
    "proposals.create": (
        CreateProposal,
        "proposals_create",
        "write",
        "read, update",
        "Prepare an owned proposal against an exact revision without changing document content. "
        "Requires a stable operation_key. Creates no conversation and never automatically applies.",
    ),
    "proposals.apply": (
        ApplyProposal,
        "proposals_apply",
        "write",
        "ownership, read, update",
        "Commit exact reviewed content against the proposal base using existing write authority. "
        "Retain operation_key and content for retries. A stale base conflicts; no auto-rebase.",
    ),
    "proposals.dismiss": (
        DismissProposal,
        "proposals_dismiss",
        "write",
        "ownership, read",
        "Dismiss an owned pending or stale proposal without changing its document. "
        "Retain the operation_key and exact reason for retries.",
    ),
    "documents.history": (
        ReadHistory,
        "documents_history",
        "read",
        "read",
        "Read revision metadata without full document bodies. Follow next_cursor for more history.",
    ),
    "documents.diff": (
        ReadDiff,
        "documents_diff",
        "read",
        "read",
        "Compare two exact text revision IDs as a bounded unified diff. "
        "Follow next_offset; this does not compare PDF bytes.",
    ),
    "proposals.list": (
        ListProposals,
        "proposals_list",
        "read",
        "ownership, read",
        "List permitted owned proposal metadata, optionally by document or known conversation. "
        "Follow next_offset. Listing does not apply or dismiss a proposal.",
    ),
    "proposals.get": (
        GetProposal,
        "proposals_get",
        "read",
        "ownership, read",
        "Inspect bounded proposed or applied wording and exact revision references. "
        "Set include_evidence to inspect currently authorized citations and sources. "
        "Unavailable sources are marked explicitly; proposed text is not a saved revision.",
    ),
    "assistant.submit": (
        SubmitAssistant,
        "assistant_submit",
        "write",
        "inference, current source access",
        "Send an explicit message and optional document context to Sangam's assistant. "
        "Retain request_key for exact replay. After a lost response, "
        "never retry inference with a new key. "
        "A bounded wait may return running work. Existing chat review behavior applies.",
    ),
    "assistant.get": (
        GetAssistant,
        "assistant_get",
        "read",
        "ownership, current source access",
        "Read a known owned request and bounded answer with status and artifact references.",
    ),
    "assistant.wait": (
        WaitAssistant,
        "assistant_wait",
        "read",
        "ownership, current source access",
        "Wait up to two seconds for an owned request; running work is not success. "
        "Follow next_offset for answer passages.",
    ),
    "assistant.cancel": (
        CancelAssistant,
        "assistant_cancel",
        "write",
        "ownership, current source access",
        "Cooperatively cancel an owned request. Previously committed changes remain.",
    ),
    "conversations.read": (
        ReadConversation,
        "conversations_read",
        "read",
        "ownership, current source access",
        "Read bounded messages from an explicitly supplied owned conversation. "
        "Follow next_cursor for message pages or item_id/offset for a long message. "
        "This does not search conversation history or export profiles.",
    ),
    "skills.list": (
        ListSkills,
        "skills_list",
        "read",
        "read",
        "Find registered guidance under current read grants. "
        "Returns immutable file manifests; follow next_offset.",
    ),
    "skills.get": (
        GetSkill,
        "skills_get",
        "read",
        "read",
        "Export a complete skill snapshot by skill_id. Files require current read access. "
        "Instructions do not grant authority.",
    ),
    "skills.read": (
        ReadSkill,
        "skills_read",
        "read",
        "read",
        "Read a pinned skill file passage or binary chunk. Text offsets count characters; "
        "binary offsets count bytes. Follow next_offset. Does not activate skills or run scripts.",
    ),
    "documents.search": (
        SearchDocuments,
        "documents_search",
        "read",
        "search, read",
        "Search permitted Markdown and PDF documents. Paginate with offset; "
        "results are current revision metadata.",
    ),
    "documents.read": (
        ReadDocument,
        "documents_read",
        "read",
        "read",
        "Read a bounded Markdown or HTML passage from the current or an exact revision. "
        "revision_id identifies the content; current_revision_id identifies the current head. "
        "offset and length count characters. Read current content before writing.",
    ),
    "documents.update": (
        UpdateDocument,
        "documents_update",
        "write",
        "update",
        "Update a Markdown document using expected_revision_id and a stable operation_key. "
        "Reuse the original key and exact arguments after a lost response.",
    ),
    "executions.get": (
        ExecutionStatus,
        "executions_get",
        "read",
        "current source access",
        "Inspect an owned execution and original write evidence. "
        "Never replay the original program to recover.",
    ),
    "pdf.status": (
        PdfStatus,
        "pdf_status",
        "read",
        "read",
        "Read durable PDF extraction status and a checkable resource reference.",
    ),
    "pdf.pages.read": (
        PdfReadPage,
        "pdf_pages_read",
        "read",
        "read",
        "Read one bounded extracted PDF page passage; pending extraction is explicit.",
    ),
    "pdf.search": (
        PdfSearch,
        "pdf_search",
        "read",
        "search, read",
        "Search extracted PDF pages with pagination and page references.",
    ),
    "pdf.annotations.list": (
        PdfAnnotations,
        "pdf_annotations_list",
        "read",
        "read",
        "Read notes and annotations for a PDF page.",
    ),
    "pdf.annotations.create": (
        PdfCreateAnnotation,
        "pdf_annotations_create",
        "write",
        "update",
        "Add a PDF note or highlight with a stable operation_key. PDF bytes remain immutable.",
    ),
}
OUTPUT_SCHEMAS = {
    "proposals.create": ProposalWriteResult.model_json_schema(),
    "proposals.apply": ProposalWriteResult.model_json_schema(),
    "proposals.dismiss": ProposalWriteResult.model_json_schema(),
    "documents.history": RevisionPage.model_json_schema(),
    "documents.diff": DiffPassage.model_json_schema(),
    "proposals.list": ProposalPage.model_json_schema(),
    "proposals.get": ProposalPassage.model_json_schema(),
    "assistant.submit": AssistantResult.model_json_schema(),
    "assistant.get": AssistantResult.model_json_schema(),
    "assistant.wait": AssistantResult.model_json_schema(),
    "assistant.cancel": AssistantResult.model_json_schema(),
    "conversations.read": ConversationPage.model_json_schema(),
    "skills.list": SkillCatalog.model_json_schema(),
    "skills.get": SkillEntry.model_json_schema(),
    "skills.read": SkillPassage.model_json_schema(),
    "documents.search": SearchResults.model_json_schema(),
    "documents.read": DocumentPassage.model_json_schema(),
    "documents.update": WriteResult.model_json_schema(),
    "pdf.status": PdfStatusResult.model_json_schema(),
    "pdf.pages.read": PdfPageResult.model_json_schema(),
    "pdf.search": PdfSearchResult.model_json_schema(),
    "pdf.annotations.list": PdfAnnotationResult.model_json_schema(),
    "pdf.annotations.create": PdfAnnotationWrite.model_json_schema(),
    "executions.get": TypeAdapter(
        ExecutionOutput | ExecutionFailure | ExecutionReceipt
    ).json_schema(),
}


def result(value: dict[str, JsonValue], *, failed: bool = False) -> CallToolResult:
    return CallToolResult(
        content=[
            TextContent(type="text", text=json.dumps(value, ensure_ascii=False, allow_nan=False))
        ],
        structured_content=value,
        is_error=failed,
    )


def failure(error: SangamError) -> CallToolResult:
    return result({"error": {"code": error.code, "message": error.message}}, failed=True)


class PrivateMcp:
    """Authenticate the mounted ASGI transport, including discovery and resources."""

    def __init__(self, app: ASGIApp, services: ApplicationServices) -> None:
        self.app = app
        self.services = services

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            header = Headers(scope=scope).get("authorization", "")
            scheme, _, token = header.partition(" ")
            try:
                if scheme.lower() != "bearer" or not token.strip():
                    raise AuthenticationError("An explicit Sangam bearer key is required for MCP.")
                await asyncio.to_thread(
                    self.services.identity.authenticate,
                    token.strip(),
                    operation_id=f"mcp:{uuid4().hex}",
                )
            except AuthenticationError:
                response = JSONResponse(
                    {"error": "authentication_required"},
                    status_code=401,
                    headers={
                        "WWW-Authenticate": 'Bearer realm="Sangam MCP"',
                        "Cache-Control": "no-store",
                    },
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


class McpEndpointPath:
    """Route both endpoint spellings through the authenticated MCP mount."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        root = scope.get("root_path", "").rstrip("/")
        if scope["type"] == "http" and scope["path"] in {"/mcp", f"{root}/mcp"}:
            scope = dict(scope)
            scope["path"] += "/"
            if "raw_path" in scope:
                scope["raw_path"] += b"/"
        await self.app(scope, receive, send)


class SangamMcp:
    def __init__(self, services: ApplicationServices, settings: Settings) -> None:
        self.services = services
        self.settings = settings
        self.state = McpState(services, settings)
        self.pdf = PdfOperations(services, self.state)
        self.skills = SkillExports(services, self.state)
        self.inspection = InspectionReads(services, self.state)
        self.proposals = ProposalOperations(services, self.state, self.inspection)
        skills_extension = SkillsExtension(self.skills, self.principal)
        self.active = 0
        self.closing = False
        self.pending: set[asyncio.Task[Any]] = set()
        self.stack = AsyncExitStack()
        self.pool = AsyncMonty(
            binary_path=Path(sys.executable).parent / "sangam-monty-worker",
            min_processes=0,
            max_processes=2,
            max_checkouts_per_worker=1,
            checkout_timeout=1.0,
            request_timeout=5.0,
        )
        self.server = MCPServer(
            "Sangam",
            extensions=[Apps(), skills_extension],
            middleware=[ResourceSubscriptions(self.read_resource), skills_extension],
            version="0.1.0",
            instructions=(
                "Use search to discover typed operations, then execute restricted Python "
                "with a fresh execution_key. Only the final expression is returned. "
                "Read before updating; retain operation keys. Present opens the editable "
                "document App. Saved writes survive Python failure. Inspect executions.get "
                "after interruption; never replay a mutating program."
            ),
        )
        self._register()
        allowed_origins: list[str] = []
        for host in settings.mcp_allowed_hosts:
            allowed_origins.extend((f"http://{host}", f"https://{host}"))
        transport = self.server.streamable_http_app(
            streamable_http_path="/",
            stateless_http=True,
            json_response=True,
            max_request_body_size=settings.max_document_bytes
            + settings.mcp_max_source_bytes
            + 16_384,
            transport_security=TransportSecuritySettings(
                enable_dns_rebinding_protection=True,
                allowed_hosts=list(settings.mcp_allowed_hosts),
                allowed_origins=allowed_origins,
            ),
        )
        self.app = PrivateMcp(transport, services)

    async def start(self) -> None:
        self.state.interrupt_previous_runs()
        self.state.cleanup()
        await self.stack.enter_async_context(self.pool)
        await self.stack.enter_async_context(self.server.session_manager.run())

    async def close(self) -> None:
        self.closing = True
        await self.stack.aclose()
        if self.pending:
            # A cancelled host wait cannot cancel a SQLite commit on its thread.
            # Drain it before api.py closes services or releases storage ownership.
            await asyncio.wait_for(
                asyncio.gather(*self.pending, return_exceptions=True), timeout=10
            )

    async def blocking[T](self, operation: Callable[[], T]) -> T:
        if self.closing:
            raise ValidationError("MCP is shutting down. Reconnect and inspect the original keys.")
        task = asyncio.create_task(asyncio.to_thread(operation))
        self.pending.add(task)
        task.add_done_callback(self.pending.discard)
        return await asyncio.shield(task)

    @staticmethod
    def credential(ctx: Context) -> str:
        headers = ctx.headers or {}
        value = headers.get("authorization", "")
        return value.partition(" ")[2].strip()

    def principal(self, token: str) -> Principal:
        return self.services.identity.authenticate(token, operation_id=f"mcp:{uuid4().hex}")

    def _register(self) -> None:
        @self.server.tool(annotations=ToolAnnotations(read_only_hint=True, open_world_hint=False))
        async def search(
            query: Annotated[str, Field(max_length=500)],
            ctx: Context,
            limit: Annotated[int, Field(ge=1, le=5)] = 5,
            offset: Annotated[int, Field(ge=0, le=100_000)] = 0,
        ) -> CallToolResult:
            """Discover complete operation contracts. Follow next_offset for more results."""
            self.principal(self.credential(ctx))
            terms = query.lower().replace("_", ".").split()
            matches = []
            for operation_id, (
                schema,
                callable_name,
                effect,
                permissions,
                description,
            ) in OPERATIONS.items():
                text = f"{operation_id} {description}".lower()
                score = sum(term in text for term in terms)
                if score or not terms:
                    matches.append(
                        (
                            score,
                            operation_id,
                            {
                                "operation_id": operation_id,
                                "contract_version": 1,
                                "callable": callable_name,
                                "effect": effect,
                                "permissions": permissions,
                                "description": description,
                                "input_schema": schema.model_json_schema(),
                                "output_schema": OUTPUT_SCHEMAS[operation_id],
                                "invocation": f"await {callable_name}(**keyword_arguments)",
                            },
                        )
                    )
            matches.sort(key=lambda item: (-item[0], item[1]))
            return result(
                JSON_OBJECT.validate_python(
                    {
                        "operations": [item[2] for item in matches[offset : offset + limit]],
                        "next_offset": offset + limit if offset + limit < len(matches) else None,
                    }
                )
            )

        @self.server.tool(
            annotations=ToolAnnotations(
                read_only_hint=False,
                destructive_hint=True,
                idempotent_hint=False,
                open_world_hint=False,
            )
        )
        async def execute(code: str, execution_key: str, ctx: Context) -> CallToolResult:
            """Run fresh restricted Python; return its final expression and retain recovery keys."""
            token = self.credential(ctx)
            try:
                return await self.execute(token, code, execution_key)
            except SangamError as error:
                return failure(error)

        @self.server.tool(
            meta={"ui": {"resourceUri": APP_URI}},
            annotations=ToolAnnotations(
                read_only_hint=False, destructive_hint=False, open_world_hint=False
            ),
        )
        async def present(
            ctx: Context,
            document_id: str | None = None,
            workspace_id: str | None = None,
            additional_document_ids: list[str] | None = None,
            layout_id: str | None = None,
        ) -> CallToolResult:
            """Open a Markdown/PDF App, or reopen an explicit recoverable workspace."""
            try:
                principal = self.principal(self.credential(ctx))
                self.state.cleanup()
                if layout_id:
                    if document_id or workspace_id or additional_document_ids:
                        raise ValidationError(
                            "Reopen with layout_id alone, or open with document_id "
                            "and optional document references."
                        )
                    return result(
                        await self.blocking(partial(self.state.restore, principal, layout_id))
                    )
                if document_id is None:
                    raise ValidationError(
                        "Provide document_id to open documents, or layout_id to reopen a workspace."
                    )
                value = await self.blocking(
                    partial(
                        self.state.open,
                        principal,
                        document_id,
                        workspace_id=workspace_id,
                        additional_document_ids=additional_document_ids,
                    )
                )
                return result(value)
            except SangamError as error:
                return failure(error)

        @self.server.tool(
            meta={"ui": {"visibility": ["app"]}},
            annotations=ToolAnnotations(
                read_only_hint=False, destructive_hint=False, open_world_hint=False
            ),
        )
        async def mcp_app(action: AppAction, ctx: Context) -> CallToolResult:
            """Typed document App interactions under the connection's current grants."""
            try:
                principal = self.principal(self.credential(ctx))
                if isinstance(
                    action,
                    (
                        ProposalListApp,
                        ProposalReadApp,
                        ProposalCreateApp,
                        ProposalApplyApp,
                        ProposalDismissApp,
                        RevisionReadApp,
                    ),
                ):
                    return result(
                        await self.blocking(partial(self.proposals.app, principal, action))
                    )
                if isinstance(action, PdfBytes):
                    return result(await self.blocking(partial(self.pdf.bytes, principal, action)))
                if isinstance(
                    action, (PdfReadPage, PdfSearch, PdfAnnotations, PdfCreateAnnotation)
                ):
                    return result(await self.blocking(partial(self.pdf.invoke, principal, action)))
                if isinstance(action, SearchApp):
                    response = await asyncio.to_thread(
                        self.search_documents,
                        principal,
                        SearchDocuments(
                            query=action.query, limit=action.limit, offset=action.offset
                        ),
                    )
                    return result(response.model_dump(mode="json"))
                if isinstance(action, RefreshWorkspace):
                    return result(
                        await asyncio.to_thread(self.state.read, principal, action.workspace_id)
                    )
                if isinstance(
                    action, (OpenDocument, ActivateDocument, CloseDocument, CompareDocument)
                ):
                    return result(
                        await self.blocking(partial(self.state.navigate, principal, action))
                    )
                if isinstance(action, UpdateView):
                    return result(
                        await self.blocking(partial(self.state.update_view, principal, action))
                    )
                return result(await self.blocking(partial(self.state.change, principal, action)))
            except ProposalMutationError as error:
                return result(
                    {
                        "error": {"code": error.code, "message": error.message},
                        "mutation": {"operation_key": error.key, "outcome": error.outcome},
                    },
                    failed=True,
                )
            except SangamError as error:
                return failure(error)

        @self.server.resource(APP_URI, mime_type="text/html;profile=mcp-app")
        def app_html() -> str:
            path = self.settings.frontend_dist / "mcp-app" / "mcp-app.html"
            if not path.is_file():
                raise ValidationError("MCP App assets are not built. Run just build-frontend.")
            return path.read_text()

        @self.server.resource("sangam://execution/{execution_key}", mime_type="application/json")
        def execution_resource(execution_key: str, ctx: Context) -> str:
            """Inspect recovery evidence even when new execution admission is full."""
            return json.dumps(
                self.read_resource(self.credential(ctx), f"sangam://execution/{execution_key}"),
                allow_nan=False,
            )

        @self.server.resource("sangam://workspace/{workspace_id}", mime_type="application/json")
        def workspace_resource(workspace_id: str, ctx: Context) -> str:
            return json.dumps(
                self.read_resource(self.credential(ctx), f"sangam://workspace/{workspace_id}")
            )

        @self.server.resource("sangam://document/{document_id}", mime_type="application/json")
        def document_resource(document_id: str, ctx: Context) -> str:
            return json.dumps(
                self.read_resource(self.credential(ctx), f"sangam://document/{document_id}")
            )

        @self.server.resource("sangam://skill/{skill_id}", mime_type="application/json")
        def skill_resource(skill_id: str, ctx: Context) -> str:
            return json.dumps(
                self.read_resource(self.credential(ctx), f"sangam://skill/{skill_id}")
            )

        @self.server.resource("sangam://assistant/{request_key}", mime_type="application/json")
        def assistant_resource(request_key: str, ctx: Context) -> str:
            return json.dumps(
                self.read_resource(self.credential(ctx), f"sangam://assistant/{request_key}")
            )

        @self.server.resource("sangam://proposal/{proposal_id}", mime_type="application/json")
        def proposal_resource(proposal_id: str, ctx: Context) -> str:
            return json.dumps(
                self.read_resource(self.credential(ctx), f"sangam://proposal/{proposal_id}")
            )

    def read_resource(self, token: str, uri: str) -> dict[str, JsonValue]:
        """One authorization/read path for resource reads and change observation."""
        principal = self.principal(token)
        if uri.startswith("sangam://proposal/"):
            return self.inspection.invoke(
                principal, GetProposal(proposal_id=uri.removeprefix("sangam://proposal/"))
            )
        if uri.startswith("sangam://assistant/"):
            return self.services.assistant_requests.get(
                principal,
                GetAssistant(request_key=unquote(uri.removeprefix("sangam://assistant/"))),
            ).model_dump(mode="json")
        if uri.startswith("sangam://skill/"):
            query = GetSkill(skill_id=uri.removeprefix("sangam://skill/"))
            return self.skills.invoke(principal, query)
        for prefix in ("sangam://workspace/", "sangam://execution/", "sangam://document/"):
            if not uri.startswith(prefix):
                continue
            identifier = uri.removeprefix(prefix)
            ReadDocument(document_id=identifier)
            if prefix == "sangam://workspace/":
                return self.state.read(principal, identifier)
            if prefix == "sangam://execution/":
                self.state.cleanup()
                return self.state.status(principal, identifier)
            document = self.services.workspace_access.get_document(principal, identifier)
            return {
                "document_id": document.document_id,
                "current_revision_id": document.current_revision_id,
                "title": document.title,
                "path": document.path,
                "content_type": document.content_type,
                "metadata_version": document.metadata_version,
                "annotation_version": self.state.annotation_version(document.document_id)
                if document.content_type == "application/pdf"
                else 0,
                "pdf_extraction_status": document.pdf_extraction_status,
                "pdf_page_count": document.pdf_page_count,
                "pdf_extraction_error": document.pdf_extraction_error,
            }
        raise ValidationError("Unsupported Sangam resource reference")

    def search_documents(self, principal: Principal, query: SearchDocuments) -> SearchResults:
        documents = self.services.workspace_access.search_documents(
            principal,
            query=query.query,
            tag_id=None,
            category=None,
            actor_id=None,
            sort="relevance",
            content_type=None,
            limit=query.limit,
            offset=query.offset,
        )
        return SearchResults(
            items=[
                SearchHit(
                    document_id=document.document_id,
                    title=document.title,
                    path=document.path,
                    current_revision_id=document.current_revision_id,
                    content_type=document.content_type,
                )
                for document in documents
                if document.content_type in {"text/markdown", "application/pdf"}
            ],
            next_offset=query.offset + len(documents) if len(documents) == query.limit else None,
        )

    async def execute(self, token: str, code: str, execution_key: str) -> CallToolResult:
        principal = self.principal(token)
        ExecutionStatus(execution_key=execution_key)
        if len(code.encode()) > self.settings.mcp_max_source_bytes:
            raise ValidationError("Python source exceeds the configured byte limit.")
        self.state.cleanup()
        if not self.state.begin(
            principal,
            execution_key,
            hashlib.sha256(code.encode()).hexdigest(),
            # A cancelled wait can leave a canonical write finishing on its
            # thread. Keep those callbacks inside the same admission bound.
            capacity=not self.closing and self.active < 2 and len(self.pending) < 2,
        ):
            cached = self.state.status(principal, execution_key)
            return result(
                cached,
                failed=cached.get("status") in {"failed", "interrupted"} or "error" in cached,
            )
        self.active += 1
        callback_errors: dict[str, SangamError] = {}
        pending_jobs: dict[str, JsonValue] = {}
        callbacks = 0

        async def call(operation_id: str, **arguments: JsonValue) -> JsonValue:
            nonlocal callbacks
            callbacks += 1
            try:
                if callbacks > 32:
                    raise ValidationError(
                        "Callback limit reached. Stop and inspect execution status."
                    )
                # Never trust the principal captured at tool entry after a long wait.
                current = self.principal(token)
                schema = OPERATIONS[operation_id][0]
                parsed = schema.model_validate(arguments)
                value: JsonValue
                if isinstance(
                    parsed, (SubmitAssistant, GetAssistant, CancelAssistant, ReadConversation)
                ):
                    value = await self.services.assistant_requests.invoke(
                        current, parsed, execution_key
                    )
                    if isinstance(parsed, (SubmitAssistant, GetAssistant, CancelAssistant)):
                        if isinstance(value, dict) and value.get("status") == "running":
                            pending_jobs["assistant:" + parsed.request_key] = PendingAssistantJob(
                                request_key=parsed.request_key,
                                conversation_id=str(value["conversation_id"]),
                                resource_uri=str(value["resource_uri"]),
                            ).model_dump(mode="json")
                        else:
                            pending_jobs.pop("assistant:" + parsed.request_key, None)
                else:
                    value = await self.blocking(
                        partial(self.dispatch, current, execution_key, parsed)
                    )
                if isinstance(parsed, PdfStatus) and isinstance(value, dict) and "status" in value:
                    if value["status"] in {"pending", "processing"}:
                        pending_jobs[parsed.document_id] = PendingJob(
                            document_id=parsed.document_id,
                            resource_uri=f"sangam://document/{parsed.document_id}",
                        ).model_dump(mode="json")
                    else:
                        pending_jobs.pop(parsed.document_id, None)
                return value
            except SangamError as error:
                message = f"mcp_callback_{uuid4().hex}: {error.message}"
                callback_errors[message] = error
                raise RuntimeError(message) from error
            except SchemaError as error:
                callback_error = ValidationError(
                    "Operation arguments do not match the discovered schema."
                )
                message = f"mcp_callback_{uuid4().hex}: {callback_error.message}"
                callback_errors[message] = callback_error
                raise RuntimeError(message) from error

        external_lookup = {}
        for operation_id, (_, name, *_) in OPERATIONS.items():
            external_lookup[name] = partial(call, operation_id)
        failed = False
        try:
            async with (
                asyncio.timeout(10),
                self.pool.checkout(
                    limits={
                        "max_memory": 32_000_000,
                        "max_feed_duration_secs": 1.0,
                        "max_recursion_depth": 100,
                        "max_suspensions": 64,
                        "max_total_sleep_secs": 0,
                    }
                ) as session,
            ):
                output = await session.feed_run(
                    code,
                    external_lookup=external_lookup,
                    print_callback=lambda _stream, _text: None,
                )
            output = JSON_VALUE.validate_python(output)
            encoded = json.dumps(output, allow_nan=False)
            if len(encoded.encode()) > self.settings.mcp_max_result_bytes:
                raise ValidationError(
                    "Program output exceeds the response limit. "
                    "Select a smaller result or read a bounded passage."
                )
            value: dict[str, JsonValue] = {"output": output}
        except (MontyError, TimeoutError, SchemaError, ValueError, SangamError) as error:
            failed = True
            callback_error = (
                callback_errors.get(str(error.exception()))
                if isinstance(error, MontyError)
                else None
            )
            message = callback_error.message if callback_error else str(error)[:1000]
            value = {
                "execution_key": execution_key,
                "status": "failed",
                "error": {
                    "code": callback_error.code if callback_error else "execution_failed",
                    "message": message,
                },
                "writes": self.state.writes(principal, execution_key, authorize=False),
                "recovery": (
                    "Inspect original operation keys through executions_get in a fresh execute. "
                    "Do not replay this program."
                ),
            }
        except asyncio.CancelledError:
            value = {
                "execution_key": execution_key,
                "status": "interrupted",
                "output_available": False,
                "reason": "interrupted",
                "writes": self.state.writes(principal, execution_key, authorize=False),
                "message": "Execution interrupted. Inspect original write keys before continuing.",
            }
            if pending_jobs:
                value["pending_jobs"] = list(pending_jobs.values())
            await asyncio.shield(
                self.blocking(
                    partial(self.state.finish, principal, execution_key, value, failed=True)
                )
            )
            raise
        finally:
            self.active -= 1
        if pending_jobs:
            value["pending_jobs"] = list(pending_jobs.values())
        await self.blocking(
            partial(self.state.finish, principal, execution_key, value, failed=failed)
        )
        await self.blocking(
            partial(self.state.authorize_dependencies, self.principal(token), execution_key)
        )
        return result(value, failed=failed)

    def dispatch(
        self,
        principal: Principal,
        execution_key: str,
        operation: WorkspaceOperation,
    ) -> JsonValue:
        if isinstance(operation, (CreateProposal, ApplyProposal, DismissProposal)):
            return self.proposals.invoke(principal, operation, execution_key)
        if isinstance(operation, ExecutionStatus):
            response = self.state.status(principal, operation.execution_key)
            self.state.inherit_dependencies(principal, execution_key, operation.execution_key)
            return response
        if isinstance(operation, (ReadDocument, ReadHistory, ReadDiff, ListProposals, GetProposal)):
            return self.inspection.invoke(principal, operation, execution_key)
        if isinstance(operation, (ListSkills, GetSkill, ReadSkill)):
            return self.skills.invoke(principal, operation, execution_key)
        if isinstance(operation, (PdfStatus, PdfCreateAnnotation)):
            return self.pdf.invoke(principal, operation, execution_key)
        if isinstance(operation, SearchDocuments):
            search_response = self.search_documents(principal, operation)
            for item in search_response.items:
                self.state.dependency(principal, execution_key, item.document_id)
            return search_response.model_dump(mode="json")
        document = self.services.documents.get_document(operation.document_id)
        self.services.authorization.require(principal, Capability.UPDATE, document.path)
        self.state.require_markdown(document)
        self.state.dependency(principal, execution_key, document.document_id, Capability.UPDATE)
        self.state.before_write(
            principal, execution_key, operation.operation_key, document.document_id
        )
        try:
            saved = self.services.workspace_access.write_document(
                principal,
                document_id=document.document_id,
                action="update",
                body=DocumentUpdate(
                    expected_revision_id=operation.expected_revision_id, content=operation.content
                ),
                idempotency_key=operation.operation_key,
            )
        except (ValidationError, AuthorizationError, ConflictError, IdempotencyError):
            self.state.reject_write(principal, execution_key, operation.operation_key)
            raise
        self.state.confirm_write(principal, execution_key, operation.operation_key)
        return {
            "document_id": saved.document_id,
            "current_revision_id": saved.current_revision_id,
            "operation_key": operation.operation_key,
        }
