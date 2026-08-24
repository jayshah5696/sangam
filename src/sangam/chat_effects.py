from __future__ import annotations

import json
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sangam.access import WorkspaceAccessService
from sangam.chat_capabilities import ChatCapability, ChatCapabilityRegistry
from sangam.db import Database, utc_now
from sangam.errors import (
    AuthorizationError,
    ConflictError,
    NotFoundError,
    SangamError,
    ValidationError,
)
from sangam.idempotency import request_hash
from sangam.schemas import ChatEffect
from sangam.security import Principal


@dataclass(frozen=True)
class EffectExecution:
    effect: ChatEffect
    client_result: dict[str, object]


class ChatEffectService:
    """Persists argument-bound approvals and executes them through workspace services."""

    def __init__(
        self,
        *,
        database: Database,
        workspace: WorkspaceAccessService,
        registry: ChatCapabilityRegistry,
        approval_ttl: timedelta = timedelta(minutes=30),
    ) -> None:
        self.database = database
        self.workspace = workspace
        self.registry = registry
        self.approval_ttl = approval_ttl

    def propose(
        self,
        principal: Principal,
        *,
        run_id: str,
        thread_id: str,
        tool_call_id: str,
        capability: ChatCapability,
        arguments: dict[str, object],
        preview: dict[str, object],
    ) -> ChatEffect:
        if capability.capability_id not in {"create_document", "publish_document"}:
            raise ValidationError("That chat capability does not use durable effects")
        normalized = capability.input_schema.model_validate(arguments).model_dump(mode="json")
        hidden_arguments = [
            key for key, value in normalized.items() if key not in preview or preview[key] != value
        ]
        if hidden_arguments:
            raise ValidationError(
                "The chat effect preview must include every material argument unchanged",
                details={"fields": hidden_arguments},
            )
        encoded = json.dumps(normalized, sort_keys=True, separators=(",", ":"))
        digest = request_hash(normalized)
        preview_json = json.dumps(preview, sort_keys=True, separators=(",", ":"))
        with self.database.transaction() as connection:
            existing = connection.execute(
                """
                SELECT effect_id FROM chat_effects
                WHERE requested_by = ? AND tool_call_id = ?
                  AND capability_id = ? AND argument_digest = ?
                """,
                (principal.actor_id, tool_call_id, capability.capability_id, digest),
            ).fetchone()
            if existing is not None:
                return self.get(principal, existing["effect_id"])
            effect_id = f"eff_{uuid.uuid4().hex}"
            now = datetime.now(UTC)
            expires = now + self.approval_ttl
            connection.execute(
                """
                INSERT INTO chat_effects(
                    effect_id, run_id, thread_id, tool_call_id, capability_id,
                    capability_version, requested_by, arguments_json, argument_digest,
                    preview_json, effect_class, risk, status, operation_key,
                    expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?)
                """,
                (
                    effect_id,
                    run_id,
                    thread_id,
                    tool_call_id,
                    capability.capability_id,
                    capability.version,
                    principal.actor_id,
                    encoded,
                    digest,
                    preview_json,
                    capability.effect_class.value,
                    "external" if capability.effect_class.value == "external" else "workspace",
                    f"chat-effect:{effect_id}",
                    expires.isoformat(timespec="microseconds"),
                    now.isoformat(timespec="microseconds"),
                ),
            )
        return self.get(principal, effect_id)

    def get(self, principal: Principal, effect_id: str) -> ChatEffect:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT e.*, t.created_by AS thread_owner
                FROM chat_effects e
                JOIN chat_threads t ON t.thread_id = e.thread_id
                WHERE e.effect_id = ?
                """,
                (effect_id,),
            ).fetchone()
        if row is None or (
            row["thread_owner"] != principal.actor_id and not principal.administrator
        ):
            raise NotFoundError(f"Chat effect not found: {effect_id}")
        return self._schema(row)

    def list(
        self,
        principal: Principal,
        *,
        thread_id: str | None = None,
        statuses: tuple[str, ...] = (),
    ) -> list[ChatEffect]:
        params: list[object] = [principal.actor_id]
        clauses = ["t.created_by = ?"]
        if principal.administrator:
            clauses = ["1 = 1"]
            params = []
        if thread_id:
            clauses.append("e.thread_id = ?")
            params.append(thread_id)
        if statuses:
            placeholders = ",".join("?" for _ in statuses)
            clauses.append(f"e.status IN ({placeholders})")
            params.extend(statuses)
        with self.database.connection() as connection:
            rows = connection.execute(
                f"""
                SELECT e.*, t.created_by AS thread_owner
                FROM chat_effects e JOIN chat_threads t ON t.thread_id = e.thread_id
                WHERE {" AND ".join(clauses)}
                ORDER BY e.created_at DESC, e.effect_id DESC
                LIMIT 100
                """,
                params,
            ).fetchall()
        return [self._schema(row) for row in rows]

    def decide(
        self,
        principal: Principal,
        *,
        effect_id: str,
        verdict: str,
        argument_digest: str,
        reason: str | None,
    ) -> EffectExecution:
        effect = self.get(principal, effect_id)
        if effect.requested_by != principal.actor_id:
            raise AuthorizationError("Only the principal that requested this effect can decide it")
        if effect.argument_digest != argument_digest:
            raise ConflictError("The approval digest does not match the stored effect request")
        if effect.status == "completed":
            return EffectExecution(effect=effect, client_result=effect.result or {})
        if effect.status in {"denied", "expired", "cancelled"}:
            raise ConflictError(f"The chat effect is already {effect.status}")
        if datetime.fromisoformat(effect.expires_at) <= datetime.now(UTC):
            with self.database.transaction() as connection:
                connection.execute(
                    """
                    UPDATE chat_effects SET status = 'expired', completed_at = ?
                    WHERE effect_id = ?
                    """,
                    (utc_now(), effect_id),
                )
            raise ConflictError("The chat effect approval request expired")
        if verdict not in {"approve", "deny"}:
            raise ValidationError("Unsupported chat effect decision")
        now = utc_now()
        denied = False
        with self.database.transaction() as connection:
            if effect.status not in {"executing", "failed"}:
                connection.execute(
                    """
                    INSERT INTO chat_effect_decisions(
                        decision_id, effect_id, decided_by, argument_digest,
                        verdict, reason, decided_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"dec_{uuid.uuid4().hex}",
                        effect_id,
                        principal.actor_id,
                        argument_digest,
                        verdict,
                        reason,
                        now,
                    ),
                )
            if verdict == "deny":
                if effect.status not in {"pending_approval", "proposed"}:
                    raise ConflictError("Only a pending chat effect can be denied")
                connection.execute(
                    """
                    UPDATE chat_effects
                    SET status = 'denied', decided_at = ?, completed_at = ?
                    WHERE effect_id = ?
                    """,
                    (now, now, effect_id),
                )
                denied = True
            else:
                if effect.status == "failed" and not bool((effect.failure or {}).get("retry_safe")):
                    raise ConflictError("This failed effect requires a new request and approval")
                connection.execute(
                    """
                    UPDATE chat_effects
                    SET status = CASE WHEN status = 'executing' THEN status ELSE 'approved' END,
                        decided_at = COALESCE(decided_at, ?)
                    WHERE effect_id = ?
                    """,
                    (now, effect_id),
                )
        if denied:
            denied_effect = self.get(principal, effect_id)
            return EffectExecution(
                effect=denied_effect,
                client_result={"approved": False, "status": "denied"},
            )
        return self._execute(principal, effect_id)

    def _execute(self, principal: Principal, effect_id: str) -> EffectExecution:
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM chat_effects WHERE effect_id = ?", (effect_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"Chat effect not found: {effect_id}")
            if row["status"] == "completed":
                effect = self.get(principal, effect_id)
                return EffectExecution(effect=effect, client_result=effect.result or {})
            if row["status"] not in {"approved", "executing", "failed"}:
                raise ConflictError("The chat effect is not approved for execution")
            connection.execute(
                """
                UPDATE chat_effects
                SET status = 'executing', started_at = COALESCE(started_at, ?), failure_json = NULL
                WHERE effect_id = ?
                """,
                (utc_now(), effect_id),
            )
            arguments = json.loads(row["arguments_json"])
            operation_key = row["operation_key"]
            capability_id = row["capability_id"]
        operation_recorded = self._operation_was_recorded(
            actor_id=principal.actor_id,
            operation_key=operation_key,
            capability_id=capability_id,
        )
        try:
            if capability_id == "create_document":
                document = self.workspace.create_document(
                    principal,
                    title=arguments["title"],
                    content=arguments["content"],
                    path=None,
                    content_type=arguments["content_type"],
                    idempotency_key=operation_key,
                )
                client_result: dict[str, object] = {
                    **document.model_dump(mode="json"),
                    "approved": True,
                    "status": "created",
                }
                stored_result = dict(client_result)
                resource_type = "document"
                resource_id = document.document_id
            elif capability_id == "publish_document":
                document = self.workspace.get_document(principal, arguments["document_id"])
                if (
                    not operation_recorded
                    and document.current_revision_id != arguments["revision_id"]
                ):
                    raise ConflictError(
                        "The document changed after publication approval",
                        details={"current_revision_id": document.current_revision_id},
                    )
                publication = self.workspace.create_publication(
                    principal,
                    document_id=arguments["document_id"],
                    slug=arguments["slug"],
                    access_policy=arguments["access_policy"],
                    idempotency_key=operation_key,
                )
                client_result = {
                    **publication.model_dump(mode="json"),
                    "approved": True,
                    "status": "published",
                }
                if publication.token:
                    client_result["token"] = publication.token
                stored_result = {
                    key: value for key, value in client_result.items() if key != "token"
                }
                resource_type = "publication"
                resource_id = publication.publication_id
            else:
                raise ValidationError("Unsupported durable chat effect capability")
        except SangamError as error:
            retry_safe = not isinstance(error, (AuthorizationError, ConflictError, ValidationError))
            failure = {
                "code": error.code,
                "message": error.message,
                "retry_safe": retry_safe,
            }
            with self.database.transaction() as connection:
                connection.execute(
                    """
                    UPDATE chat_effects SET status = 'failed', failure_json = ?, completed_at = ?
                    WHERE effect_id = ?
                    """,
                    (json.dumps(failure, separators=(",", ":")), utc_now(), effect_id),
                )
            raise
        self._complete(
            effect_id,
            resource_type=resource_type,
            resource_id=resource_id,
            result=stored_result,
        )
        effect = self.get(principal, effect_id)
        return EffectExecution(effect=effect, client_result=client_result)

    def _operation_was_recorded(
        self, *, actor_id: str, operation_key: str, capability_id: str
    ) -> bool:
        with self.database.connection() as connection:
            if capability_id == "create_document":
                row = connection.execute(
                    """
                    SELECT 1 FROM idempotency_keys
                    WHERE actor_id = ? AND idempotency_key = ? AND operation = 'create'
                    """,
                    (actor_id, operation_key),
                ).fetchone()
            elif capability_id == "publish_document":
                row = connection.execute(
                    """
                    SELECT 1 FROM mutation_idempotency_keys
                    WHERE actor_id = ? AND idempotency_key = ?
                      AND operation = 'publish' AND completed_at IS NOT NULL
                    """,
                    (actor_id, operation_key),
                ).fetchone()
            else:
                row = None
        return row is not None

    def _complete(
        self,
        effect_id: str,
        *,
        resource_type: str,
        resource_id: str,
        result: dict[str, object],
    ) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE chat_effects
                SET status = 'completed', resource_type = ?, resource_id = ?,
                    result_json = ?, failure_json = NULL, completed_at = ?
                WHERE effect_id = ?
                """,
                (
                    resource_type,
                    resource_id,
                    json.dumps(result, sort_keys=True, separators=(",", ":")),
                    utc_now(),
                    effect_id,
                ),
            )

    @staticmethod
    def _schema(row: sqlite3.Row) -> ChatEffect:
        return ChatEffect(
            effect_id=row["effect_id"],
            thread_id=row["thread_id"],
            requested_by=row["requested_by"],
            capability_id=row["capability_id"],
            capability_version=row["capability_version"],
            argument_digest=row["argument_digest"],
            preview=json.loads(row["preview_json"]),
            effect_class=row["effect_class"],
            risk=row["risk"],
            status=row["status"],
            expires_at=row["expires_at"],
            resource_type=row["resource_type"],
            resource_id=row["resource_id"],
            result=json.loads(row["result_json"]) if row["result_json"] else None,
            failure=json.loads(row["failure_json"]) if row["failure_json"] else None,
            created_at=row["created_at"],
            decided_at=row["decided_at"],
            completed_at=row["completed_at"],
        )
