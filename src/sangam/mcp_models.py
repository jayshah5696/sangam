"""Bounded contracts shared by discovery, broker validation, and App actions."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from sangam.schemas import AnnotationFields, AnnotationType

Identifier = Annotated[str, Field(min_length=1, max_length=200)]


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SearchDocuments(Input):
    query: str = Field(max_length=500)
    limit: int = Field(default=10, ge=1, le=25)
    offset: int = Field(default=0, ge=0, le=100_000)


class ReadDocument(Input):
    document_id: Identifier
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=16_000, ge=1, le=32_000)


class SearchApp(SearchDocuments):
    type: Literal["search"]


class UpdateDocument(Input):
    document_id: Identifier
    expected_revision_id: Identifier
    content: str
    operation_key: Identifier


class ExecutionStatus(Input):
    execution_key: Identifier


class PdfStatus(Input):
    document_id: Identifier


class PdfReadPage(PdfStatus):
    page_number: int = Field(ge=1, le=1000)
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=16_000, ge=1, le=32_000)


class PdfSearch(PdfStatus):
    query: str = Field(min_length=1, max_length=500)
    offset: int = Field(default=0, ge=0, le=100_000)
    limit: int = Field(default=10, ge=1, le=25)


class PdfAnnotations(PdfStatus):
    page_number: int = Field(ge=1, le=1000)
    offset: int = Field(default=0, ge=0, le=100_000)
    limit: int = Field(default=10, ge=1, le=25)


class PdfCreateAnnotation(Input, AnnotationFields):
    document_id: Identifier
    page_number: int = Field(ge=1, le=1000)
    annotation_type: AnnotationType = "page_note"
    operation_key: Identifier


class PdfBytes(PdfStatus):
    type: Literal["pdf_bytes"]
    expected_revision_id: Identifier
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=64_000, ge=1, le=64_000)


class PdfPageApp(PdfReadPage):
    type: Literal["pdf_page"]


class PdfSearchApp(PdfSearch):
    type: Literal["pdf_search"]


class PdfAnnotationsApp(PdfAnnotations):
    type: Literal["pdf_annotations"]


class PdfNoteApp(PdfCreateAnnotation):
    type: Literal["pdf_note"]


PdfOperation = PdfStatus | PdfReadPage | PdfSearch | PdfAnnotations | PdfCreateAnnotation
OperationInput = SearchDocuments | ReadDocument | UpdateDocument | ExecutionStatus | PdfOperation


class SearchHit(BaseModel):
    document_id: str
    title: str
    path: str | None
    current_revision_id: str
    content_type: str


class SearchResults(BaseModel):
    items: list[SearchHit]
    next_offset: int | None


class DocumentPassage(BaseModel):
    document_id: str
    title: str
    current_revision_id: str
    content: str
    next_offset: int | None


class WriteResult(BaseModel):
    document_id: str
    current_revision_id: str
    operation_key: str


class WorkspaceTab(BaseModel):
    workspace_id: str
    document_id: str
    title: str
    path: str | None
    has_draft: bool


class WorkspaceLayout(BaseModel):
    layout_id: str
    version: int
    active_workspace_id: str
    tabs: list[WorkspaceTab]
    unavailable_count: int
    comparison_workspace_id: str | None = None


class WriteEvidence(BaseModel):
    operation_key: str
    document_id: str
    outcome: Literal["committed", "rejected", "unknown"]
    revision_id: str | None
    resource_id: str | None = None
    resource_type: str = "document"


class PendingJob(BaseModel):
    document_id: str
    resource_uri: str
    check_operation: Literal["pdf.status"] = "pdf.status"
    message: str = "Extraction is pending. Check the resource or pdf.status for completion."


class ExecutionOutput(BaseModel):
    output: JsonValue
    pending_jobs: list[PendingJob] = Field(default_factory=list)


class ExecutionError(BaseModel):
    code: str
    message: str


class ExecutionFailure(BaseModel):
    execution_key: str
    status: Literal["failed", "interrupted"]
    error: ExecutionError | None = None
    writes: list[WriteEvidence] = Field(default_factory=list)
    message: str | None = None
    recovery: str | None = None
    pending_jobs: list[PendingJob] = Field(default_factory=list)


class ExecutionReceipt(BaseModel):
    execution_key: str
    status: Literal["running", "completed", "failed", "interrupted"]
    output_available: Literal[False] = False
    reason: Literal["in_progress", "interrupted", "result_expired"]
    writes: list[WriteEvidence]
    message: str
    pending_jobs: list[PendingJob] = Field(default_factory=list)


class WorkspaceAction(Input):
    workspace_id: Identifier


class RefreshWorkspace(WorkspaceAction):
    type: Literal["refresh"]


class LayoutAction(WorkspaceAction):
    expected_layout_version: int = Field(ge=1)


class TextLocation(Input):
    kind: Literal["text"] = "text"
    anchor: int = Field(default=0, ge=0, le=10_000_000)
    head: int = Field(default=0, ge=0, le=10_000_000)
    scroll_top: float = Field(default=0, ge=0, le=1_000_000_000, allow_inf_nan=False)


class PdfLocation(Input):
    kind: Literal["pdf"] = "pdf"
    page_number: int = Field(default=1, ge=1, le=1000)
    zoom: float = Field(default=1, ge=0.25, le=4, allow_inf_nan=False)
    scroll_top: float = Field(default=0, ge=0, le=1_000_000_000, allow_inf_nan=False)


ViewLocation = Annotated[TextLocation | PdfLocation, Field(discriminator="kind")]


class UpdateView(WorkspaceAction):
    type: Literal["view"]
    expected_view_version: int = Field(ge=1)
    location: Annotated[TextLocation | PdfLocation, Field(discriminator="kind")]


class CompareDocument(LayoutAction):
    type: Literal["compare"]
    target_workspace_id: Identifier | None


class OpenDocument(LayoutAction):
    type: Literal["open"]
    document_id: Identifier


class TargetWorkspace(LayoutAction):
    target_workspace_id: Identifier


class ActivateDocument(TargetWorkspace):
    type: Literal["activate"]


class CloseDocument(TargetWorkspace):
    type: Literal["close"]


class CheckpointDraft(WorkspaceAction):
    type: Literal["checkpoint"]
    expected_version: int = Field(ge=1)
    content: str


class DiscardDraft(WorkspaceAction):
    type: Literal["discard"]
    expected_version: int = Field(ge=1)


class SaveDraft(WorkspaceAction):
    type: Literal["save"]
    expected_version: int = Field(ge=1)
    operation_key: Identifier


AppAction = Annotated[
    RefreshWorkspace
    | CheckpointDraft
    | DiscardDraft
    | SaveDraft
    | SearchApp
    | OpenDocument
    | ActivateDocument
    | CloseDocument
    | CompareDocument
    | UpdateView
    | PdfBytes
    | PdfPageApp
    | PdfSearchApp
    | PdfAnnotationsApp
    | PdfNoteApp,
    Field(discriminator="type"),
]
