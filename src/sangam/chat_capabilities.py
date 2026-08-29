from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sangam.authorization import AuthorizationPolicy
from sangam.capabilities import Capability
from sangam.errors import ValidationError
from sangam.schemas import Document, OrganizationOperation, OrganizationSnapshotItem
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


class CitationSource(StrictCapabilityModel):
    document_id: str = Field(max_length=200)
    title: str = Field(max_length=500)
    path: str | None = Field(default=None, max_length=1000)
    revision_id: str = Field(max_length=200)
    page_number: int | None = Field(default=None, ge=1)
    annotation_id: str | None = Field(default=None, max_length=200)
    citation: str = Field(max_length=2000)
    snippet: str | None = Field(default=None, max_length=4000)


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


class ReadDocumentResult(StrictCapabilityModel):
    source: CitationSource
    content: str = Field(max_length=40_000)
    offset: int = Field(ge=0)
    limit: int = Field(ge=1, le=40_000)
    total_chars: int = Field(ge=0)
    truncated: bool


class ReadPdfPageInput(StrictCapabilityModel):
    document_id: str = Field(min_length=1, max_length=200)
    page_number: int = Field(ge=1, le=100_000)


class PdfAnnotationResult(StrictCapabilityModel):
    annotation_id: str = Field(max_length=200)
    type: str = Field(max_length=80)
    selected_text: str | None = Field(default=None, max_length=20_000)
    note: str | None = Field(default=None, max_length=20_000)
    tags: list[str] = Field(max_length=50)


class ReadPdfPageResult(StrictCapabilityModel):
    source: CitationSource
    text: str = Field(max_length=40_000)
    annotations: list[PdfAnnotationResult] = Field(max_length=20)


ProposeUpdateMode = Literal["full", "replace", "insert_before", "insert_after", "append"]


class ProposeUpdateInput(StrictCapabilityModel):
    document_id: str = Field(min_length=1, max_length=200)
    expected_revision_id: str = Field(min_length=1, max_length=200)
    mode: ProposeUpdateMode = "full"
    content: str = Field(default="", max_length=2_000_000)
    anchor: str | None = Field(default=None, max_length=100_000)
    replace_all: bool = False
    summary: str = Field(min_length=1, max_length=500)

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
    handler: str
    renderer: str | None
    telemetry_redaction: Literal["metadata_only"] = "metadata_only"
    requires_global_scope: bool = False
    required_any_authority: tuple[Capability, ...] = ()

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
        "get_editor_selection",
        None,
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
        "search_workspace",
        None,
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
        "inspect_workspace_organization",
        None,
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
        "read_document",
        None,
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
        "read_pdf_page",
        None,
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
        "propose_update",
        "proposal_diff",
    ),
    ChatCapability(
        "create_document",
        2,
        "Create document",
        "Request one exact Markdown or HTML document creation.",
        CreateDocumentInput,
        EffectRequestResult,
        EffectClass.WRITE,
        ApprovalPolicy.EXACT_EFFECT,
        (Capability.CREATE,),
        ("workspace", "document"),
        (),
        10_000,
        10.0,
        "create_document",
        "document_create",
        requires_global_scope=True,
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
        "apply_workspace_organization_plan",
        "workspace_organization_plan",
        required_any_authority=(Capability.CREATE, Capability.MOVE, Capability.TAG),
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
        "publish_document",
        "document_publish",
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
                requires_global_scope=capability.requires_global_scope,
            ):
                continue
            if capability.required_any_authority and not any(
                self._allows(
                    principal,
                    policy,
                    (authority,),
                    path,
                    requires_global_scope=False,
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
        *,
        requires_global_scope: bool,
    ) -> bool:
        if principal.administrator or principal.identity_kind == "system":
            return True
        for authority in required:
            grants = [grant for grant in principal.scopes if grant.capability == authority]
            if requires_global_scope and not any(grant.path_prefix is None for grant in grants):
                return False
            if path is not None:
                if not policy.allows(principal, authority, path):
                    return False
            elif not grants:
                return False
        return True
