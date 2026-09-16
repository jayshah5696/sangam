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


class CredentialConflictError(ConflictError):
    code = "credential_conflict"


class IdempotencyError(SangamError):
    code = "idempotency_conflict"


class InvalidPathError(SangamError):
    code = "invalid_path"


class MaterializationError(SangamError):
    code = "materialization_failed"


class IntegrationError(SangamError):
    code = "integration_unavailable"


class ValidationError(SangamError):
    code = "validation_error"


class AuthenticationError(SangamError):
    code = "authentication_required"


class AuthorizationError(SangamError):
    code = "forbidden"


def validate_metadata_text(value: str | None, field_name: str) -> str | None:
    """Ensure metadata text fields reject null bytes and ASCII control characters."""
    if value is None:
        return None
    if "\x00" in value:
        raise ValidationError(f"{field_name} cannot contain null bytes")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValidationError(f"{field_name} cannot contain control characters")
    return value
