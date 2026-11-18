"""Proposal mutations and App review use the canonical proposal service."""

import sqlite3
import uuid
from typing import Literal

from pydantic import JsonValue

from sangam.access import writes
from sangam.application import ApplicationServices
from sangam.capabilities import Capability
from sangam.errors import (
    AuthorizationError,
    ConflictError,
    IdempotencyError,
    NotFoundError,
    SangamError,
    ValidationError,
)
from sangam.idempotency import IdempotencyStore, request_hash
from sangam.mcp_errors import McpMutationError
from sangam.mcp_inspection import InspectionReads, ProposalMetadata, metadata
from sangam.mcp_models import (
    ApplyProposal,
    CreateProposal,
    DismissProposal,
    GetProposal,
    ListProposals,
    ProposalApplyApp,
    ProposalCreateApp,
    ProposalDismissApp,
    ProposalListApp,
    ProposalMutation,
    ProposalReadApp,
    ReadDocument,
    RevisionReadApp,
    SearchHit,
)
from sangam.mcp_state import McpState
from sangam.schemas import ChatProposal
from sangam.security import Principal
from sangam.service import append_fingerprint


class ProposalWriteResult(ProposalMetadata):
    operation_key: str
    resource_uri: str


class ProposalOperations:
    def __init__(self, services: ApplicationServices, state: McpState, reads: InspectionReads):
        self.services, self.state, self.reads = services, state, reads

    def invoke(
        self, principal: Principal, operation: ProposalMutation, execution_key: str | None = None
    ) -> dict[str, JsonValue]:
        service = self.services.chat.proposals
        if isinstance(operation, CreateProposal):
            source = None
            document_id = operation.document_id
        else:
            source = service.get(principal, operation.proposal_id)
            document_id = source.document_id
        document = self.services.workspace_access.get_document(
            principal, document_id, include_deleted=isinstance(operation, DismissProposal)
        )
        if not isinstance(operation, DismissProposal):
            self.services.authorization.require(principal, Capability.UPDATE, document.path)
        key = operation.operation_key
        resource_type = "proposal"
        resource_id = (
            source.proposal_id
            if source
            else str(uuid.uuid5(uuid.NAMESPACE_URL, f"sangam:external:{principal.actor_id}:{key}"))
        )
        mutation_kind = (
            "proposal_create" if isinstance(operation, CreateProposal) else "proposal_dismiss"
        )
        digest = request_hash(operation.model_dump(mode="json", exclude={"operation_key"}))
        if isinstance(operation, ApplyProposal):
            assert source is not None
            with self.state.database.connection() as connection:
                reserved = connection.execute(
                    "SELECT apply_idempotency_key, apply_actor_id FROM chat_proposals "
                    "WHERE proposal_id=?",
                    (source.proposal_id,),
                ).fetchone()
            key = reserved["apply_idempotency_key"] or key
            if reserved["apply_actor_id"] not in {None, principal.actor_id}:
                raise McpMutationError(
                    ConflictError("Apply recovery must use the original reviewer's actor"),
                    operation.operation_key,
                    "rejected",
                )
            resource_type, resource_id, mutation_kind = "document", document_id, "update"
            digest = append_fingerprint(
                document_id=document_id,
                expected_revision_id=operation.expected_revision_id,
                content=operation.content,
                title=None,
                path=None,
                operation="update",
                summary=source.summary,
                deleted=None,
            )
        if execution_key:
            self.state.dependency(principal, execution_key, document_id)
            if not isinstance(operation, DismissProposal):
                self.state.dependency(principal, execution_key, document_id, Capability.UPDATE)
            self.state.before_write(
                principal, execution_key, key, document_id, resource_type=resource_type
            )

        def record_commit(connection: sqlite3.Connection) -> None:
            if not execution_key:
                return
            committed = IdempotencyStore.lookup(connection, actor_id=principal.actor_id, key=key)
            if (
                committed
                and committed.completed
                and committed.operation == mutation_kind
                and committed.request_hash == digest
                and committed.resource_id == resource_id
            ):
                connection.execute(
                    "UPDATE mcp_execution_writes SET outcome='committed', resource_id=? "
                    "WHERE actor_id=? AND execution_key=? AND operation_key=?",
                    (resource_id, principal.actor_id, execution_key, key),
                )

        def mutate() -> ChatProposal:
            if isinstance(operation, CreateProposal):
                return service.prepare_external(
                    principal,
                    document_id=operation.document_id,
                    expected_revision_id=operation.expected_revision_id,
                    content=operation.content,
                    summary=operation.summary,
                    rationale=operation.rationale,
                    operation_key=operation.operation_key,
                    citations=operation.citations,
                    execution_key=execution_key,
                )
            if isinstance(operation, ApplyProposal):
                return service.apply(
                    principal,
                    proposal_id=operation.proposal_id,
                    expected_revision_id=operation.expected_revision_id,
                    content=operation.content,
                    idempotency_key=key,
                )
            return service.dismiss(
                principal, operation.proposal_id, operation.reason, operation_key=key
            )

        try:
            with self.state.database.commit_hook(record_commit):
                proposal = self.services.workspace_access.audited(
                    principal,
                    writes(mutation_kind, "proposal"),
                    mutate,
                    resource_id=source.proposal_id if source else resource_id,
                )
            with self.state.database.transaction() as connection:
                record_commit(connection)
        except (
            AuthorizationError,
            ConflictError,
            IdempotencyError,
            NotFoundError,
            ValidationError,
        ) as error:
            if execution_key:
                self.state.reject_write(principal, execution_key, key)
                raise
            outcome: Literal["rejected", "committed", "unknown"] = "unknown"
            try:
                current = self.services.identity.reauthorize(principal)
                self.services.workspace_access.get_document(current, document_id)
                with self.state.database.connection() as connection:
                    committed = IdempotencyStore.lookup(
                        connection, actor_id=current.actor_id, key=key
                    )
                    reservation = (
                        connection.execute(
                            "SELECT apply_idempotency_key FROM chat_proposals WHERE proposal_id=?",
                            (source.proposal_id,),
                        ).fetchone()
                        if source
                        else None
                    )
                if (
                    committed
                    and committed.completed
                    and committed.operation == mutation_kind
                    and committed.request_hash == digest
                    and committed.resource_id == resource_id
                ):
                    outcome = "committed"
                elif (
                    not isinstance(operation, ApplyProposal)
                    or not reservation
                    or reservation["apply_idempotency_key"] is None
                ):
                    outcome = "rejected"
            except SangamError:
                # Lost authority cannot establish whether the original mutation committed.
                pass
            raise McpMutationError(error, key, outcome) from error
        return ProposalWriteResult(
            **metadata(proposal).model_dump(),
            operation_key=key,
            resource_uri=f"sangam://proposal/{proposal.proposal_id}",
        ).model_dump(mode="json")

    def app(
        self,
        principal: Principal,
        action: ProposalListApp
        | ProposalReadApp
        | ProposalCreateApp
        | ProposalApplyApp
        | ProposalDismissApp
        | RevisionReadApp,
    ) -> dict[str, JsonValue]:
        # Serialize the clean-draft check with every App checkpoint/save.
        with self.state.lock:
            workspace = self.state.read(principal, action.workspace_id)
            reference = SearchHit.model_validate(workspace["document"])
            document = self.services.workspace_access.get_document(principal, reference.document_id)
            if isinstance(action, ProposalListApp):
                return self.reads.invoke(
                    principal,
                    ListProposals(
                        document_id=document.document_id, limit=action.limit, offset=action.offset
                    ),
                )
            if isinstance(action, (ProposalReadApp, ProposalApplyApp, ProposalDismissApp)):
                source = self.services.chat.proposals.get(principal, action.proposal_id)
                if source.document_id != document.document_id:
                    raise ValidationError("The proposal does not belong to this document workspace")
            elif action.document_id != document.document_id:
                raise ValidationError("The requested document does not match this workspace")
            payload = action.model_dump(exclude={"type", "workspace_id"})
            if isinstance(action, ProposalReadApp):
                return self.reads.invoke(principal, GetProposal.model_validate(payload))
            if isinstance(action, RevisionReadApp):
                return self.reads.invoke(principal, ReadDocument.model_validate(payload))
            if isinstance(action, ProposalApplyApp):
                if workspace["draft"] is not None:
                    raise McpMutationError(
                        ConflictError(
                            "Save or discard your document draft before applying a proposal"
                        ),
                        action.operation_key,
                        "rejected",
                    )
                return self.invoke(principal, ApplyProposal.model_validate(payload))
            if isinstance(action, ProposalCreateApp):
                return self.invoke(principal, CreateProposal.model_validate(payload))
            return self.invoke(principal, DismissProposal.model_validate(payload))
