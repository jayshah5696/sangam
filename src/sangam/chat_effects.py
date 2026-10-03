from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime, timedelta
from typing import Literal

from sangam.access import WorkspaceAccessService
from sangam.authorization import AuthorizationPolicy
from sangam.capabilities import Capability
from sangam.chat_capabilities import (
    AddProjectDocumentChange,
    AnnotatePdfInput,
    ChatCapability,
    ChatCapabilityRegistry,
    CreateAnnotationChange,
    CreateDocumentInput,
    CreateProjectChange,
    ProjectAnnotationChange,
    ProjectThreadChange,
    PublishDocumentInput,
    RemoveProjectDocumentChange,
    UnpublishChange,
    UpdateAnnotationChange,
    UpdateProjectDetailsChange,
    UpdateProjectInput,
    UpdateProjectMemberChange,
    UpdatePublicationInput,
)
from sangam.db import Database, utc_now
from sangam.errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    CredentialConflictError,
    IdempotencyError,
    IntegrationError,
    InvalidPathError,
    MaterializationError,
    NotFoundError,
    SangamError,
    ValidationError,
    validate_metadata_text,
)
from sangam.idempotency import request_hash
from sangam.projects import ProjectService
from sangam.schemas import (
    AddProjectAnnotation,
    AddProjectDocument,
    AddProjectThread,
    ApplyOrganizationPlan,
    ChatEffect,
    ChatEffectsAcknowledgementResult,
    ChatEffectsSummary,
    CreateProject,
    UpdateProject,
    UpdateProjectDocument,
)
from sangam.security import IdentityService, Principal


def classify_effect_retry_safety(error: Exception) -> bool:
    """Determine whether the exact same request can succeed without human intervention
    or workspace changes.
    """
    if isinstance(
        error,
        (
            InvalidPathError,
            ValidationError,
            NotFoundError,
            ConflictError,
            CredentialConflictError,
            IdempotencyError,
            AuthenticationError,
            AuthorizationError,
            MaterializationError,
        ),
    ):
        return False
    return isinstance(error, IntegrationError)


def build_effect_failure_record(error: Exception) -> dict[str, object]:
    """Produce a safe, bounded failure record stored with the durable effect."""
    if isinstance(error, SangamError):
        code = error.code
        message = error.message
    else:
        code = "execution_failed"
        message = "The effect could not be completed."
    return {
        "code": code,
        "message": message[:500],
        "retry_safe": classify_effect_retry_safety(error),
    }


@dataclass(frozen=True)
class EffectExecution:
    effect: ChatEffect
    client_result: dict[str, object]


@dataclass(frozen=True)
class EffectOutcome:
    """What an executed effect returns to the client, stores, and points at."""

    client_result: dict[str, object]
    stored_result: dict[str, object]
    resource_type: str
    resource_id: str


@dataclass(frozen=True)
class DurableEffect:
    """How one durable capability is checked before approval and run after it.

    ``execute`` receives the effect ID, its stable operation key, and whether that
    key already committed, so a retried execution replays instead of re-checking
    preconditions that its own first attempt changed.
    """

    preflight: Callable[[Principal, dict[str, object]], None]
    execute: Callable[[Principal, dict[str, object], str, str, bool], EffectOutcome]
    committed: Callable[[str, str], bool]


