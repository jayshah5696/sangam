"""Bounded artifact inspection through canonical revision and proposal readers."""

from typing import Literal

from pydantic import BaseModel, Field, JsonValue, TypeAdapter

from sangam.access import reads
from sangam.application import ApplicationServices
from sangam.errors import NotFoundError, ValidationError
from sangam.mcp_models import (
    DocumentPassage,
    GetProposal,
    InspectionOperation,
    ListProposals,
    ReadDocument,
    ReadHistory,
)
from sangam.mcp_state import McpState
from sangam.schemas import (
    ChatProposal,
    ChatProposalCitation,
    ChatProposalEvidence,
    ChatProposalSource,
    ChatProposalSummary,
)
from sangam.security import Principal

_JSON = TypeAdapter(dict[str, JsonValue])


class DiffPassage(BaseModel):
    document_id: str
    from_revision_id: str
    to_revision_id: str
    unified_diff: str
    additions: int
    deletions: int
    next_offset: int | None


class ProposalMetadata(BaseModel):
    proposal_id: str
    document_id: str
    conversation_id: str | None
    expected_revision_id: str
    applied_revision_id: str | None
    status: Literal["pending", "applied", "stale", "dismissed"]
    summary: str | None
    created_at: str


class ProposalPage(BaseModel):
    items: list[ProposalMetadata]
    next_offset: int | None


class ProposalPassage(ProposalMetadata):
    content: str
    content_kind: Literal["proposed", "applied"]
    next_offset: int | None
    current_revision_id: str
    document_deleted: bool
    rationale: str | None
    judgment_needed: str | None
    model_opinion: str | None
    evidence_included: bool
    evidence_status: Literal["not_recorded", "recorded", "unavailable"]
    evidence: ChatProposalEvidence | None = None
    citations: list[ChatProposalCitation] = Field(default_factory=list)
    sources_retrieved: list[ChatProposalSource] = Field(default_factory=list)
    sources_retrieved_truncated: bool
    resource_uri: str


def metadata(proposal: ChatProposal | ChatProposalSummary) -> ProposalMetadata:
    return ProposalMetadata(
        proposal_id=proposal.proposal_id,
        document_id=proposal.document_id,
        conversation_id=proposal.thread_id,
        expected_revision_id=proposal.expected_revision_id,
        applied_revision_id=proposal.applied_revision_id,
        status=proposal.status,
        summary=proposal.summary,
        created_at=proposal.created_at,
    )


class InspectionReads:
    def __init__(self, services: ApplicationServices, state: McpState) -> None:
        self.services, self.state = services, state

    def proposal(
        self, principal: Principal, query: GetProposal, execution_key: str | None
    ) -> ProposalPassage:
        source = self.services.chat.proposals.get(principal, query.proposal_id)
        document = self.services.workspace_access.get_document(
            principal, source.document_id, include_deleted=True
        )
        text = source.content if query.content_kind == "proposed" else source.applied_content
        if text is None:
            raise NotFoundError("This proposal has no applied wording.")
        if execution_key:
            self.state.dependency(principal, execution_key, source.document_id)
            if query.include_evidence:
                ids = {item.document_id for item in source.citations if item.available}
                ids.update(item.document_id for item in source.sources_retrieved)
                if source.evidence:
                    ids.add(source.evidence.document_id)
                for identifier in ids:
                    self.state.dependency(principal, execution_key, identifier)
        end = query.offset + query.length
        return ProposalPassage(
            **metadata(source).model_dump(),
            content=text[query.offset : end],
            content_kind=query.content_kind,
            next_offset=end if end < len(text) else None,
            current_revision_id=document.current_revision_id,
            document_deleted=document.deleted,
            rationale=source.rationale,
            judgment_needed=source.judgment_needed,
            model_opinion=source.model_opinion,
            evidence_included=query.include_evidence,
            evidence_status=source.evidence_status,
            evidence=source.evidence if query.include_evidence else None,
            citations=source.citations if query.include_evidence else [],
            sources_retrieved=source.sources_retrieved if query.include_evidence else [],
            sources_retrieved_truncated=source.sources_retrieved_truncated,
            resource_uri=f"sangam://proposal/{source.proposal_id}",
        )

    def proposals(
        self, principal: Principal, query: ListProposals, execution_key: str | None
    ) -> ProposalPage:
        selected = self.services.chat.proposals.summaries(
            principal,
            document_id=query.document_id,
            thread_id=query.conversation_id,
            limit=query.limit + 1,
            offset=query.offset,
        )
        visible = selected[: query.limit]
        if execution_key:
            for item in visible:
                self.state.dependency(principal, execution_key, item.document_id)
        return ProposalPage(
            items=[metadata(item) for item in visible],
            next_offset=query.offset + query.limit if len(selected) > query.limit else None,
        )

    def invoke(
        self, principal: Principal, query: InspectionOperation, execution_key: str | None = None
    ) -> dict[str, JsonValue]:
        result: BaseModel
        if isinstance(query, GetProposal):
            result = self.services.workspace_access.audited(
                principal,
                reads("read", "proposal"),
                lambda: self.proposal(principal, query, execution_key),
                resource_id=query.proposal_id,
            )
        elif isinstance(query, ListProposals):
            result = self.services.workspace_access.audited(
                principal,
                reads("list", "proposal"),
                lambda: self.proposals(principal, query, execution_key),
            )
        else:
            document = self.services.workspace_access.get_document(
                principal, query.document_id, include_deleted=True
            )
            if execution_key:
                self.state.dependency(principal, execution_key, document.document_id)
            if isinstance(query, ReadHistory):
                result = self.services.workspace_access.revision_page(
                    principal, document.document_id, limit=query.limit, cursor=query.cursor
                )
            else:
                if document.content_type not in {"text/markdown", "text/html"}:
                    raise ValidationError(
                        "Use PDF research operations. Text reads/diffs do not expose PDF bytes."
                    )
                end = query.offset + query.length
                if isinstance(query, ReadDocument):
                    revision = self.services.workspace_access.get_revision(
                        principal,
                        document.document_id,
                        query.revision_id or document.current_revision_id,
                    )
                    result = DocumentPassage(
                        document_id=document.document_id,
                        title=document.title,
                        current_revision_id=document.current_revision_id,
                        revision_id=revision.revision_id,
                        content_type=document.content_type,
                        content=revision.content[query.offset : end],
                        next_offset=end if end < len(revision.content) else None,
                    )
                else:
                    diff = self.services.workspace_access.revision_diff(
                        principal,
                        document_id=document.document_id,
                        from_revision_id=query.from_revision_id,
                        to_revision_id=query.to_revision_id,
                    )
                    result = DiffPassage(
                        document_id=diff.document_id,
                        from_revision_id=diff.from_revision_id,
                        to_revision_id=diff.to_revision_id,
                        unified_diff=diff.unified_diff[query.offset : end],
                        additions=diff.additions,
                        deletions=diff.deletions,
                        next_offset=end if end < len(diff.unified_diff) else None,
                    )
        return _JSON.validate_python(result.model_dump(mode="json"))
