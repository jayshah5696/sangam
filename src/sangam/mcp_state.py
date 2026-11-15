"""Small persistent App checkpoints and execution receipts, owned by Sangam."""

import json
import sqlite3
import threading
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from pydantic import JsonValue, TypeAdapter

from sangam.application import ApplicationServices
from sangam.capabilities import Capability
from sangam.config import Settings
from sangam.db import utc_now
from sangam.errors import ConflictError, NotFoundError, ValidationError
from sangam.idempotency import IdempotencyStore
from sangam.mcp_models import CheckpointDraft, DiscardDraft, SaveDraft
from sangam.schemas import Document, UpdateDocument
from sangam.security import Principal


class McpState:
    def __init__(self, services: ApplicationServices, settings: Settings) -> None:
        self.services = services
        self.settings = settings
        self.database = services.documents.database
        # A single Sangam process owns storage. Serialize draft/save transitions;
        # document writes still go through the canonical service's own locking.
        self.lock = threading.RLock()

    def cleanup(self) -> None:
        now = datetime.now(UTC)
        results_before = (now - timedelta(days=self.settings.mcp_result_retention_days)).isoformat()
        layouts_before = (
            now - timedelta(days=self.settings.mcp_workspace_retention_days)
        ).isoformat()
        with self.lock, self.database.transaction() as connection:
            connection.execute(
                "UPDATE mcp_executions SET result_json = NULL WHERE finished_at < ?",
                (results_before,),
            )
            connection.execute(
                "DELETE FROM mcp_workspaces WHERE draft IS NULL AND updated_at < ?",
                (layouts_before,),
            )

    def open(self, principal: Principal, document_id: str) -> dict[str, JsonValue]:
        document = self.services.workspace_access.get_document(principal, document_id)
        self.require_markdown(document)
        with self.lock, self.database.transaction() as connection:
            count = connection.execute(
                "SELECT count(*) FROM mcp_workspaces WHERE actor_id = ?", (principal.actor_id,)
            ).fetchone()[0]
            if count >= self.settings.mcp_max_workspaces_per_actor:
                raise ValidationError(
                    "Workspace quota reached. Reopen an existing workspace; "
                    "inactive clean layouts expire automatically."
                )
            workspace_id = f"mcpw_{uuid4().hex}"
            connection.execute(
                "INSERT INTO mcp_workspaces "
                "(workspace_id, actor_id, document_id, base_revision_id, updated_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (
                    workspace_id,
                    principal.actor_id,
                    document_id,
                    document.current_revision_id,
                    utc_now(),
                ),
            )
        return self.read(principal, workspace_id)

    @staticmethod
    def require_markdown(document: Document) -> None:
        if document.content_type != "text/markdown":
            raise ValidationError("This MCP slice edits Markdown documents only.")

    def _row(self, principal: Principal, workspace_id: str) -> sqlite3.Row:
        with self.database.connection() as connection:
            row: sqlite3.Row | None = connection.execute(
                "SELECT * FROM mcp_workspaces WHERE workspace_id = ? AND actor_id = ?",
                (workspace_id, principal.actor_id),
            ).fetchone()
        if row is None:
            raise NotFoundError(
                "Workspace unavailable or its clean layout expired. Open a fresh workspace."
            )
        return row

    def read(self, principal: Principal, workspace_id: str) -> dict[str, JsonValue]:
        with self.lock:
            row = self._row(principal, workspace_id)
            document = self.services.workspace_access.get_document(principal, row["document_id"])
            self.require_markdown(document)
            return {
                "workspace_id": workspace_id,
                "version": row["version"],
                "base_revision_id": row["base_revision_id"],
                "draft": row["draft"],
                "conflict": row["draft"] is not None
                and row["base_revision_id"] != document.current_revision_id,
                "can_update": self.services.authorization.allows(
                    principal, Capability.UPDATE, document.path
                ),
                "document": {
                    "document_id": document.document_id,
                    "title": document.title,
                    "path": document.path,
                    "content": document.content,
                    "current_revision_id": document.current_revision_id,
                },
            }

    def change(
        self, principal: Principal, action: CheckpointDraft | DiscardDraft | SaveDraft
    ) -> dict[str, JsonValue]:
        with self.lock:
            row = self._row(principal, action.workspace_id)
            document = self.services.workspace_access.get_document(principal, row["document_id"])
            self.require_markdown(document)
            self.services.authorization.require(principal, Capability.UPDATE, document.path)
            if isinstance(action, SaveDraft):
                with self.database.connection() as connection:
                    prior = connection.execute(
                        "SELECT * FROM mcp_workspace_saves "
                        "WHERE actor_id = ? AND operation_key = ?",
                        (principal.actor_id, action.operation_key),
                    ).fetchone()
                if prior:
                    if (
                        prior["workspace_id"] != action.workspace_id
                        or prior["version"] != action.expected_version
                    ):
                        raise ConflictError("Save key already belongs to a different save.")
                    result = self.read(principal, action.workspace_id)
                    result["saved_revision_id"] = prior["revision_id"]
                    return result
            if row["version"] != action.expected_version:
                raise ConflictError("Draft changed in another view. Refresh before changing it.")
            if isinstance(action, SaveDraft):
                if row["draft"] is None:
                    raise ValidationError("There is no checkpointed draft to save.")

                # Capture save evidence in the same transaction as the canonical
                # document commit; a lost response cannot create a second save.
                def record_save(connection: sqlite3.Connection) -> None:
                    committed = IdempotencyStore.lookup(
                        connection, actor_id=principal.actor_id, key=action.operation_key
                    )
                    if committed is not None and committed.revision_id is not None:
                        connection.execute(
                            "INSERT OR IGNORE INTO mcp_workspace_saves VALUES (?, ?, ?, ?, ?)",
                            (
                                principal.actor_id,
                                action.operation_key,
                                action.workspace_id,
                                action.expected_version,
                                committed.revision_id,
                            ),
                        )
                        connection.execute(
                            "UPDATE mcp_workspaces SET draft = NULL, base_revision_id = ?, "
                            "version = version + 1, updated_at = ? "
                            "WHERE workspace_id = ? AND version = ?",
                            (
                                committed.revision_id,
                                utc_now(),
                                action.workspace_id,
                                action.expected_version,
                            ),
                        )

                with self.database.commit_hook(record_save):
                    self.services.workspace_access.write_document(
                        principal,
                        document_id=document.document_id,
                        action="update",
                        body=UpdateDocument(
                            expected_revision_id=row["base_revision_id"], content=row["draft"]
                        ),
                        idempotency_key=action.operation_key,
                    )
            else:
                content = action.content if isinstance(action, CheckpointDraft) else None
                if content is not None and len(content.encode()) > self.settings.max_document_bytes:
                    raise ValidationError(
                        "Draft exceeds the configured document byte limit. "
                        "Previous checkpoint retained."
                    )
                with self.database.transaction() as connection:
                    used = connection.execute(
                        "SELECT coalesce(sum(length(cast(draft AS BLOB))), 0) "
                        "FROM mcp_workspaces WHERE actor_id = ? AND workspace_id != ?",
                        (principal.actor_id, action.workspace_id),
                    ).fetchone()[0]
                    if (
                        content is not None
                        and used + len(content.encode()) > self.settings.mcp_draft_quota_bytes
                    ):
                        raise ValidationError(
                            "Draft storage quota reached. Previous checkpoint retained."
                        )
                    base = (
                        row["base_revision_id"]
                        if row["draft"] is not None
                        else document.current_revision_id
                    )
                    if isinstance(action, DiscardDraft):
                        base = document.current_revision_id
                    connection.execute(
                        "UPDATE mcp_workspaces SET draft = ?, base_revision_id = ?, "
                        "version = version + 1, updated_at = ? "
                        "WHERE workspace_id = ? AND version = ?",
                        (content, base, utc_now(), action.workspace_id, action.expected_version),
                    )
            return self.read(principal, action.workspace_id)

    def begin(self, principal: Principal, key: str, fingerprint: str, *, capacity: bool) -> bool:
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT request_hash FROM mcp_executions WHERE actor_id = ? AND execution_key = ?",
                (principal.actor_id, key),
            ).fetchone()
            if row:
                if row["request_hash"] != fingerprint:
                    raise ConflictError("Execution key cannot be reused with a different program.")
                return False
            if not capacity:
                raise ValidationError("MCP capacity is full. Retry later with the same key.")
            count = connection.execute(
                "SELECT count(*) FROM mcp_executions WHERE actor_id = ?", (principal.actor_id,)
            ).fetchone()[0]
            if count >= self.settings.mcp_max_executions_per_actor:
                raise ValidationError(
                    "Execution receipt quota reached. Existing recovery records are preserved."
                )
            connection.execute(
                "INSERT INTO mcp_executions "
                "(actor_id, execution_key, request_hash, status, created_at) "
                "VALUES (?, ?, ?, 'running', ?)",
                (principal.actor_id, key, fingerprint, utc_now()),
            )
            return True

    def dependency(
        self,
        principal: Principal,
        key: str,
        document_id: str,
        capability: Capability = Capability.READ,
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO mcp_execution_documents VALUES (?, ?, ?, ?)",
                (principal.actor_id, key, document_id, capability.value),
            )

    def inherit_dependencies(self, principal: Principal, target: str, source: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO mcp_execution_documents "
                "SELECT actor_id, ?, document_id, capability FROM mcp_execution_documents "
                "WHERE actor_id = ? AND execution_key = ?",
                (target, principal.actor_id, source),
            )

    def authorize_dependencies(self, principal: Principal, key: str) -> None:
        with self.database.connection() as connection:
            dependencies = connection.execute(
                "SELECT document_id, capability FROM mcp_execution_documents "
                "WHERE actor_id = ? AND execution_key = ?",
                (principal.actor_id, key),
            ).fetchall()
        for dependency in dependencies:
            document = self.services.documents.get_document(dependency["document_id"])
            self.services.authorization.require(
                principal, Capability(dependency["capability"]), document.path
            )

    def before_write(
        self, principal: Principal, key: str, operation_key: str, document_id: str
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO mcp_execution_writes "
                "(actor_id, execution_key, operation_key, document_id) VALUES (?, ?, ?, ?)",
                (principal.actor_id, key, operation_key, document_id),
            )

    def reject_write(self, principal: Principal, key: str, operation_key: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE mcp_execution_writes SET outcome = 'rejected' "
                "WHERE actor_id = ? AND execution_key = ? AND operation_key = ? "
                "AND outcome != 'committed'",
                (principal.actor_id, key, operation_key),
            )

    def confirm_write(self, principal: Principal, key: str, operation_key: str) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE mcp_execution_writes SET outcome = 'committed' "
                "WHERE actor_id = ? AND execution_key = ? AND operation_key = ?",
                (principal.actor_id, key, operation_key),
            )

    def writes(self, principal: Principal, key: str, *, authorize: bool = True) -> list[JsonValue]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT operation_key, document_id, outcome FROM mcp_execution_writes "
                "WHERE actor_id = ? AND execution_key = ?",
                (principal.actor_id, key),
            ).fetchall()
            result: list[JsonValue] = []
            for row in rows:
                if authorize:
                    self.authorize_dependencies(principal, key)
                committed = IdempotencyStore.lookup(
                    connection, actor_id=principal.actor_id, key=row["operation_key"]
                )
                if (
                    row["outcome"] == "rejected"
                    or committed is not None
                    and committed.resource_id != row["document_id"]
                ):
                    committed = None
                result.append(
                    {
                        "operation_key": row["operation_key"],
                        "document_id": row["document_id"],
                        "outcome": "committed"
                        if committed and committed.completed
                        else row["outcome"],
                        "revision_id": committed.revision_id if committed else None,
                    }
                )
            return result

    def finish(
        self, principal: Principal, key: str, result: dict[str, JsonValue], *, failed: bool
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE mcp_executions SET status = ?, result_json = ?, finished_at = ? "
                "WHERE actor_id = ? AND execution_key = ?",
                (
                    "failed" if failed else "completed",
                    json.dumps(result, allow_nan=False),
                    utc_now(),
                    principal.actor_id,
                    key,
                ),
            )

    def status(self, principal: Principal, key: str) -> dict[str, JsonValue]:
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM mcp_executions WHERE actor_id = ? AND execution_key = ?",
                (principal.actor_id, key),
            ).fetchone()
            if row is None:
                raise NotFoundError("Execution not found.")
        self.authorize_dependencies(principal, key)
        if row["result_json"] is not None:
            cached = TypeAdapter(dict[str, JsonValue]).validate_json(row["result_json"])
            if "writes" in cached:
                cached["writes"] = self.writes(principal, key)
            return cached
        return {
            "execution_key": key,
            "status": row["status"],
            "writes": self.writes(principal, key),
            "message": "Result details expired."
            if row["finished_at"]
            else "Execution is running or was interrupted. Inspect operation keys; do not replay.",
        }

    def interrupt_previous_runs(self) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE mcp_executions SET status = 'interrupted', finished_at = ? "
                "WHERE status = 'running'",
                (utc_now(),),
            )
