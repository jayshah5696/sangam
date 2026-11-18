"""Text creation through the canonical service, with original commit evidence."""

import sqlite3
from typing import Literal

from sangam.application import ApplicationServices
from sangam.capabilities import Capability
from sangam.errors import SangamError
from sangam.idempotency import IdempotencyStore, KeyRecord, request_hash
from sangam.mcp_errors import McpMutationError
from sangam.mcp_models import CreateDocument, CreationResult
from sangam.mcp_state import McpState
from sangam.security import Principal


class DocumentCreates:
    def __init__(self, services: ApplicationServices, state: McpState):
        self.services, self.state = services, state

    def invoke(
        self, principal: Principal, query: CreateDocument, execution_key: str | None = None
    ) -> CreationResult:
        principal = self.services.identity.reauthorize(principal)
        try:
            path = (
                self.services.documents.normalize_document_path(query.path)
                if query.path is not None
                else None
            )
        except SangamError as error:
            if execution_key is None:
                raise McpMutationError(error, query.operation_key, "rejected") from error
            raise
        digest = request_hash(
            {
                "title": query.title,
                "content": query.content,
                "path": path,
                "content_type": "text/markdown",
            }
        )
        if execution_key:
            self.state.before_write(principal, execution_key, query.operation_key, None)

        def committed(connection: sqlite3.Connection) -> KeyRecord | None:
            record = IdempotencyStore.lookup(
                connection, actor_id=principal.actor_id, key=query.operation_key
            )
            if (
                record
                and record.completed
                and record.operation == "create"
                and record.request_hash == digest
            ):
                return record
            return None

        def record_commit(connection: sqlite3.Connection) -> None:
            record = committed(connection)
            if execution_key and record:
                connection.execute(
                    "UPDATE mcp_execution_writes "
                    "SET outcome='committed', document_id=?, resource_id=? "
                    "WHERE actor_id=? AND execution_key=? AND operation_key=?",
                    (
                        record.resource_id,
                        record.resource_id,
                        principal.actor_id,
                        execution_key,
                        query.operation_key,
                    ),
                )
                connection.execute(
                    "INSERT OR IGNORE INTO mcp_execution_documents VALUES (?, ?, ?, ?)",
                    (
                        principal.actor_id,
                        execution_key,
                        record.resource_id,
                        Capability.CREATE.value,
                    ),
                )

        try:
            with self.state.database.commit_hook(record_commit):
                document = self.services.workspace_access.create_document(
                    principal,
                    title=query.title,
                    content=query.content,
                    path=query.path,
                    idempotency_key=query.operation_key,
                )
            with self.state.database.transaction() as connection:
                record_commit(connection)
                original = committed(connection)
            if original is None or original.revision_id is None:
                raise RuntimeError("Creation has no matching canonical commit reference")
            self.services.authorization.require(principal, Capability.CREATE, document.path)
        except SangamError as error:
            if execution_key:
                self.state.reject_write(principal, execution_key, query.operation_key)
                raise
            outcome: Literal["rejected", "committed", "unknown"] = "unknown"
            try:
                current = self.services.identity.reauthorize(principal)
                with self.state.database.connection() as connection:
                    known = committed(connection)
                if known:
                    target = self.services.documents.get_document(
                        known.resource_id, include_deleted=True
                    )
                    self.services.authorization.require(current, Capability.CREATE, target.path)
                outcome = "committed" if known else "rejected"
            except SangamError:
                pass
            raise McpMutationError(error, query.operation_key, outcome) from error
        return CreationResult(
            document_id=document.document_id,
            current_revision_id=document.current_revision_id,
            created_revision_id=original.revision_id,
            operation_key=query.operation_key,
            resource_uri=f"sangam://document/{document.document_id}",
        )
