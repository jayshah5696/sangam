from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sangam.authorization import AuthorizationPolicy
from sangam.capabilities import Capability
from sangam.errors import ValidationError
from sangam.schemas import (
    Document,
    OrganizationOperation,
    OrganizationSnapshotItem,
    ProjectRole,
)
from sangam.security import Principal


class StrictCapabilityModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EffectClass(StrEnum):
    READ = "read"
    PROPOSE = "propose"
    WRITE = "write"
    EXTERNAL = "external"


class ApprovalPolicy(StrEnum):
    NONE = "none"
    HUMAN_REVIEW = "human_review"
    EXACT_EFFECT = "exact_effect"


ChatEntryPoint = Literal["workspace", "document"]


class EditorSelectionInput(StrictCapabilityModel):
    document_id: str | None = Field(default=None, max_length=200)


class EditorSelectionResult(StrictCapabilityModel):
    document_id: str | None = Field(default=None, max_length=200)
    revision_id: str | None = Field(default=None, max_length=200)
    selected_text: str = Field(max_length=20_000)
    selection_digest: str | None = Field(default=None, max_length=64)
    pdf_page_number: int | None = Field(default=None, ge=1)
    annotation_id: str | None = Field(default=None, max_length=200)


class WorkspaceSearchInput(StrictCapabilityModel):
    query: str = Field(min_length=1, max_length=500)
    limit: int = Field(default=5, ge=1, le=25)
    offset: int = Field(default=0, ge=0, le=10_000)
    # The same filters the Search page offers.
    tag_id: str | None = Field(default=None, max_length=200)
    category: str | None = Field(default=None, max_length=120)
    content_type: Literal["text/markdown", "text/html", "application/pdf"] | None = None
    sort: Literal["relevance", "updated", "title", "path"] = "relevance"


class CitationSource(StrictCapabilityModel):
    document_id: str = Field(max_length=200)
    title: str = Field(max_length=500)
    path: str | None = Field(default=None, max_length=1000)
    revision_id: str = Field(max_length=200)
    page_number: int | None = Field(default=None, ge=1)
    annotation_id: str | None = Field(default=None, max_length=200)
    citation: str = Field(max_length=2000)
    snippet: str | None = Field(default=None, max_length=4000)
    # What the UI shows beside a document; present when the tool loaded the document itself.
    category: str | None = Field(default=None, max_length=120)
    tags: list[str] | None = Field(default=None, max_length=50)
    trust_level: str | None = Field(default=None, max_length=40)
    deleted: bool | None = None
    pdf_extraction_status: str | None = Field(default=None, max_length=40)
    pdf_page_count: int | None = Field(default=None, ge=0)


class WorkspaceSearchResult(StrictCapabilityModel):
    results: list[CitationSource] = Field(max_length=25)


class InspectWorkspaceOrganizationInput(StrictCapabilityModel):
    item_type: Literal["document", "folder", "tag"] | None = None
    path_prefix: str | None = Field(default=None, max_length=500)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=100)


class InspectWorkspaceOrganizationResult(StrictCapabilityModel):
    items: list[OrganizationSnapshotItem] = Field(max_length=100)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1, le=100)
    next_offset: int | None = Field(default=None, ge=0)


class ApplyWorkspaceOrganizationPlanInput(StrictCapabilityModel):
    operations: list[OrganizationOperation] = Field(min_length=1, max_length=100)

    @model_validator(mode="after")
    def validate_plan(self) -> ApplyWorkspaceOrganizationPlanInput:
        from sangam.schemas import ApplyOrganizationPlan

        ApplyOrganizationPlan.model_validate(self.model_dump(mode="json"))
        return self


class ReadDocumentInput(StrictCapabilityModel):
    document_id: str = Field(min_length=1, max_length=200)
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=20_000, ge=1, le=40_000)


class PublicationStateResult(StrictCapabilityModel):
    publication_id: str = Field(max_length=200)
    version: int = Field(ge=0)
    slug: str = Field(max_length=200)
    access_policy: Literal["private", "unlisted", "public"]
    active: bool
    published_revision_id: str = Field(max_length=200)
    url: str = Field(max_length=2000)


