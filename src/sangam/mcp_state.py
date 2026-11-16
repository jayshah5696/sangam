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
from sangam.mcp_models import (
    ActivateDocument,
    CheckpointDraft,
    CloseDocument,
    DiscardDraft,
    ExecutionReceipt,
    OpenDocument,
    ReadDocument,
    SaveDraft,
    WorkspaceLayout,
    WorkspaceTab,
)
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
                "DELETE FROM mcp_layouts WHERE updated_at < ? AND NOT EXISTS ("
                "SELECT 1 FROM mcp_layout_documents t JOIN mcp_workspaces w "
                "ON w.workspace_id = t.workspace_id WHERE t.layout_id = mcp_layouts.layout_id "
                "AND w.draft IS NOT NULL)",
                (layouts_before,),
            )
            connection.execute(
                "DELETE FROM mcp_workspaces WHERE draft IS NULL AND NOT EXISTS ("
                "SELECT 1 FROM mcp_layout_documents t "
                "WHERE t.workspace_id = mcp_workspaces.workspace_id)"
            )

    def _capacity(self, connection: sqlite3.Connection, principal: Principal, added: int) -> None:
        count = connection.execute(
            "SELECT count(*) FROM mcp_workspaces WHERE actor_id = ?", (principal.actor_id,)
        ).fetchone()[0]
        if count + added > self.settings.mcp_max_workspaces_per_actor:
            raise ValidationError(
                "Workspace quota reached. Save or discard drafts and close unused documents."
            )

    @staticmethod
    def _insert_document(
        connection: sqlite3.Connection, principal: Principal, document: Document
    ) -> str:
        workspace_id = f"mcpw_{uuid4().hex}"
        connection.execute(
            "INSERT INTO mcp_workspaces "
            "(workspace_id, actor_id, document_id, base_revision_id, updated_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                workspace_id,
                principal.actor_id,
                document.document_id,
                document.current_revision_id,
                utc_now(),
            ),
        )
        return workspace_id

    def _append_documents(
        self,
        connection: sqlite3.Connection,
        principal: Principal,
        layout_id: str,
        documents: list[Document],
    ) -> tuple[str, bool]:
        rows = connection.execute(
            "SELECT w.workspace_id, w.document_id, t.position FROM mcp_layout_documents t "
            "JOIN mcp_workspaces w ON w.workspace_id = t.workspace_id "
            "WHERE t.layout_id = ? ORDER BY t.position",
            (layout_id,),
        ).fetchall()
        known = {row["document_id"]: row["workspace_id"] for row in rows}
        added = sum(document.document_id not in known for document in documents)
        self._capacity(connection, principal, added)
        position = max((row["position"] for row in rows), default=-1) + 1
        for document in documents:
            if document.document_id not in known:
                workspace_id = self._insert_document(connection, principal, document)
                connection.execute(
                    "INSERT INTO mcp_layout_documents VALUES (?, ?, ?)",
                    (layout_id, workspace_id, position),
                )
                known[document.document_id] = workspace_id
                position += 1
        return known[documents[0].document_id], bool(added)

    def _layout_row(self, principal: Principal, workspace_id: str) -> sqlite3.Row:
        with self.database.connection() as connection:
            row: sqlite3.Row | None = connection.execute(
                "SELECT l.* FROM mcp_layouts l "
                "JOIN mcp_layout_documents t ON t.layout_id = l.layout_id "
                "JOIN mcp_workspaces w ON w.workspace_id = t.workspace_id "
                "WHERE w.workspace_id = ? AND w.actor_id = ? AND l.actor_id = ?",
                (workspace_id, principal.actor_id, principal.actor_id),
            ).fetchone()
        if row is None:
            raise NotFoundError("Workspace layout unavailable or expired. Open a fresh workspace.")
        return row

    def restore(self, principal: Principal, layout_id: str) -> dict[str, JsonValue]:
        with self.lock:
            with self.database.connection() as connection:
                row = connection.execute(
                    "SELECT * FROM mcp_layouts WHERE layout_id = ? AND actor_id = ?",
                    (layout_id, principal.actor_id),
                ).fetchone()
            if row is None:
                raise NotFoundError(
                    "Workspace layout unavailable or expired. Open a fresh workspace."
                )
            view = self._layout_view(principal, row, row["active_workspace_id"])
            if not view.tabs:
                raise NotFoundError("No open documents are available with this connection.")
            visible = {tab.workspace_id for tab in view.tabs}
            selected = (
                row["active_workspace_id"]
                if row["active_workspace_id"] in visible
                else view.tabs[0].workspace_id
            )
            with self.database.transaction() as connection:
                connection.execute(
                    "UPDATE mcp_layouts SET active_workspace_id = ?, updated_at = ?, "
                    "version = version + ? WHERE layout_id = ?",
                    (selected, utc_now(), int(selected != row["active_workspace_id"]), layout_id),
                )
            return self.read(principal, selected)

    def _layout_view(
        self, principal: Principal, row: sqlite3.Row, workspace_id: str
    ) -> WorkspaceLayout:
        # Project only metadata. Reading every saved document body on a tab refresh
        # would multiply memory and I/O by the number of open documents.
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT w.workspace_id, w.document_id, w.draft IS NOT NULL AS has_draft, "
                "d.title, d.path, d.deleted, d.content_type FROM mcp_layout_documents t "
                "JOIN mcp_workspaces w ON w.workspace_id = t.workspace_id "
                "JOIN documents d ON d.document_id = w.document_id "
                "WHERE t.layout_id = ? ORDER BY t.position",
                (row["layout_id"],),
            ).fetchall()
        tabs: list[WorkspaceTab] = []
        visible: set[str] = set()
        for tab in rows:
            if (
                tab["deleted"]
                or tab["content_type"] != "text/markdown"
                or not self.services.authorization.allows(principal, Capability.READ, tab["path"])
            ):
                continue
            visible.add(tab["workspace_id"])
            tabs.append(
                WorkspaceTab(
                    workspace_id=tab["workspace_id"],
                    document_id=tab["document_id"],
                    title=tab["title"],
                    path=tab["path"],
                    has_draft=bool(tab["has_draft"]),
                )
            )
        return WorkspaceLayout(
            layout_id=row["layout_id"],
            version=row["version"],
            active_workspace_id=row["active_workspace_id"]
            if row["active_workspace_id"] in visible
            else workspace_id,
            tabs=tabs,
            unavailable_count=len(rows) - len(tabs),
        )

    def open(
        self,
        principal: Principal,
        document_id: str,
        *,
        workspace_id: str | None = None,
        additional_document_ids: list[str] | None = None,
    ) -> dict[str, JsonValue]:
        with self.lock:
            layout = None
            if workspace_id:
                anchor = self._row(principal, workspace_id)
                if anchor["document_id"] != document_id:
                    raise ValidationError("Workspace belongs to a different document.")
                layout = self._layout_row(principal, workspace_id)
            ids = list(dict.fromkeys([document_id, *(additional_document_ids or [])]))
            if len(ids) > self.settings.mcp_max_workspaces_per_actor:
                raise ValidationError("Too many documents for the configured workspace quota.")
            documents: list[Document] = []
            for identifier in ids:
                ReadDocument(document_id=identifier)
                document = self.services.workspace_access.get_document(principal, identifier)
                self.require_markdown(document)
                documents.append(document)
            with self.database.transaction() as connection:
                if layout is None:
                    self._capacity(connection, principal, len(documents))
                    workspace_id = self._insert_document(connection, principal, documents[0])
                    layout_id = f"mcpl_{uuid4().hex}"
                    connection.execute(
                        "INSERT INTO mcp_layouts "
                        "(layout_id, actor_id, active_workspace_id, updated_at) "
                        "VALUES (?, ?, ?, ?)",
                        (layout_id, principal.actor_id, workspace_id, utc_now()),
                    )
                    connection.execute(
                        "INSERT INTO mcp_layout_documents VALUES (?, ?, 0)",
                        (layout_id, workspace_id),
                    )
                else:
                    layout_id = layout["layout_id"]
                selected, added = self._append_documents(
                    connection, principal, layout_id, documents
                )
                connection.execute(
                    "UPDATE mcp_layouts SET active_workspace_id = ?, updated_at = ?, "
                    "version = version + ? WHERE layout_id = ?",
                    (
                        selected,
                        utc_now(),
                        int(
                            layout is not None
                            and (added or selected != layout["active_workspace_id"])
                        ),
                        layout_id,
                    ),
                )
            return self.read(principal, selected)

    def navigate(
        self, principal: Principal, action: OpenDocument | ActivateDocument | CloseDocument
    ) -> dict[str, JsonValue]:
        with self.lock:
            self._row(principal, action.workspace_id)
            layout = self._layout_row(principal, action.workspace_id)
            if layout["version"] != action.expected_layout_version:
                raise ConflictError(
                    "Open documents changed in another view. Refresh before changing tabs."
                )
            document = None
            if isinstance(action, OpenDocument):
                document = self.services.workspace_access.get_document(
                    principal, action.document_id
                )
                self.require_markdown(document)
            else:
                target = self._row(principal, action.target_workspace_id)
                if (
                    self._layout_row(principal, action.target_workspace_id)["layout_id"]
                    != layout["layout_id"]
                ):
                    raise ValidationError("Document belongs to a different workspace layout.")
                if isinstance(action, CloseDocument) and target["draft"] is not None:
                    raise ConflictError("Save or discard this document's draft before closing it.")
                if isinstance(action, ActivateDocument):
                    self.services.workspace_access.get_document(principal, target["document_id"])
            selected = action.workspace_id
            with self.database.transaction() as connection:
                if isinstance(action, OpenDocument):
                    assert document is not None
                    selected, _ = self._append_documents(
                        connection, principal, layout["layout_id"], [document]
                    )
                elif isinstance(action, ActivateDocument):
                    selected = action.target_workspace_id
                else:
                    view = self._layout_view(principal, layout, action.workspace_id)
                    remaining = [
                        tab for tab in view.tabs if tab.workspace_id != action.target_workspace_id
                    ]
                    if not remaining:
                        raise ValidationError("Keep at least one readable document open.")
                    if selected == action.target_workspace_id:
                        selected = remaining[0].workspace_id
                    active = layout["active_workspace_id"]
                    if active == action.target_workspace_id:
                        connection.execute(
                            "UPDATE mcp_layouts SET active_workspace_id = ? WHERE layout_id = ?",
                            (selected, layout["layout_id"]),
                        )
                    connection.execute(
                        "DELETE FROM mcp_workspaces WHERE workspace_id = ?",
                        (action.target_workspace_id,),
                    )
                connection.execute(
                    "UPDATE mcp_layouts SET active_workspace_id = ?, version = version + 1, "
                    "updated_at = ? WHERE layout_id = ?",
                    (selected, utc_now(), layout["layout_id"]),
                )
            return self.read(principal, selected)

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
                "layout": self._layout_view(
                    principal, self._layout_row(principal, workspace_id), workspace_id
                ).model_dump(mode="json"),
            }

    def change(
        self, principal: Principal, action: CheckpointDraft | DiscardDraft | SaveDraft
    ) -> dict[str, JsonValue]:
        saved_revision_id: str | None = None
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
                    saved = self.services.workspace_access.write_document(
                        principal,
                        document_id=document.document_id,
                        action="update",
                        body=UpdateDocument(
                            expected_revision_id=row["base_revision_id"], content=row["draft"]
                        ),
                        idempotency_key=action.operation_key,
                    )
                    saved_revision_id = saved.current_revision_id
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
            layout = self._layout_row(principal, action.workspace_id)
            with self.database.transaction() as connection:
                connection.execute(
                    "UPDATE mcp_layouts SET updated_at = ? WHERE layout_id = ?",
                    (utc_now(), layout["layout_id"]),
                )
            result = self.read(principal, action.workspace_id)
            if saved_revision_id is not None:
                result["saved_revision_id"] = saved_revision_id
            return result

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
            document = self.services.documents.get_document(
                dependency["document_id"], include_deleted=True
            )
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
        if authorize:
            self.authorize_dependencies(principal, key)
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT operation_key, document_id, outcome FROM mcp_execution_writes "
                "WHERE actor_id = ? AND execution_key = ?",
                (principal.actor_id, key),
            ).fetchall()
            result: list[JsonValue] = []
            for row in rows:
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
        status = "failed" if failed else "completed"
        if result.get("status") == "interrupted":
            status = "interrupted"
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE mcp_executions SET status = ?, result_json = ?, finished_at = ? "
                "WHERE actor_id = ? AND execution_key = ?",
                (
                    status,
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
                cached["writes"] = self.writes(principal, key, authorize=False)
            return cached
        if row["status"] == "running":
            reason = "in_progress"
            message = (
                "Execution is running. Write evidence is incomplete; "
                "inspect this key again. Do not replay."
            )
        elif row["status"] == "interrupted":
            reason = "interrupted"
            message = "Execution was interrupted. Inspect original write keys; do not replay."
        else:
            reason = "result_expired"
            message = "Result details expired. Original operation evidence is retained."
        return ExecutionReceipt.model_validate(
            {
                "execution_key": key,
                "status": row["status"],
                "reason": reason,
                "writes": self.writes(principal, key, authorize=False),
                "message": message,
            }
        ).model_dump(mode="json")

    def interrupt_previous_runs(self) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE mcp_executions SET status = 'interrupted', finished_at = ? "
                "WHERE status = 'running'",
                (utc_now(),),
            )
