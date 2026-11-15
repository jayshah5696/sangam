"""Bounded contracts shared by discovery, broker validation, and App actions."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

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


OperationInput = SearchDocuments | ReadDocument | UpdateDocument | ExecutionStatus


class SearchHit(BaseModel):
    document_id: str
    title: str
    path: str | None
    current_revision_id: str


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


class WorkspaceAction(Input):
    workspace_id: Identifier


class RefreshWorkspace(WorkspaceAction):
    type: Literal["refresh"]


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
    RefreshWorkspace | CheckpointDraft | DiscardDraft | SaveDraft | SearchApp,
    Field(discriminator="type"),
]