class ReadDocumentResult(StrictCapabilityModel):
    source: CitationSource
    content: str = Field(max_length=40_000)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1, le=40_000)
    total_chars: int = Field(ge=0)
    truncated: bool
    # Documents that link here, as the editor's Links panel shows them.
    backlinks: list[CitationSource] = Field(default_factory=list, max_length=20)
    # Present only for someone who may publish this document.
    publication: PublicationStateResult | None = None


class ReadRevisionHistoryInput(StrictCapabilityModel):
    """List a document's revisions, or diff two of them when `from_revision_id` is given."""

    document_id: str = Field(min_length=1, max_length=200)
    from_revision_id: str | None = Field(default=None, max_length=200)
    to_revision_id: str | None = Field(default=None, max_length=200)
    limit: int = Field(default=20, ge=1, le=50)
    cursor: str | None = Field(default=None, max_length=1000)


class RevisionEntryResult(StrictCapabilityModel):
    revision_id: str = Field(max_length=200)
    parent_revision_id: str | None = Field(default=None, max_length=200)
    actor_id: str = Field(max_length=200)
    operation: str = Field(max_length=80)
    summary: str | None = Field(default=None, max_length=500)
    created_at: str = Field(max_length=64)


class RevisionDiffResult(StrictCapabilityModel):
    from_revision_id: str = Field(max_length=200)
    to_revision_id: str = Field(max_length=200)
    unified_diff: str = Field(max_length=30_000)
    additions: int = Field(ge=0)
    deletions: int = Field(ge=0)
    truncated: bool = False


class ReadRevisionHistoryResult(StrictCapabilityModel):
    source: CitationSource
    revisions: list[RevisionEntryResult] = Field(default_factory=list, max_length=50)
    next_cursor: str | None = Field(default=None, max_length=1000)
    diff: RevisionDiffResult | None = None


class InspectProjectsInput(StrictCapabilityModel):
    """List projects, or open one with its member documents."""

    project_id: str | None = Field(default=None, max_length=200)


