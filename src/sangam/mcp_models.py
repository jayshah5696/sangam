"""Bounded contracts shared by discovery, broker validation, and App actions."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from sangam.chat_capabilities import ProposalCitationInput
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
    revision_id: Identifier | None = None
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=16_000, ge=1, le=32_000)


class ReadHistory(Input):
    document_id: Identifier
    limit: int = Field(default=10, ge=1, le=25)
    cursor: Identifier | None = None


class ReadDiff(Input):
    document_id: Identifier
    from_revision_id: Identifier
    to_revision_id: Identifier
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=16_000, ge=1, le=32_000)


class ListProposals(Input):
    document_id: Identifier | None = None
    conversation_id: Identifier | None = None
    offset: int = Field(default=0, ge=0, le=100_000)
    limit: int = Field(default=10, ge=1, le=25)


class GetProposal(Input):
    proposal_id: Identifier
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=2000, ge=1, le=32_000)
    content_kind: Literal["proposed", "applied"] = "proposed"
    include_evidence: bool = False


InspectionOperation = ReadDocument | ReadHistory | ReadDiff | ListProposals | GetProposal


class CreateProposal(Input):
    document_id: Identifier
    expected_revision_id: Identifier
    content: str
    summary: str = Field(min_length=1, max_length=500)
    rationale: str | None = Field(default=None, max_length=1000)
    citations: list[ProposalCitationInput] = Field(default_factory=list, max_length=20)
    operation_key: Identifier


class ApplyProposal(Input):
    proposal_id: Identifier
    expected_revision_id: Identifier
    content: str
    operation_key: Identifier


class DismissProposal(Input):
    proposal_id: Identifier
    reason: str | None = Field(default=None, max_length=500)
    operation_key: Identifier


ProposalMutation = CreateProposal | ApplyProposal | DismissProposal


class SearchApp(SearchDocuments):
    type: Literal["search"]


class UpdateDocument(Input):
    document_id: Identifier
    expected_revision_id: Identifier
    content: str
    operation_key: Identifier


class CreateDocument(Input):
    title: str = Field(min_length=1, max_length=500)
    content: str
    path: str | None = Field(default=None, max_length=1000)
    operation_key: Identifier


class AssistantSource(Input):
    document_id: Identifier
    revision_id: Identifier


class ExecutionStatus(Input):
    execution_key: Identifier


class SubmitAssistant(Input):
    request_key: Identifier
    message: str = Field(min_length=1, max_length=16_000)
    conversation_id: Identifier | None = None
    document_id: Identifier | None = None
    revision_id: Identifier | None = None
    wait_seconds: float = Field(default=0, ge=0, le=2, allow_inf_nan=False)
    selection_text: str = Field(default="", max_length=20_000)
    pdf_page_number: int | None = Field(default=None, ge=1, le=1000)
    context_documents: list[AssistantSource] = Field(default_factory=list, max_length=50)


class GetAssistant(Input):
    request_key: Identifier
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=2000, ge=1, le=16_000)


class WaitAssistant(GetAssistant):
    wait_seconds: float = Field(default=2, ge=0, le=2, allow_inf_nan=False)


class CancelAssistant(Input):
    request_key: Identifier


class ReadConversation(Input):
    conversation_id: Identifier
    cursor: Identifier | None = None
    limit: int = Field(default=5, ge=1, le=10)
    item_id: Identifier | None = None
    offset: int = Field(default=0, ge=0)
    order: Literal["asc", "desc"] = "asc"


AssistantOperation = (
    SubmitAssistant | GetAssistant | WaitAssistant | CancelAssistant | ReadConversation
)


class ListSkills(Input):
    query: str = Field(default="", max_length=500)
    offset: int = Field(default=0, ge=0, le=100_000)
    limit: int = Field(default=5, ge=1, le=5)


class GetSkill(Input):
    skill_id: Identifier


class ReadSkill(Input):
    uri: str = Field(min_length=1, max_length=2048)
    offset: int = Field(default=0, ge=0)
    length: int = Field(default=16_000, ge=1, le=32_000)


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
SkillOperation = ListSkills | GetSkill | ReadSkill
WorkspaceOperation = (
    SearchDocuments
    | InspectionOperation
    | UpdateDocument
    | CreateDocument
    | ExecutionStatus
    | PdfOperation
    | SkillOperation
    | ProposalMutation
)
OperationInput = WorkspaceOperation | AssistantOperation


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
    revision_id: str
    content_type: str
    content: str
    next_offset: int | None


class WriteResult(BaseModel):
    document_id: str
    current_revision_id: str
    operation_key: str


class CreationResult(WriteResult):
    created_revision_id: str
    resource_uri: str


class WorkspaceTab(BaseModel):
    workspace_id: str
    document_id: str
    title: str
    path: str | None
    has_draft: bool
    current_revision_id: str


class WorkspaceLayout(BaseModel):
    layout_id: str
    version: int
    active_workspace_id: str
    tabs: list[WorkspaceTab]
    unavailable_count: int
    comparison_workspace_id: str | None = None


class WriteEvidence(BaseModel):
    operation_key: str
    document_id: str | None
    outcome: Literal["committed", "rejected", "unknown"]
    revision_id: str | None
    resource_id: str | None = None
    resource_type: str = "document"


class PendingJob(BaseModel):
    document_id: str
    resource_uri: str
    check_operation: Literal["pdf.status"] = "pdf.status"
    message: str = "Extraction is pending. Check the resource or pdf.status for completion."


class PendingAssistantJob(BaseModel):
    request_key: str
    conversation_id: str
    resource_uri: str
    check_operation: Literal["assistant.wait"] = "assistant.wait"
    poll_after_seconds: int = 1
    message: str = (
        "Assistant work is running. Check assistant.wait before reporting success. Do not resubmit."
    )


class ExecutionOutput(BaseModel):
    output: JsonValue
    pending_jobs: list[PendingJob | PendingAssistantJob] = Field(default_factory=list)


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
    pending_jobs: list[PendingJob | PendingAssistantJob] = Field(default_factory=list)


class ExecutionReceipt(BaseModel):
    execution_key: str
    status: Literal["running", "completed", "failed", "interrupted"]
    output_available: Literal[False] = False
    reason: Literal["in_progress", "interrupted", "result_expired"]
    writes: list[WriteEvidence]
    message: str
    pending_jobs: list[PendingJob | PendingAssistantJob] = Field(default_factory=list)


class WorkspaceAction(Input):
    workspace_id: Identifier


class DocumentCreateApp(CreateDocument, WorkspaceAction):
    type: Literal["document_create"]


class AssistantSubmitApp(SubmitAssistant, WorkspaceAction):
    type: Literal["assistant_submit"]


class AssistantGetApp(GetAssistant, WorkspaceAction):
    type: Literal["assistant_get"]


class AssistantCancelApp(CancelAssistant, WorkspaceAction):
    type: Literal["assistant_cancel"]


class AssistantMessagesApp(ReadConversation, WorkspaceAction):
    type: Literal["assistant_messages"]


AssistantAppAction = (
    AssistantSubmitApp | AssistantGetApp | AssistantCancelApp | AssistantMessagesApp
)


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


class ProposalListApp(WorkspaceAction):
    type: Literal["proposal_list"]
    limit: int = Field(default=10, ge=1, le=25)
    offset: int = Field(default=0, ge=0, le=100_000)


class ProposalReadApp(GetProposal, WorkspaceAction):
    type: Literal["proposal_read"]


class ProposalCreateApp(CreateProposal, WorkspaceAction):
    type: Literal["proposal_create"]


class ProposalApplyApp(ApplyProposal, WorkspaceAction):
    type: Literal["proposal_apply"]


class ProposalDismissApp(DismissProposal, WorkspaceAction):
    type: Literal["proposal_dismiss"]


class RevisionReadApp(ReadDocument, WorkspaceAction):
    type: Literal["revision_read"]


AppAction = Annotated[
    DocumentCreateApp
    | AssistantAppAction
    | RefreshWorkspace
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
    | PdfNoteApp
    | ProposalListApp
    | ProposalReadApp
    | ProposalCreateApp
    | ProposalApplyApp
    | ProposalDismissApp
    | RevisionReadApp,
    Field(discriminator="type"),
]
