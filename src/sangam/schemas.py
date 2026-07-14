from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Document(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    document_id: str
    title: str
    content_type: Literal["text/markdown"]
    path: str | None
    current_revision_id: str
    content: str
    content_hash: str
    size_bytes: int
    materialization_state: Literal["none", "pending", "clean", "conflict"]
    file_hash: str | None
    deleted: bool
    created_by: str
    created_at: str
    updated_at: str
    category: str | None
    metadata_version: int
    tags: list[Tag] = Field(default_factory=list)


class Tag(BaseModel):
    tag_id: str
    name: str
    color: str
    created_at: str


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


class ErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, object] = Field(default_factory=dict)