class ProjectSummaryResult(StrictCapabilityModel):
    project_id: str = Field(max_length=200)
    name: str = Field(max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    brief_document_id: str | None = Field(default=None, max_length=200)
    version: int = Field(ge=1)
    document_count: int = Field(ge=0)


class ProjectMemberResult(StrictCapabilityModel):
    document_id: str = Field(max_length=200)
    title: str = Field(max_length=500)
    path: str | None = Field(default=None, max_length=1000)
    role: ProjectRole
    pinned_page: int | None = Field(default=None, ge=1)
    notes: str | None = Field(default=None, max_length=2000)
    source_updated: bool = False


class ProjectThreadResult(StrictCapabilityModel):
    thread_id: str = Field(max_length=200)
    title: str | None = Field(default=None, max_length=500)


class ProjectAnnotationResult(StrictCapabilityModel):
    annotation_id: str = Field(max_length=200)
    document_id: str = Field(max_length=200)
    page_number: int = Field(ge=1)
    annotation_type: str = Field(max_length=80)
    note: str | None = Field(default=None, max_length=2000)


class ProjectDetailResult(ProjectSummaryResult):
    active_document_id: str | None = Field(default=None, max_length=200)
    active_thread_id: str | None = Field(default=None, max_length=200)
    documents: list[ProjectMemberResult] = Field(default_factory=list, max_length=200)
    threads: list[ProjectThreadResult] = Field(default_factory=list, max_length=200)
    annotations: list[ProjectAnnotationResult] = Field(default_factory=list, max_length=200)


class InspectProjectsResult(StrictCapabilityModel):
    projects: list[ProjectSummaryResult] = Field(default_factory=list, max_length=200)
    project: ProjectDetailResult | None = None


class CreateProjectChange(StrictCapabilityModel):
    kind: Literal["create_project"]
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    create_brief: bool = True


class AddProjectDocumentChange(StrictCapabilityModel):
    kind: Literal["add_document"]
    project_id: str = Field(min_length=1, max_length=200)
    document_id: str = Field(min_length=1, max_length=200)
    role: ProjectRole = "source"
    pinned_page: int | None = Field(default=None, ge=1)
    notes: str | None = Field(default=None, max_length=2000)


class RemoveProjectDocumentChange(StrictCapabilityModel):
    kind: Literal["remove_document"]
    project_id: str = Field(min_length=1, max_length=200)
    document_id: str = Field(min_length=1, max_length=200)


class UpdateProjectDetailsChange(StrictCapabilityModel):
    """Change what a project says about itself. Omitted fields stay as they are."""

    kind: Literal["update_details"]
    project_id: str = Field(min_length=1, max_length=200)
    expected_version: int | None = Field(default=None, ge=1)
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    brief_document_id: str | None = Field(default=None, max_length=200)
    active_document_id: str | None = Field(default=None, max_length=200)
    active_thread_id: str | None = Field(default=None, max_length=200)


class UpdateProjectMemberChange(StrictCapabilityModel):
    """Change how a member document is used in a project."""

    kind: Literal["update_member"]
    project_id: str = Field(min_length=1, max_length=200)
    document_id: str = Field(min_length=1, max_length=200)
    role: ProjectRole | None = None
    pinned_page: int | None = Field(default=None, ge=1)
    notes: str | None = Field(default=None, max_length=2000)


class ProjectThreadChange(StrictCapabilityModel):
    kind: Literal["add_thread", "remove_thread"]
    project_id: str = Field(min_length=1, max_length=200)
    thread_id: str = Field(min_length=1, max_length=200)


class ProjectAnnotationChange(StrictCapabilityModel):
    kind: Literal["add_annotation", "remove_annotation"]
    project_id: str = Field(min_length=1, max_length=200)
    annotation_id: str = Field(min_length=1, max_length=200)


# A model cannot supply highlight geometry, so chat annotates with the types that need none.
ChatAnnotationType = Literal["comment", "page_note", "bookmark", "citation_marker"]


class CreateAnnotationChange(StrictCapabilityModel):
    kind: Literal["create"]
    document_id: str = Field(min_length=1, max_length=200)
    page_number: int = Field(ge=1, le=100_000)
    annotation_type: ChatAnnotationType
    note: str | None = Field(default=None, max_length=20_000)
    tags: list[str] = Field(default_factory=list, max_length=50)
    color: str = Field(default="#f0c75e", pattern=r"^#[0-9a-fA-F]{6}$")


class UpdateAnnotationChange(StrictCapabilityModel):
    """Change the note, tags, or color. Omitted fields stay as they are."""

    kind: Literal["update"]
    annotation_id: str = Field(min_length=1, max_length=200)
    expected_version: int = Field(ge=1)
    note: str | None = Field(default=None, max_length=20_000)
    tags: list[str] | None = Field(default=None, max_length=50)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class DeleteAnnotationChange(StrictCapabilityModel):
    kind: Literal["delete"]
    annotation_id: str = Field(min_length=1, max_length=200)
    expected_version: int = Field(ge=1)


AnnotationChange = Annotated[
    CreateAnnotationChange | UpdateAnnotationChange | DeleteAnnotationChange,
    Field(discriminator="kind"),
]


class AnnotatePdfInput(StrictCapabilityModel):
    """One exact PDF annotation change: add a note or bookmark, or edit or delete one."""

    change: AnnotationChange


class UnpublishChange(StrictCapabilityModel):
    kind: Literal["unpublish"]
    publication_id: str = Field(min_length=1, max_length=200)
    expected_version: int = Field(ge=0)


class UpdatePublicationChange(StrictCapabilityModel):
    """Change the slug, access policy, or published revision. Omitted fields stay as they are."""

    kind: Literal["update"]
    publication_id: str = Field(min_length=1, max_length=200)
    expected_version: int = Field(ge=0)
    slug: str | None = Field(default=None, min_length=1, max_length=200)
    access_policy: Literal["private", "unlisted", "public"] | None = None
    revision_id: str | None = Field(default=None, min_length=1, max_length=200)


PublicationChange = Annotated[
    UnpublishChange | UpdatePublicationChange, Field(discriminator="kind")
]


class UpdatePublicationInput(StrictCapabilityModel):
    """One exact change to an existing publication: withdraw it or change how it is shared."""

    change: PublicationChange


ProjectChange = Annotated[
    CreateProjectChange
    | AddProjectDocumentChange
    | RemoveProjectDocumentChange
    | UpdateProjectDetailsChange
    | UpdateProjectMemberChange
    | ProjectThreadChange
    | ProjectAnnotationChange,
    Field(discriminator="kind"),
]


class UpdateProjectInput(StrictCapabilityModel):
    """One exact project change: create or edit a project, its members, threads, or annotations."""

    change: ProjectChange


class ReadPdfPageInput(StrictCapabilityModel):
    document_id: str = Field(min_length=1, max_length=200)
    page_number: int = Field(ge=1, le=100_000)


class PdfAnnotationResult(StrictCapabilityModel):
    annotation_id: str = Field(max_length=200)
    # Required to edit or delete the annotation.
    version: int = Field(ge=1)
    color: str = Field(max_length=9)
    type: str = Field(max_length=80)
    selected_text: str | None = Field(default=None, max_length=20_000)
    note: str | None = Field(default=None, max_length=20_000)
    tags: list[str] = Field(max_length=50)


class ReadPdfPageResult(StrictCapabilityModel):
    source: CitationSource
    text: str = Field(max_length=40_000)
    annotations: list[PdfAnnotationResult] = Field(max_length=20)


ProposeUpdateMode = Literal["full", "replace", "insert_before", "insert_after", "append"]


class ProposalCitationInput(StrictCapabilityModel):
    document_id: str = Field(min_length=1, max_length=200)
    revision_id: str | None = Field(default=None, max_length=200)
    page_number: int | None = Field(default=None, ge=1)
    annotation_id: str | None = Field(default=None, max_length=200)
    snippet: str = Field(default="", max_length=2000)
    location: str | None = Field(default=None, max_length=200)
    quote_start: int | None = Field(
        default=None,
        ge=0,
        description="Exact UTF-16 offset for a repeated passage. Otherwise quote a unique passage.",
    )


class ProposeUpdateInput(StrictCapabilityModel):
    document_id: str = Field(min_length=1, max_length=200)
    expected_revision_id: str = Field(min_length=1, max_length=200)
    mode: ProposeUpdateMode = "full"
    content: str = Field(default="", max_length=2_000_000)
    anchor: str | None = Field(default=None, max_length=100_000)
    replace_all: bool = False
    summary: str = Field(min_length=1, max_length=500)
    rationale: str | None = Field(default=None, max_length=1000)
    judgment_needed: str | None = Field(default=None, max_length=1000)
    model_opinion: str | None = Field(default=None, max_length=2000)
    citations: list[ProposalCitationInput] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def _check_mode_shape(self) -> ProposeUpdateInput:
        if self.mode == "full":
            if not self.content:
                raise ValueError("mode='full' requires non-empty content")
            if self.anchor is not None:
                raise ValueError("mode='full' must not include an anchor")
        elif self.mode == "append":
            if not self.content:
                raise ValueError("mode='append' requires non-empty content")
            if self.anchor is not None:
                raise ValueError("mode='append' must not include an anchor")
            if self.replace_all:
                raise ValueError("replace_all is only allowed with mode='replace'")
        else:
            if not self.anchor or not self.anchor.strip():
                raise ValueError(f"mode='{self.mode}' requires a non-empty anchor")
            if self.replace_all and self.mode != "replace":
                raise ValueError("replace_all is only allowed with mode='replace'")
        return self


class ProposeUpdateResult(StrictCapabilityModel):
    proposal_id: str = Field(max_length=200)
    status: Literal["pending"]
    message: str = Field(max_length=500)


class CreateDocumentInput(StrictCapabilityModel):
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(max_length=2_000_000)
    content_type: Literal["text/markdown", "text/html"]
    path: str | None = Field(default=None, max_length=500)


class PublishDocumentInput(StrictCapabilityModel):
    document_id: str = Field(min_length=1, max_length=200)
    revision_id: str = Field(min_length=1, max_length=200)
    slug: str = Field(min_length=1, max_length=200)
    access_policy: Literal["private", "unlisted", "public"]


class EffectRequestResult(StrictCapabilityModel):
    effect_id: str = Field(max_length=200)
    status: Literal["pending_approval"]
    argument_digest: str = Field(min_length=64, max_length=64)
    preview: dict[str, object]


@dataclass(frozen=True)
class ChatCapability:
    capability_id: str
    version: int
    title: str
    description: str
    input_schema: type[StrictCapabilityModel]
    result_schema: type[StrictCapabilityModel]
    effect_class: EffectClass
    approval_policy: ApprovalPolicy
    required_authority: tuple[Capability, ...]
    allowed_entry_points: tuple[ChatEntryPoint, ...]
    allowed_content_types: tuple[str, ...]
    max_result_bytes: int
    timeout_seconds: float
    required_any_authority: tuple[Capability, ...] = ()
    # Project operations are administrator-only in the UI, so they are here too.
    requires_administrator: bool = False
    # What the model needs to know to use this tool. The run's instructions are
    # the base text plus the guidance of exactly the tools the run was given.
    guidance: str = ""

    @property
    def name(self) -> str:
        return self.capability_id

    @property
    def effect(self) -> str:
        return self.effect_class.value

    @property
    def approval(self) -> str:
        return self.approval_policy.value

    def manifest_item(self) -> dict[str, object]:
        return {
            "id": self.capability_id,
            "version": self.version,
            "effect_class": self.effect_class.value,
            "approval_policy": self.approval_policy.value,
        }


CAPABILITIES: tuple[ChatCapability, ...] = (
    ChatCapability(
        "get_editor_selection",
        1,
        "Read editor selection",
        "Read the selection snapshot pinned to this turn.",
        EditorSelectionInput,
        EditorSelectionResult,
        EffectClass.READ,
        ApprovalPolicy.NONE,
        (Capability.READ,),
        ("document",),
        ("text/markdown", "text/html", "application/pdf"),
        24_000,
        5.0,
        guidance=(
            "When the user refers to selected text, call get_editor_selection instead of guessing."
        ),
    ),
    ChatCapability(
        "search_workspace",
        1,
        "Search workspace",
        "Search documents visible to the current principal.",
        WorkspaceSearchInput,
        WorkspaceSearchResult,
        EffectClass.READ,
        ApprovalPolicy.NONE,
        (Capability.READ, Capability.SEARCH),
        ("workspace", "document"),
        (),
        40_000,
        10.0,
        guidance=(
            "search_workspace takes the Search page's filters (tag_id, category, "
            "content_type, sort). A PDF hit carries the page_number to cite."
        ),
    ),
    ChatCapability(
        "inspect_workspace_organization",
        1,
        "Inspect workspace organization",
        "List bounded authorized document, folder, and tag metadata with stable IDs and versions.",
        InspectWorkspaceOrganizationInput,
        InspectWorkspaceOrganizationResult,
        EffectClass.READ,
        ApprovalPolicy.NONE,
        (Capability.READ,),
        ("workspace", "document"),
        (),
        60_000,
        10.0,
        guidance=(
            "For organization work, inspect_workspace_organization must run before "
            "planning. Never infer tags from document content."
        ),
    ),
    ChatCapability(
        "read_document",
        1,
        "Read document",
        "Read one authorized Markdown or HTML revision.",
        ReadDocumentInput,
        ReadDocumentResult,
        EffectClass.READ,
        ApprovalPolicy.NONE,
        (Capability.READ,),
        ("workspace", "document"),
        ("text/markdown", "text/html"),
        50_000,
        10.0,
        guidance=(
            "Long documents are paginated: page through them with read_document's offset "
            "parameter instead of relying on truncation. The result also lists the "
            "document's tags, category, trust level, and the documents that link to it."
        ),
    ),
    ChatCapability(
        "read_pdf_page",
        1,
        "Read PDF page",
        "Read one authorized PDF page and its annotations.",
        ReadPdfPageInput,
        ReadPdfPageResult,
        EffectClass.READ,
        ApprovalPolicy.NONE,
        (Capability.READ,),
        ("workspace", "document"),
        ("application/pdf",),
        60_000,
        10.0,
        guidance=("Use read_pdf_page for PDF text and live annotations."),
    ),
    ChatCapability(
        "propose_update",
        1,
        "Prepare edit proposal",
        "Create a revision-pinned proposal without applying it.",
        ProposeUpdateInput,
        ProposeUpdateResult,
        EffectClass.PROPOSE,
        ApprovalPolicy.HUMAN_REVIEW,
        (Capability.UPDATE,),
        ("workspace", "document"),
        ("text/markdown", "text/html"),
        10_000,
        10.0,
        guidance=(
            "For editorial proposals, explain what changed in rationale and what the "
            "reviewer must decide in judgment_needed. Include up to 20 supporting citations "
            "with an exact document passage, its revision, and its PDF page and annotation "
            "when relevant. Never invent quoted text or source locations. Reading a "
            "document alone does not establish support. Put external claims and your "
            "interpretation in model_opinion, separately from verified supporting passages. "
            "Use propose_update for every edit to an existing document and explain that the "
            "human must review its diff. Prefer patch modes: pass a minimal unique anchor "
            'copied exactly from read_document output with mode="replace", "insert_before", '
            'or "insert_after", or use mode="append"; use mode="full" only for small '
            "documents."
        ),
    ),
    ChatCapability(
        "create_document",
        3,
        "Create document",
        "Request one exact Markdown or HTML document creation, optionally at a workspace path.",
        CreateDocumentInput,
        EffectRequestResult,
        EffectClass.WRITE,
        ApprovalPolicy.EXACT_EFFECT,
        (Capability.CREATE,),
        ("workspace", "document"),
        (),
        10_000,
        10.0,
        guidance=(
            "For an explicit creation request, pass the requested workspace-relative path "
            "to create_document. Do not encode a path in the title. If SANGAM_CONTEXT limits "
            "your create access to path prefixes, the path must be inside one of them; a "
            "document without a path needs workspace-wide create access."
        ),
    ),
    ChatCapability(
        "apply_workspace_organization_plan",
        1,
        "Apply workspace organization plan",
        "Request one exact bounded plan for folder, path, category, and existing-tag changes.",
        ApplyWorkspaceOrganizationPlanInput,
        EffectRequestResult,
        EffectClass.WRITE,
        ApprovalPolicy.EXACT_EFFECT,
        (Capability.READ,),
        ("workspace", "document"),
        (),
        20_000,
        20.0,
        required_any_authority=(
            Capability.CREATE,
            Capability.MOVE,
            Capability.TAG,
            Capability.RESTORE,
            Capability.DELETE,
        ),
        guidance=(
            "Use apply_workspace_organization_plan only for the exact create_folder, "
            "create_tag, move_document, trash_document, restore_document, duplicate_document, "
            "move_folder, or category and existing-tag changes the user requested, and add no "
            "operation they did not ask for. Trash and restore are reversible. "
            "A plan cannot apply a tag it creates: create the tag in one plan, inspect the "
            "workspace for its id, then apply it in a second plan. "
            "restore_document needs the document's current revision and the revision to "
            "restore, both from read_revision_history; it also brings a trashed document back."
        ),
    ),
    ChatCapability(
        "publish_document",
        1,
        "Publish document",
        "Request publication of one exact document revision and access policy.",
        PublishDocumentInput,
        EffectRequestResult,
        EffectClass.EXTERNAL,
        ApprovalPolicy.EXACT_EFFECT,
        (Capability.READ, Capability.PUBLISH),
        ("workspace", "document"),
        ("text/markdown", "text/html"),
        10_000,
        10.0,
        guidance=(
            "Call publish_document only when the user explicitly asks. Publication makes "
            "the exact revision readable at the chosen access policy."
        ),
    ),
    ChatCapability(
        "read_revision_history",
        1,
        "Read revision history",
        "List a document's revisions, or diff two of them.",
        ReadRevisionHistoryInput,
        ReadRevisionHistoryResult,
        EffectClass.READ,
        ApprovalPolicy.NONE,
        (Capability.READ,),
        ("workspace", "document"),
        (),
        60_000,
        10.0,
        guidance=(
            "Use read_revision_history to see who changed a document and when. Pass "
            "from_revision_id (and optionally to_revision_id) for a diff. Read it before "
            "restoring a revision."
        ),
    ),
    ChatCapability(
        "inspect_projects",
        1,
        "Inspect projects",
        "List projects, or open one with its member documents.",
        InspectProjectsInput,
        InspectProjectsResult,
        EffectClass.READ,
        ApprovalPolicy.NONE,
        (Capability.READ,),
        ("workspace", "document"),
        (),
        40_000,
        10.0,
        requires_administrator=True,
        guidance=(
            "Use inspect_projects to find projects and their member documents before changing one."
        ),
    ),
    ChatCapability(
        "update_project",
        1,
        "Update project",
        "Request one exact project change: create or edit a project, its documents, "
        "conversations, or PDF annotations.",
        UpdateProjectInput,
        EffectRequestResult,
        EffectClass.WRITE,
        ApprovalPolicy.EXACT_EFFECT,
        (Capability.READ,),
        ("workspace", "document"),
        (),
        10_000,
        10.0,
        requires_administrator=True,
        guidance=(
            "Use update_project for one project change at a time: create a project, edit "
            "its name, description, brief, or active document, add or remove a member "
            "document, change a member's role, pinned page, or notes, or attach or detach "
            "a conversation or a PDF annotation. Project membership only references "
            "documents; it never changes them. When a project is open, its id and this "
            "conversation's thread id are in SANGAM_CONTEXT."
        ),
    ),
    ChatCapability(
        "update_publication",
        1,
        "Update publication",
        "Request one exact change to an existing publication: withdraw it or change how "
        "it is shared.",
        UpdatePublicationInput,
        EffectRequestResult,
        EffectClass.EXTERNAL,
        ApprovalPolicy.EXACT_EFFECT,
        (Capability.READ, Capability.PUBLISH),
        ("workspace", "document"),
        ("text/markdown", "text/html"),
        10_000,
        10.0,
        guidance=(
            "Call update_publication only when the user explicitly asks to withdraw a "
            "publication or change its slug, access policy, or published revision. Read the "
            "document first: its publication (id and version) is in the result. The version "
            "must be the one you read."
        ),
    ),
    ChatCapability(
        "annotate_pdf",
        1,
        "Annotate PDF",
        "Request one exact PDF annotation change: add a note, comment, bookmark, or citation "
        "marker to a page, or edit or delete an annotation.",
        AnnotatePdfInput,
        EffectRequestResult,
        EffectClass.WRITE,
        ApprovalPolicy.EXACT_EFFECT,
        (Capability.READ, Capability.UPDATE),
        ("workspace", "document"),
        ("application/pdf",),
        10_000,
        10.0,
        guidance=(
            "Call annotate_pdf only when the user explicitly asks to add, change, or remove "
            "a note, comment, bookmark, or citation marker on a PDF page. Text and area "
            "highlights need page coordinates and cannot be made from chat. To edit or "
            "delete, use the annotation id and version from read_pdf_page."
        ),
    ),
)


class ChatCapabilityRegistry:
    def __init__(self, capabilities: tuple[ChatCapability, ...] = CAPABILITIES) -> None:
        self.capabilities = capabilities
        self.by_id = {capability.capability_id: capability for capability in capabilities}
        if len(self.by_id) != len(capabilities):
            raise ValueError("Chat capability IDs must be unique")
        encoded = json.dumps(
            [capability.manifest_item() for capability in capabilities],
            sort_keys=True,
            separators=(",", ":"),
        )
        self.manifest_version = hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:16]

    def get(self, capability_id: str) -> ChatCapability:
        try:
            return self.by_id[capability_id]
        except KeyError as error:
            raise ValidationError(f"Unknown chat capability: {capability_id}") from error

    def resolve(
        self,
        *,
        principal: Principal,
        policy: AuthorizationPolicy,
        entry_point: ChatEntryPoint,
        document: Document | None,
        model_supports_tools: bool | None,
    ) -> tuple[ChatCapability, ...]:
        if model_supports_tools is False:
            return ()
        resolved: list[ChatCapability] = []
        for capability in self.capabilities:
            if entry_point not in capability.allowed_entry_points:
                continue
            if capability.requires_administrator and not principal.administrator:
                continue
            if (
                document is not None
                and capability.allowed_content_types
                and document.content_type not in capability.allowed_content_types
            ):
                continue
            path = document.path if document is not None else None
            if not self._allows(
                principal,
                policy,
                capability.required_authority,
                path,
            ):
                continue
            if capability.required_any_authority and not any(
                self._allows(
                    principal,
                    policy,
                    (authority,),
                    path,
                )
                for authority in capability.required_any_authority
            ):
                continue
            resolved.append(capability)
        return tuple(resolved)

    @staticmethod
    def _allows(
        principal: Principal,
        policy: AuthorizationPolicy,
        required: tuple[Capability, ...],
        path: str | None,
    ) -> bool:
        if principal.administrator or principal.identity_kind == "system":
            return True
        for authority in required:
            grants = [grant for grant in principal.scopes if grant.capability == authority]
            if path is not None:
                if not policy.allows(principal, authority, path):
                    return False
            elif not grants:
                return False
        return True
