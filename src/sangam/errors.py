from __future__ import annotations


class SangamError(Exception):
    code = "sangam_error"

    def __init__(self, message: str, *, details: dict[str, object] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class NotFoundError(SangamError):
    code = "not_found"


class ConflictError(SangamError):
    code = "revision_conflict"


class IdempotencyError(SangamError):
    code = "idempotency_conflict"


class InvalidPathError(SangamError):
    code = "invalid_path"


class MaterializationError(SangamError):
    code = "materialization_failed"


class ValidationError(SangamError):
    code = "validation_error"