class ChatEffectService:
    """Persists argument-bound approvals and executes them through workspace services."""

    def __init__(
        self,
        *,
        database: Database,
        workspace: WorkspaceAccessService,
        identity: IdentityService,
        projects: ProjectService,
        registry: ChatCapabilityRegistry,
        approval_ttl: timedelta = timedelta(minutes=30),
    ) -> None:
        self.database = database
        self.workspace = workspace
        self.identity = identity
        self.projects = projects
        self.registry = registry
        self.approval_ttl = approval_ttl
        idempotency = workspace.documents.idempotency
        self.durable: dict[str, DurableEffect] = {
            "create_document": DurableEffect(
                preflight=self._preflight_create,
                execute=self._execute_create,
                committed=lambda actor, key: idempotency.committed(
                    actor_id=actor, key=key, operation="create"
                ),
            ),
            "publish_document": DurableEffect(
                preflight=self._preflight_publish,
                execute=self._execute_publish,
                committed=lambda actor, key: idempotency.committed(
                    actor_id=actor, key=key, operation="publish"
                ),
            ),
            "annotate_pdf": DurableEffect(
                preflight=self._preflight_annotation,
                execute=self._execute_annotation,
                committed=lambda actor, key: idempotency.committed(actor_id=actor, key=key),
            ),
            "update_publication": DurableEffect(
                preflight=self._preflight_publication,
                execute=self._execute_publication,
                committed=lambda actor, key: idempotency.committed(actor_id=actor, key=key),
            ),
            "update_project": DurableEffect(
                preflight=self._preflight_project,
                execute=self._execute_project,
                committed=lambda actor, key: idempotency.committed(actor_id=actor, key=key),
            ),
            "apply_workspace_organization_plan": DurableEffect(
                preflight=lambda principal, arguments: workspace.preflight_organization_plan(
                    principal, plan=ApplyOrganizationPlan.model_validate(arguments)
                ),
                execute=self._execute_plan,
                committed=lambda actor, key: workspace.organization_plan_started(
                    actor_id=actor, idempotency_key=key
                ),
            ),
        }

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
        principal = self.identity.reauthorize(principal)
        durable = self.durable.get(capability.capability_id)
        if durable is None:
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
        durable.preflight(principal, normalized)

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
                    capability_version, requested_by, requested_token_id, arguments_json,
                    argument_digest, preview_json, effect_class, risk, status, operation_key,
                    expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval', ?, ?, ?)
                """,
                (
                    effect_id,
                    run_id,
                    thread_id,
                    tool_call_id,
                    capability.capability_id,
                    capability.version,
                    principal.actor_id,
                    principal.token_id,
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
        effect = self.get(principal, effect_id)
        if self._autonomy_allows():
            # The operator approved every authorized effect in advance; the requester's own
            # authority still bounds what runs.
            return self._decide(
                principal,
                effect_id=effect.effect_id,
                verdict="approve",
                argument_digest=effect.argument_digest,
                reason="YOLO autonomy mode",
                approved_by="policy:yolo",
            ).effect
        return effect

    def cancel_pending(self, run_id: str) -> None:
        """Cancel the effects of a cancelled run that have not started executing."""
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE chat_effects
                SET status = 'cancelled', completed_at = ?
                WHERE run_id = ? AND status IN ('proposed', 'pending_approval', 'approved')
                """,
                (utc_now(), run_id),
            )

    def _autonomy_allows(self) -> bool:
        """Run every authorized effect immediately when the operator enables YOLO."""
        with self.database.connection() as connection:
            settings = connection.execute(
                "SELECT autonomy_mode FROM chat_model_settings WHERE id = 1"
            ).fetchone()
        return settings is not None and settings["autonomy_mode"] == "workspace"

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
            row["thread_owner"] != principal.actor_id
            and row["requested_by"] != principal.actor_id
            and not principal.administrator
        ):
            raise NotFoundError(f"Chat effect not found: {effect_id}")
        return self._schema(row)

    def list(
        self,
        principal: Principal,
        *,
        thread_id: str | None = None,
        statuses: tuple[str, ...] = (),
        view: Literal["attention", "history"] | None = None,
        limit: int = 100,
        cursor: str | None = None,
    ) -> list[ChatEffect]:
        limit = max(1, min(limit, 100))
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
        if view == "attention":
            clauses.append(
                "(e.status IN ('pending_approval', 'approved', 'executing') "
                "OR (e.status = 'failed' AND e.acknowledged_at IS NULL))"
            )
        elif view == "history":
            clauses.append(
                "(e.acknowledged_at IS NOT NULL "
                "OR e.status IN ('completed', 'denied', 'expired', 'cancelled'))"
            )

        with self.database.connection() as connection:
            if cursor:
                cursor_row = connection.execute(
                    "SELECT created_at, effect_id FROM chat_effects WHERE effect_id = ?",
                    (cursor,),
                ).fetchone()
                if cursor_row:
                    clauses.append("(e.created_at, e.effect_id) < (?, ?)")
                    params.extend([cursor_row["created_at"], cursor_row["effect_id"]])

            rows = connection.execute(
                f"""
                SELECT e.*, t.created_by AS thread_owner
                FROM chat_effects e JOIN chat_threads t ON t.thread_id = e.thread_id
                WHERE {" AND ".join(clauses)}
                ORDER BY e.created_at DESC, e.effect_id DESC
                LIMIT ?
                """,
                [*params, limit],
            ).fetchall()
        return [self._schema(row) for row in rows]

    def summary(self, principal: Principal, thread_id: str) -> ChatEffectsSummary:
        owner_clause = "t.created_by = ?"
        params = [thread_id, principal.actor_id]
        if principal.administrator:
            owner_clause = "1 = 1"
            params = [thread_id]

        with self.database.connection() as connection:
            thread_row = connection.execute(
                f"SELECT 1 FROM chat_threads t WHERE t.thread_id = ? AND {owner_clause}",
                params,
            ).fetchone()
            if thread_row is None:
                raise NotFoundError(f"Chat thread not found: {thread_id}")

            row = connection.execute(
                f"""
                SELECT
                    COUNT(
                        CASE WHEN e.status IN ('pending_approval', 'approved', 'executing')
                                  OR (e.status = 'failed' AND e.acknowledged_at IS NULL)
                             THEN 1 END
                    ) AS total_attention,
                    COUNT(
                        CASE WHEN e.status IN ('approved', 'executing')
                             THEN 1 END
                    ) AS recovering_active,
                    COUNT(
                        CASE WHEN e.status = 'failed' AND e.acknowledged_at IS NULL
                                  AND json_extract(e.failure_json, '$.retry_safe') = 1
                             THEN 1 END
                    ) AS retryable_failures,
                    COUNT(
                        CASE WHEN e.status = 'failed' AND e.acknowledged_at IS NULL
                                  AND (json_extract(e.failure_json, '$.retry_safe') IS NULL
                                       OR json_extract(e.failure_json, '$.retry_safe') != 1)
                             THEN 1 END
                    ) AS terminal_failures,
                    COUNT(
                        CASE WHEN e.acknowledged_at IS NOT NULL
                                  OR e.status IN ('completed', 'denied', 'expired', 'cancelled')
                             THEN 1 END
                    ) AS total_history
                FROM chat_effects e
                JOIN chat_threads t ON t.thread_id = e.thread_id
                WHERE e.thread_id = ? AND {owner_clause}
                """,
                params,
            ).fetchone()

        return ChatEffectsSummary(
            thread_id=thread_id,
            total_attention=row["total_attention"] if row else 0,
            recovering_active=row["recovering_active"] if row else 0,
            retryable_failures=row["retryable_failures"] if row else 0,
            terminal_failures=row["terminal_failures"] if row else 0,
            total_history=row["total_history"] if row else 0,
        )

    def acknowledge(
        self, principal: Principal, effect_ids: list[str]
    ) -> ChatEffectsAcknowledgementResult:
        if not effect_ids:
            raise ValidationError("At least one effect ID must be provided")
        if len(effect_ids) > 100:
            raise ValidationError("At most 100 effect IDs can be acknowledged at once")
        if len(set(effect_ids)) != len(effect_ids):
            raise ValidationError("Effect IDs must be unique")

        now = utc_now()
        with self.database.transaction() as connection:
            placeholders = ",".join("?" for _ in effect_ids)
            rows = connection.execute(
                f"""
                SELECT e.effect_id, e.requested_by, e.status, t.created_by AS thread_owner
                FROM chat_effects e
                JOIN chat_threads t ON t.thread_id = e.thread_id
                WHERE e.effect_id IN ({placeholders})
                """,
                effect_ids,
            ).fetchall()

            found_map = {row["effect_id"]: row for row in rows}
            missing = [eid for eid in effect_ids if eid not in found_map]
            if missing:
                raise NotFoundError(f"Chat effect not found: {missing[0]}")

            for eid in effect_ids:
                row = found_map[eid]
                if (
                    row["thread_owner"] != principal.actor_id
                    and row["requested_by"] != principal.actor_id
                    and not principal.administrator
                ):
                    raise AuthorizationError(
                        f"Only the thread owner or administrator can acknowledge this effect: {eid}"
                    )
                if row["status"] in {"pending_approval", "approved", "executing"}:
                    raise ConflictError(f"Active effects cannot be acknowledged: {eid}")

            connection.execute(
                f"""
                UPDATE chat_effects
                SET acknowledged_at = ?, acknowledged_by = ?
                WHERE effect_id IN ({placeholders})
                """,
                [now, principal.actor_id, *effect_ids],
            )

        updated_effects = [self.get(principal, eid) for eid in effect_ids]
        return ChatEffectsAcknowledgementResult(
            acknowledged_ids=effect_ids,
            acknowledged_at=now,
            effects=updated_effects,
        )

    def decide(
        self,
        principal: Principal,
        *,
        effect_id: str,
        verdict: str,
        argument_digest: str,
        reason: str | None,
    ) -> EffectExecution:
        """Record a person's decision. Only an administrator may approve.

        An agent that requested an effect could otherwise approve its own request.
        Anyone who can see the effect may deny it.
        """
        principal = self.identity.reauthorize(principal)
        if verdict == "approve" and not principal.administrator:
            raise AuthorizationError("Only an administrator can approve a chat effect")
        return self._decide(
            principal,
            effect_id=effect_id,
            verdict=verdict,
            argument_digest=argument_digest,
            reason=reason,
            approved_by=principal.actor_id,
        )

    def _decide(
        self,
        principal: Principal,
        *,
        effect_id: str,
        verdict: str,
        argument_digest: str,
        reason: str | None,
        approved_by: str,
    ) -> EffectExecution:
        validate_metadata_text(reason, "Decision reason")
        effect = self.get(principal, effect_id)
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
                        decided_at = COALESCE(decided_at, ?),
                        acknowledged_at = NULL,
                        acknowledged_by = NULL
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
        return self._execute(principal, effect_id, approved_by)

    def _requester_principal(self, approver: Principal, requested_by: str, token_id: str | None):
        """The requester's own authority, read fresh, for an effect someone else approved."""
        if requested_by == approver.actor_id:
            return approver
        if token_id is not None:
            return self.identity.reauthorize(
                Principal(
                    actor_id=requested_by,
                    display_name=requested_by,
                    identity_kind="agent",
                    operation_id=approver.operation_id,
                    token_id=token_id,
                )
            )
        with self.database.connection() as connection:
            actor = connection.execute(
                "SELECT display_name, identity_kind FROM actors WHERE actor_id = ?",
                (requested_by,),
            ).fetchone()
        if actor is None or actor["identity_kind"] != "human":
            raise AuthorizationError("The requester can no longer be authorized")
        return Principal.trusted_human(
            actor_id=requested_by,
            display_name=actor["display_name"],
            operation_id=approver.operation_id,
        )

    def _execute(self, principal: Principal, effect_id: str, approved_by: str) -> EffectExecution:
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
                SET status = 'executing', started_at = COALESCE(started_at, ?), failure_json = NULL,
                    acknowledged_at = NULL, acknowledged_by = NULL
                WHERE effect_id = ?
                """,
                (utc_now(), effect_id),
            )
            arguments = json.loads(row["arguments_json"])
            operation_key = row["operation_key"]
            capability_id = row["capability_id"]
            requested_by = row["requested_by"]
            requested_token_id = row["requested_token_id"]
        durable = self.durable.get(capability_id)
        try:
            if durable is None:
                raise ValidationError("Unsupported durable chat effect capability")
            executor = replace(
                self._requester_principal(principal, requested_by, requested_token_id),
                via=f"chat-effect:{effect_id}",
                approved_by=approved_by,
            )
            outcome = durable.execute(
                executor,
                arguments,
                effect_id,
                operation_key,
                durable.committed(executor.actor_id, operation_key),
            )
        except Exception as error:
            failure = build_effect_failure_record(error)
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
            resource_type=outcome.resource_type,
            resource_id=outcome.resource_id,
            result=outcome.stored_result,
        )
        effect = self.get(principal, effect_id)
        return EffectExecution(effect=effect, client_result=outcome.client_result)

    def _preflight_create(self, principal: Principal, arguments: dict[str, object]) -> None:
        self.workspace.preflight_create_document(
            principal,
            title=str(arguments.get("title", "")),
            content=str(arguments.get("content", "")),
            content_type=str(arguments.get("content_type", "text/markdown")),
            path=str(arguments["path"]) if arguments.get("path") else None,
        )

    def _execute_create(
        self,
        principal: Principal,
        arguments: dict[str, object],
        effect_id: str,
        operation_key: str,
        recorded: bool,
    ) -> EffectOutcome:
        del effect_id, recorded
        validated = CreateDocumentInput.model_validate(arguments)
        document = self.workspace.create_document(
            principal,
            title=validated.title,
            content=validated.content,
            path=validated.path,
            content_type=validated.content_type,
            idempotency_key=operation_key,
        )
        result: dict[str, object] = {
            **document.model_dump(mode="json"),
            "approved": True,
            "status": "created",
        }
        return EffectOutcome(result, dict(result), "document", document.document_id)

    def _preflight_publish(self, principal: Principal, arguments: dict[str, object]) -> None:
        self.workspace.preflight_publish_document(
            principal,
            document_id=str(arguments.get("document_id", "")),
            revision_id=str(arguments.get("revision_id", "")),
            slug=str(arguments.get("slug", "")),
            access_policy=str(arguments.get("access_policy", "")),
        )

    def _execute_publish(
        self,
        principal: Principal,
        arguments: dict[str, object],
        effect_id: str,
        operation_key: str,
        recorded: bool,
    ) -> EffectOutcome:
        del effect_id
        validated = PublishDocumentInput.model_validate(arguments)
        document = self.workspace.get_document(principal, validated.document_id)
        if not recorded and document.current_revision_id != validated.revision_id:
            raise ConflictError(
                "The document changed after publication approval",
                details={"current_revision_id": document.current_revision_id},
            )
        publication = self.workspace.create_publication(
            principal,
            document_id=validated.document_id,
            slug=validated.slug,
            access_policy=validated.access_policy,
            idempotency_key=operation_key,
            revision_id=validated.revision_id,
        )
        result: dict[str, object] = {
            **publication.model_dump(mode="json"),
            "approved": True,
            "status": "published",
        }
        if publication.token:
            result["token"] = publication.token
        # The capability token is shown once to the approving client and never stored.
        stored = {key: value for key, value in result.items() if key != "token"}
        return EffectOutcome(result, stored, "publication", publication.publication_id)

    def _preflight_annotation(self, principal: Principal, arguments: dict[str, object]) -> None:
        change = AnnotatePdfInput.model_validate(arguments).change
        if isinstance(change, CreateAnnotationChange):
            document = self.workspace.get_document(principal, change.document_id)
            if document.content_type != "application/pdf":
                raise ValidationError("Annotations can only be added to PDF documents")
            self.workspace.policy.require(principal, Capability.UPDATE, document.path)
            if change.annotation_type in {"comment", "page_note"} and not (
                change.note and change.note.strip()
            ):
                raise ValidationError("Notes and comments require text")
            validate_metadata_text(change.note, "Note")
            return
        annotation = self.workspace.pdf_research.get_annotation(change.annotation_id)
        document = self.workspace.get_document(principal, annotation.document_id)
        self.workspace.policy.require(principal, Capability.UPDATE, document.path)
        if annotation.version != change.expected_version:
            raise ConflictError(
                "The annotation changed since it was read",
                details={"current_version": annotation.version},
            )

    def _execute_annotation(
        self,
        principal: Principal,
        arguments: dict[str, object],
        effect_id: str,
        operation_key: str,
        recorded: bool,
    ) -> EffectOutcome:
        del effect_id, recorded
        change = AnnotatePdfInput.model_validate(arguments).change
        workspace = self.workspace
        if isinstance(change, CreateAnnotationChange):
            annotation = workspace.create_annotation(
                principal,
                document_id=change.document_id,
                page_number=change.page_number,
                annotation_type=change.annotation_type,
                selected_text=None,
                note=change.note,
                geometry=[],
                tags=change.tags,
                color=change.color,
                idempotency_key=operation_key,
            )
            status = "created"
        elif isinstance(change, UpdateAnnotationChange):
            current = workspace.pdf_research.get_annotation(change.annotation_id)
            annotation = workspace.update_annotation(
                principal,
                annotation_id=change.annotation_id,
                expected_version=change.expected_version,
                selected_text=current.selected_text,
                note=current.note if change.note is None else change.note,
                geometry=current.geometry,
                tags=current.tags if change.tags is None else change.tags,
                color=change.color or current.color,
                idempotency_key=operation_key,
            )
            status = "updated"
        else:
            annotation = workspace.delete_annotation(
                principal,
                annotation_id=change.annotation_id,
                expected_version=change.expected_version,
                idempotency_key=operation_key,
            )
            status = "deleted"
        result: dict[str, object] = {
            "approved": True,
            "status": status,
            "annotation_id": annotation.annotation_id,
            "document_id": annotation.document_id,
            "page_number": annotation.page_number,
        }
        return EffectOutcome(result, dict(result), "annotation", annotation.annotation_id)

    def _preflight_publication(self, principal: Principal, arguments: dict[str, object]) -> None:
        change = UpdatePublicationInput.model_validate(arguments).change
        self.workspace.preflight_update_publication(
            principal,
            publication_id=change.publication_id,
            expected_version=change.expected_version,
        )

    def _execute_publication(
        self,
        principal: Principal,
        arguments: dict[str, object],
        effect_id: str,
        operation_key: str,
        recorded: bool,
    ) -> EffectOutcome:
        del effect_id, recorded
        change = UpdatePublicationInput.model_validate(arguments).change
        if isinstance(change, UnpublishChange):
            publication = self.workspace.unpublish(
                principal,
                publication_id=change.publication_id,
                expected_version=change.expected_version,
                idempotency_key=operation_key,
            )
            status = "unpublished"
            token = None
        else:
            current = self.workspace.publications.get_publication(change.publication_id)
            issued = self.workspace.update_publication(
                principal,
                publication_id=change.publication_id,
                expected_version=change.expected_version,
                slug=change.slug or current.slug,
                access_policy=change.access_policy or current.access_policy,
                idempotency_key=operation_key,
                revision_id=change.revision_id,
            )
            publication, status, token = issued, "updated", issued.token
        result: dict[str, object] = {
            **publication.model_dump(mode="json"),
            "approved": True,
            "status": status,
        }
        if token:
            result["token"] = token
        # An unlisted token is shown once to the approving client and never stored.
        stored = {key: value for key, value in result.items() if key != "token"}
        return EffectOutcome(result, stored, "publication", publication.publication_id)

    def _preflight_project(self, principal: Principal, arguments: dict[str, object]) -> None:
        AuthorizationPolicy.require_administrator(principal)
        change = UpdateProjectInput.model_validate(arguments).change
        if isinstance(change, CreateProjectChange):
            validate_metadata_text(change.name, "Project name")
            validate_metadata_text(change.description, "Project description")
            return
        # Opening the project and reading what it points at fail now, not after approval.
        project = self.projects.get_project(change.project_id, principal)
        if isinstance(change, AddProjectDocumentChange):
            self.workspace.get_document(principal, change.document_id)
            validate_metadata_text(change.notes, "Document notes")
        elif isinstance(change, UpdateProjectDetailsChange):
            if change.expected_version is not None and project.version != change.expected_version:
                raise ConflictError(
                    "The project changed since it was read",
                    details={"current_version": project.version},
                )
            if change.brief_document_id:
                self.workspace.get_document(principal, change.brief_document_id)
        elif isinstance(change, UpdateProjectMemberChange):
            if not any(member.document_id == change.document_id for member in project.documents):
                raise NotFoundError("Document is not a project member")
            validate_metadata_text(change.notes, "Document notes")
        elif isinstance(change, ProjectThreadChange) and change.kind == "add_thread":
            if not any(
                item.thread_id == change.thread_id
                for item in self.projects.available_threads(principal)
            ):
                raise NotFoundError(f"Chat thread not found: {change.thread_id}")
        elif isinstance(change, ProjectAnnotationChange) and change.kind == "add_annotation":
            annotation = self.workspace.pdf_research.get_annotation(change.annotation_id)
            self.workspace.get_document(principal, annotation.document_id)

    def _execute_project(
        self,
        principal: Principal,
        arguments: dict[str, object],
        effect_id: str,
        operation_key: str,
        recorded: bool,
    ) -> EffectOutcome:
        del effect_id, recorded
        change = UpdateProjectInput.model_validate(arguments).change
        projects = self.projects
        detail: dict[str, object] = {}
        if isinstance(change, CreateProjectChange):
            project = projects.create_project_once(
                principal,
                operation_key,
                CreateProject(
                    name=change.name,
                    description=change.description,
                    create_brief=change.create_brief,
                ),
            )
            status, project_id = "created", project.project_id
            detail = {"name": project.name}
        elif isinstance(change, AddProjectDocumentChange):
            member = projects.add_document_once(
                principal,
                operation_key,
                change.project_id,
                AddProjectDocument(
                    document_id=change.document_id,
                    role=change.role,
                    pinned_page=change.pinned_page,
                    notes=change.notes,
                ),
            )
            status, project_id = "added", member.project_id
            detail = {"document_id": member.document_id}
        elif isinstance(change, RemoveProjectDocumentChange):
            projects.remove_document_once(
                principal, operation_key, change.project_id, change.document_id
            )
            status, project_id = "removed", change.project_id
            detail = {"document_id": change.document_id}
        elif isinstance(change, UpdateProjectDetailsChange):
            fields = change.model_dump(exclude_none=True, exclude={"kind", "project_id"})
            projects.update_project_once(
                principal,
                operation_key,
                change.project_id,
                UpdateProject.model_validate(fields),
            )
            status, project_id = "updated", change.project_id
        elif isinstance(change, UpdateProjectMemberChange):
            fields = change.model_dump(
                exclude_none=True, exclude={"kind", "project_id", "document_id"}
            )
            projects.update_document_once(
                principal,
                operation_key,
                change.project_id,
                change.document_id,
                UpdateProjectDocument.model_validate(fields),
            )
            status, project_id = "updated", change.project_id
            detail = {"document_id": change.document_id}
        elif isinstance(change, ProjectThreadChange):
            if change.kind == "add_thread":
                projects.add_thread_once(
                    principal,
                    operation_key,
                    change.project_id,
                    AddProjectThread(thread_id=change.thread_id),
                )
                status = "added"
            else:
                projects.remove_thread_once(
                    principal, operation_key, change.project_id, change.thread_id
                )
                status = "removed"
            project_id = change.project_id
            detail = {"thread_id": change.thread_id}
        else:
            if change.kind == "add_annotation":
                projects.add_annotation_once(
                    principal,
                    operation_key,
                    change.project_id,
                    AddProjectAnnotation(annotation_id=change.annotation_id),
                )
                status = "added"
            else:
                projects.remove_annotation_once(
                    principal, operation_key, change.project_id, change.annotation_id
                )
                status = "removed"
            project_id = change.project_id
            detail = {"annotation_id": change.annotation_id}
        result: dict[str, object] = {
            "approved": True,
            "status": status,
            "project_id": project_id,
            **detail,
        }
        return EffectOutcome(result, dict(result), "project", project_id)

    def _execute_plan(
        self,
        principal: Principal,
        arguments: dict[str, object],
        effect_id: str,
        operation_key: str,
        recorded: bool,
    ) -> EffectOutcome:
        del recorded
        plan_result = self.workspace.apply_workspace_organization_plan(
            principal,
            plan=ApplyOrganizationPlan.model_validate(arguments),
            idempotency_key=operation_key,
        )
        if plan_result.status != "completed":
            raise ConflictError(
                "The organization plan stopped before every operation completed",
                details=plan_result.model_dump(mode="json"),
            )
        result: dict[str, object] = {**plan_result.model_dump(mode="json"), "approved": True}
        return EffectOutcome(result, dict(result), "organization_plan", effect_id)

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
        keys = row.keys()
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
            acknowledged_at=row["acknowledged_at"] if "acknowledged_at" in keys else None,
            acknowledged_by=row["acknowledged_by"] if "acknowledged_by" in keys else None,
        )
