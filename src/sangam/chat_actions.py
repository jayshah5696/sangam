from __future__ import annotations

import hashlib
from typing import Any

from sangam.db import Database
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
)
from sangam.idempotency import request_hash
from sangam.security import Principal


def validate_action_ownership(
    principal: Principal,
    thread_owner: str,
    requested_by: str | None = None,
) -> None:
    """Ensure the principal is the thread owner, requester, or administrator."""
    if principal.administrator:
        return
    if principal.actor_id == thread_owner:
        return
    if requested_by is not None and principal.actor_id == requested_by:
        return
    raise NotFoundError("Reviewed action not found or unauthorized")


class ActionDigest:
    """Unified digest computation and tamper-verification for chat actions."""

    @staticmethod
    def compute(payload: str | dict[str, Any] | list[Any]) -> str:
        if isinstance(payload, str):
            return hashlib.sha256(payload.encode("utf-8")).hexdigest()
        if isinstance(payload, (dict, list)):
            return request_hash(payload)
        return hashlib.sha256(str(payload).encode("utf-8")).hexdigest()

    @staticmethod
    def verify(
        stored_digest: str | None,
        incoming_digest: str,
        message: str = "The approval digest does not match the stored request",
    ) -> None:
        if stored_digest is not None and stored_digest != incoming_digest:
            raise ConflictError(message)


def check_autonomy_allows(database: Database) -> bool:
    """Run authorized actions immediately when the operator enables YOLO autonomy mode."""
    with database.connection() as connection:
        settings = connection.execute(
            "SELECT autonomy_mode FROM chat_model_settings WHERE id = 1"
        ).fetchone()
    return settings is not None and settings["autonomy_mode"] == "workspace"


def classify_retry_safety(error: Exception) -> bool:
    """Determine whether the exact same action request can succeed without human intervention."""
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


def build_failure_record(error: Exception) -> dict[str, object]:
    """Produce a safe, bounded failure record stored with the durable action."""
    if isinstance(error, SangamError):
        code = error.code
        message = error.message
    else:
        code = "execution_failed"
        message = "The action could not be completed."
    return {
        "code": code,
        "message": message[:500],
        "retry_safe": classify_retry_safety(error),
    }
