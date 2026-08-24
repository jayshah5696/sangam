from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from sangam.authorization import AuthorizationPolicy
from sangam.capabilities import Capability
from sangam.errors import ValidationError
from sangam.schemas import Document
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
    limit: int = Field(default=5, ge=1, le=10)


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
    results: list[CitationSource] = Field(max_length=10)


class ReadDocumentInput(StrictCapabilityModel):
    document_id: str = Field(min_length=1, max_length=200)


class ReadDocumentResult(StrictCapabilityModel):
    source: CitationSource
    content: str = Field(max_length=40_000)


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


class ProposeUpdateInput(StrictCapabilityModel):
    document_id: str = Field(min_length=1, max_length=200)
    expected_revision_id: str = Field(min_length=1, max_length=200)
    content: str = Field(max_length=2_000_000)
    summary: str = Field(min_length=1, max_length=500)


class ProposeUpdateResult(StrictCapabilityModel):
    proposal_id: str = Field(max_length=200)
    status: Literal["pending"]
    message: str = Field(max_length=500)


class CreateDocumentInput(StrictCapabilityModel):
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(max_length=2_000_000)
    content_type: Literal["text/markdown"] = "text/markdown"


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
        1,
        "Create document",
        "Request one exact Markdown document creation.",
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
