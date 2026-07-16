from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from sangam.capabilities import Capability


class Tag(BaseModel):
    tag_id: str
    name: str
    color: str
    created_at: str


class DocumentSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    document_id: str
    title: str
    content_type: Literal["text/markdown"]
    path: str | None
    current_revision_id: str
    content_hash: str
    size_bytes: int
    materialization_state: Literal["none", "pending", "clean", "conflict"]
    file_hash: str | None
    deleted: bool
    created_by: str
    created_at: str
    updated_at: str
    updated_by: str
    updated_by_name: str
    revision_summary: str | None
    category: str | None
    metadata_version: int
    tags: list[Tag] = Field(default_factory=list)
    search_snippet: str | None = None


class Document(DocumentSummary):
    content: str


class Folder(BaseModel):
    folder_id: str
    path: str
    name: str
    category: str | None
    metadata_version: int
    tags: list[Tag] = Field(default_factory=list)
    document_count: int = 0
    created_at: str
    updated_at: str


class Revision(BaseModel):
    revision_id: str
    document_id: str
    parent_revision_id: str | None
    content: str
    content_hash: str
    size_bytes: int
    actor_id: str
    actor_display_name: str | None = None
    actor_kind: str | None = None
    operation_id: str | None = None
    operation: str
    summary: str | None
    created_at: str


class CreateDocument(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    content: str = ""
    path: str | None = None


class UpdateDocumentMetadata(BaseModel):
    expected_metadata_version: int = Field(ge=0)
    category: str | None = Field(default=None, max_length=120)
    tag_ids: list[str] = Field(default_factory=list, max_length=50)


class CreateTag(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")


class CreateFolder(BaseModel):
    path: str = Field(min_length=1, max_length=500)
    category: str | None = Field(default=None, max_length=120)
    tag_ids: list[str] = Field(default_factory=list, max_length=50)


class UpdateFolderMetadata(BaseModel):
    expected_metadata_version: int = Field(ge=0)
    category: str | None = Field(default=None, max_length=120)
    tag_ids: list[str] = Field(default_factory=list, max_length=50)


class UpdateDocument(BaseModel):
    expected_revision_id: str
    content: str
    title: str | None = Field(default=None, min_length=1, max_length=240)
    summary: str | None = Field(default=None, max_length=500)


class PathMutation(BaseModel):
    expected_revision_id: str
    path: str
    summary: str | None = Field(default=None, max_length=500)


class DeleteDocument(BaseModel):
    expected_revision_id: str
    summary: str | None = Field(default=None, max_length=500)


class RestoreDocument(BaseModel):
    expected_revision_id: str
    revision_id: str
    summary: str | None = Field(default=None, max_length=500)


class DuplicateDocument(BaseModel):
    expected_revision_id: str
    title: str | None = Field(default=None, min_length=1, max_length=240)
    path: str | None = Field(default=None, max_length=500)


class RevisionDiff(BaseModel):
    document_id: str
    from_revision_id: str
    to_revision_id: str
    unified_diff: str
    additions: int
    deletions: int


class ReindexPath(BaseModel):
    path: str


class ReconciliationConflict(BaseModel):
    conflict_id: str
    conflict_type: str
    document_id: str | None
    path: str
    candidate_path: str | None
    expected_hash: str | None
    actual_hash: str | None
    status: str
    created_at: str
    resolved_at: str | None


class ReconciliationReport(BaseModel):
    repaired_document_ids: list[str]
    conflicts: list[ReconciliationConflict]


class BackupArtifact(BaseModel):
    name: str
    sha256: str
    size_bytes: int


class BackupSet(BaseModel):
    backup_id: str
    created_at: str
    document_count: int
    revision_count: int
    artifacts: list[BackupArtifact]
    verified_at: str | None = None


class BackupVerification(BaseModel):
    backup_id: str
    valid: bool
    database_integrity: str
    workspace_members: int
    verified_at: str


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, object] = Field(default_factory=dict)


class TokenScope(BaseModel):
    capability: Capability
    path_prefix: str | None = None


class Actor(BaseModel):
    actor_id: str
    display_name: str
    identity_kind: Literal["human", "agent", "integration", "client", "system"]
    created_at: str


class AgentToken(BaseModel):
    token_id: str
    actor_id: str
    actor_display_name: str
    label: str
    scopes: list[TokenScope]
    created_at: str
    expires_at: str | None
    revoked_at: str | None
    last_used_at: str | None
    rotated_from_token_id: str | None


class IssuedAgentToken(AgentToken):
    token: str


class CreateAgentToken(BaseModel):
    actor_id: str = Field(pattern=r"^agent:[a-z0-9][a-z0-9._-]{1,63}$")
    display_name: str = Field(min_length=1, max_length=120)
    label: str = Field(min_length=1, max_length=120)
    scopes: list[TokenScope] = Field(min_length=1, max_length=50)
    expires_at: str | None = None


class OperationEvent(BaseModel):
    operation_id: str
    actor_id: str
    actor_display_name: str
    actor_kind: str
    token_id: str | None
    token_label: str | None
    action: str
    resource_type: str
    resource_id: str | None
    path: str | None
    outcome: Literal["accepted", "denied", "conflict", "failed"]
    error_code: str | None
    revision_id: str | None
    details: dict[str, object]
    created_at: str
