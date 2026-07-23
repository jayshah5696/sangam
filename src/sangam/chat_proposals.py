from __future__ import annotations

import hashlib
import sqlite3
import uuid
from dataclasses import dataclass

from sangam.access import WorkspaceAccessService
from sangam.db import Database, utc_now
from sangam.errors import AuthorizationError, ConflictError, NotFoundError, ValidationError
from sangam.schemas import ChatProposal
from sangam.security import Principal


@dataclass(frozen=True)
class ReservedChatProposal:
    proposal: ChatProposal
    idempotency_key: str


class ChatProposalRepository:
    """Owner-scoped persistence for reviewable chat proposals."""

    def __init__(self, database: Database) -> None:
        self.database = database

    def require_thread_owner(self, thread_id: str, principal: Principal) -> None:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT created_by FROM chat_threads WHERE thread_id = ?", (thread_id,)
            ).fetchone()
        if row is None or row["created_by"] != principal.actor_id:
            raise NotFoundError(f"Chat thread not found: {thread_id}")

    def create(
        self,
        principal: Principal,
        *,
        proposal_id: str,
        thread_id: str,
        document_id: str,
        expected_revision_id: str,
        content: str,
        summary: str | None,
    ) -> ChatProposal:
        self.require_thread_owner(thread_id, principal)
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT INTO chat_proposals(
                    proposal_id, thread_id, document_id, expected_revision_id,
                    content, summary, status, applied_revision_id, created_at, applied_at,
                    apply_idempotency_key
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, NULL, NULL)
                ON CONFLICT(proposal_id) DO NOTHING
                """,
                (
                    proposal_id,
                    thread_id,
                    document_id,
                    expected_revision_id,
                    content,
                    summary,
                    utc_now(),
                ),
            )
        return self.get_owned(principal, proposal_id)

    def list_owned(
        self, principal: Principal, *, thread_id: str | None, document_id: str | None
    ) -> list[ChatProposal]:
        clauses = ["thread.created_by = ?"]
        params: list[object] = [principal.actor_id]
        if thread_id:
            clauses.append("proposal.thread_id = ?")
            params.append(thread_id)
        if document_id:
            clauses.append("proposal.document_id = ?")
            params.append(document_id)
        with self.database.connection() as connection:
            rows = connection.execute(
                f"""
                SELECT proposal.* FROM chat_proposals AS proposal
                JOIN chat_threads AS thread ON thread.thread_id = proposal.thread_id
                WHERE {" AND ".join(clauses)}
                ORDER BY proposal.created_at DESC
                """,
                params,
            ).fetchall()
        return [_proposal_from_row(row) for row in rows]

    def get_owned(self, principal: Principal, proposal_id: str) -> ChatProposal:
        with self.database.connection() as connection:
            row = self._owned_row(connection, principal, proposal_id)
        return _proposal_from_row(row)

    def reserve_apply(
        self, principal: Principal, proposal_id: str, idempotency_key: str
    ) -> ReservedChatProposal:
        with self.database.transaction() as connection:
            row = self._owned_row(connection, principal, proposal_id)
            proposal = _proposal_from_row(row)
            if proposal.status != "pending":
                raise ConflictError(f"The proposal is already {proposal.status}")
            reserved_key = row["apply_idempotency_key"] or idempotency_key
            if row["apply_idempotency_key"] is None:
                connection.execute(
                    """
                    UPDATE chat_proposals SET apply_idempotency_key = ?
                    WHERE proposal_id = ? AND apply_idempotency_key IS NULL
                    """,
                    (reserved_key, proposal_id),
                )
        return ReservedChatProposal(proposal=proposal, idempotency_key=reserved_key)

    def mark_applied(
        self, principal: Principal, proposal_id: str, applied_revision_id: str
    ) -> ChatProposal:
        with self.database.transaction() as connection:
            self._owned_row(connection, principal, proposal_id)
            connection.execute(
                """
                UPDATE chat_proposals
                SET status = 'applied', applied_revision_id = ?, applied_at = ?
                WHERE proposal_id = ? AND status = 'pending'
                """,
                (applied_revision_id, utc_now(), proposal_id),
            )
        return self.get_owned(principal, proposal_id)

    def release_apply_reservation(
        self, principal: Principal, proposal_id: str, idempotency_key: str
    ) -> ChatProposal:
        """Release a reservation when validation failed before a document commit.

        Ambiguous failures after a commit deliberately retain the reservation so a
        retry reuses the original document idempotency key. This method is only used
        for access, existence, and validation failures that occur before mutation.
        """
        with self.database.transaction() as connection:
            self._owned_row(connection, principal, proposal_id)
            connection.execute(
                """
                UPDATE chat_proposals SET apply_idempotency_key = NULL
                WHERE proposal_id = ? AND status = 'pending'
                    AND apply_idempotency_key = ?
                """,
                (proposal_id, idempotency_key),
            )
        return self.get_owned(principal, proposal_id)

    def mark_stale(self, principal: Principal, proposal_id: str) -> ChatProposal:
        with self.database.transaction() as connection:
            self._owned_row(connection, principal, proposal_id)
            connection.execute(
                """
                UPDATE chat_proposals SET status = 'stale'
                WHERE proposal_id = ? AND status = 'pending'
                """,
                (proposal_id,),
            )
        return self.get_owned(principal, proposal_id)

    def dismiss(self, principal: Principal, proposal_id: str, summary: str | None) -> ChatProposal:
        with self.database.transaction() as connection:
            row = self._owned_row(connection, principal, proposal_id)
            proposal = _proposal_from_row(row)
            if proposal.status not in ("pending", "stale"):
                raise ConflictError(f"The proposal is already {proposal.status}")
            # A stale proposal's apply has already terminated, so its reserved
            # idempotency key is spent and dismissing it is safe. Only a pending
            # proposal with a live reservation is still mid-apply and must not be
            # dismissed out from under the in-flight document update.
            if proposal.status == "pending" and row["apply_idempotency_key"] is not None:
                raise ConflictError("The proposal is already being applied")
            connection.execute(
                """
                UPDATE chat_proposals SET status = 'dismissed', summary = ?
                WHERE proposal_id = ? AND status IN ('pending', 'stale')
                """,
                (summary, proposal_id),
            )
        return self.get_owned(principal, proposal_id)

    @staticmethod
    def _owned_row(
        connection: sqlite3.Connection, principal: Principal, proposal_id: str
    ) -> sqlite3.Row:
        row = connection.execute(
            """
            SELECT proposal.* FROM chat_proposals AS proposal
            JOIN chat_threads AS thread ON thread.thread_id = proposal.thread_id
            WHERE proposal.proposal_id = ? AND thread.created_by = ?
            """,
            (proposal_id, principal.actor_id),
        ).fetchone()
        if row is None:
            raise NotFoundError(f"Chat proposal not found: {proposal_id}")
        return row


class ChatProposalService:
    """Coordinates proposal review through Sangam's canonical document mutation path."""

    def __init__(
        self, *, repository: ChatProposalRepository, workspace: WorkspaceAccessService
    ) -> None:
        self.repository = repository
        self.workspace = workspace

    def create(
        self,
        principal: Principal,
        *,
        thread_id: str,
        document_id: str,
        expected_revision_id: str,
        content: str,
        summary: str,
    ) -> ChatProposal:
        self.repository.require_thread_owner(thread_id, principal)
        self.workspace.validate_proposed_update(
            principal,
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=content,
        )
        proposal_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                "sangam:"
                f"{thread_id}:{document_id}:{expected_revision_id}:"
                f"{hashlib.sha256(content.encode()).hexdigest()}",
            )
        )
        return self.repository.create(
            principal,
            proposal_id=proposal_id,
            thread_id=thread_id,
            document_id=document_id,
            expected_revision_id=expected_revision_id,
            content=content,
            summary=_bounded_text(summary, 500),
        )

    def list(
        self, principal: Principal, *, thread_id: str | None, document_id: str | None
    ) -> list[ChatProposal]:
        return self.repository.list_owned(principal, thread_id=thread_id, document_id=document_id)

    def apply(
        self,
        principal: Principal,
        *,
        proposal_id: str,
        expected_revision_id: str,
        idempotency_key: str,
    ) -> ChatProposal:
        proposal = self.repository.get_owned(principal, proposal_id)
        if proposal.expected_revision_id != expected_revision_id:
            raise ConflictError("The proposal revision does not match the reviewed revision")
        reserved = self.repository.reserve_apply(principal, proposal_id, idempotency_key)
        proposal = reserved.proposal
        try:
            document = self.workspace.update_document(
                principal,
                document_id=proposal.document_id,
                expected_revision_id=expected_revision_id,
                content=proposal.content,
                title=None,
                summary=proposal.summary,
                idempotency_key=reserved.idempotency_key,
            )
        except ConflictError:
            self.repository.mark_stale(principal, proposal_id)
            raise
        except (AuthorizationError, NotFoundError, ValidationError):
            self.repository.release_apply_reservation(
                principal, proposal_id, reserved.idempotency_key
            )
            raise
        return self.repository.mark_applied(principal, proposal_id, document.current_revision_id)

    def dismiss(self, principal: Principal, proposal_id: str, reason: str | None) -> ChatProposal:
        proposal = self.repository.get_owned(principal, proposal_id)
        summary = proposal.summary
        if reason:
            summary = f"{summary or 'Proposal'} — {_bounded_text(reason, 500)}"
        return self.repository.dismiss(principal, proposal_id, summary)


def _proposal_from_row(row: sqlite3.Row) -> ChatProposal:
    return ChatProposal(
        proposal_id=row["proposal_id"],
        thread_id=row["thread_id"],
        document_id=row["document_id"],
        expected_revision_id=row["expected_revision_id"],
        content=row["content"],
        summary=row["summary"],
        status=row["status"],
        applied_revision_id=row["applied_revision_id"],
        created_at=row["created_at"],
        applied_at=row["applied_at"],
    )


def _bounded_text(value: str, limit: int) -> str:
    encoded = value.encode("utf-8")
    if len(encoded) <= limit:
        return value
    return encoded[:limit].decode("utf-8", errors="ignore") + "\n[truncated]"
