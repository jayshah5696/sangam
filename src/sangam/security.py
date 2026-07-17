from __future__ import annotations

import hashlib
import hmac
import logging
import re
import secrets
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import PurePosixPath
from typing import Literal

from sangam.capabilities import Capability
from sangam.db import Database, utc_now
from sangam.errors import (
    AuthenticationError,
    CredentialConflictError,
    NotFoundError,
    ValidationError,
)
from sangam.schemas import Actor, AgentToken, IssuedAgentToken, TokenScope

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ScopeGrant:
    capability: Capability
    path_prefix: str | None


@dataclass(frozen=True)
class Principal:
    actor_id: str
    display_name: str
    identity_kind: str
    operation_id: str
    token_id: str | None = None
    scopes: tuple[ScopeGrant, ...] = ()
    administrator: bool = False

    @classmethod
    def trusted_human(cls, *, actor_id: str, display_name: str, operation_id: str) -> Principal:
        return cls(
            actor_id=actor_id,
            display_name=display_name,
            identity_kind="human",
            operation_id=operation_id,
            administrator=True,
        )


def normalize_scope_prefix(value: str | None) -> str | None:
    if value is None or value.strip() in {"", "/", "/**", "**"}:
        return None
    candidate = value.strip().replace("\\", "/")
    if candidate.endswith("/**"):
        candidate = candidate[:-3]
    candidate = candidate.strip("/")
    pure = PurePosixPath(candidate)
    if not candidate or pure.is_absolute() or any(part in {"", ".", ".."} for part in pure.parts):
        raise ValidationError("Token path scope must be a workspace-relative prefix")
    return pure.as_posix()


def path_matches(prefix: str | None, path: str | None) -> bool:
    if prefix is None:
        return True
    if path is None:
        return False
    return path == prefix or path.startswith(f"{prefix}/")


class IdentityService:
    """Owns persistent actors and one-time bearer-token issuance."""

    _agent_id = re.compile(r"^agent:[a-z0-9][a-z0-9._-]{1,63}$")
    _last_used_interval = timedelta(minutes=5)

    def __init__(self, database: Database) -> None:
        self.database = database

    def list_actors(self) -> list[Actor]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT actor_id, display_name, identity_kind, created_at "
                "FROM actors ORDER BY display_name COLLATE NOCASE, actor_id"
            ).fetchall()
        return [Actor.model_validate(dict(row)) for row in rows]

    def list_tokens(self) -> list[AgentToken]:
        with self.database.connection() as connection:
            rows = connection.execute(
                """
                SELECT t.*, a.display_name AS actor_display_name
                FROM actor_tokens t
                JOIN actors a ON a.actor_id = t.actor_id
                ORDER BY t.created_at DESC, t.token_id DESC
                """
            ).fetchall()
            scope_rows = connection.execute(
                """
                SELECT token_id, capability, path_prefix FROM token_scopes
                ORDER BY token_id, capability, path_prefix
                """
            ).fetchall()
            scopes_by_token: dict[str, list[sqlite3.Row]] = {}
            for scope in scope_rows:
                scopes_by_token.setdefault(scope["token_id"], []).append(scope)
            return [
                self._token_from_row(
                    connection,
                    row,
                    scopes=scopes_by_token.get(row["token_id"], []),
                )
                for row in rows
            ]

    def issue_agent_token(
        self,
        *,
        actor_id: str,
        display_name: str,
        label: str,
        scopes: list[TokenScope],
        expires_at: str | None,
        rotated_from_token_id: str | None = None,
    ) -> IssuedAgentToken:
        normalized_actor_id = actor_id.strip().lower()
        if not self._agent_id.fullmatch(normalized_actor_id):
            raise ValidationError("Agent IDs must look like agent:researcher")
        normalized_name = " ".join(display_name.strip().split())
        normalized_label = " ".join(label.strip().split())
        if not normalized_name or not normalized_label:
            raise ValidationError("Agent display name and token label are required")
        normalized_expiry = self._validate_expiry(expires_at)
        grants = self._normalize_scopes(scopes)
        token_id = f"agt_{uuid.uuid4().hex[:16]}"
        secret = secrets.token_urlsafe(32)
        raw_token = f"sgm_{token_id}.{secret}"
        secret_hash = hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
        now = utc_now()
        with self.database.transaction() as connection:
            existing = connection.execute(
                "SELECT identity_kind, display_name FROM actors WHERE actor_id = ?",
                (normalized_actor_id,),
            ).fetchone()
            if existing and existing["identity_kind"] != "agent":
                raise ValidationError("That actor ID belongs to a non-agent identity")
            if existing and existing["display_name"] != normalized_name:
                raise CredentialConflictError(
                    "That agent ID already has a different display name",
                    details={"actor_id": normalized_actor_id},
                )
            connection.execute(
                """
                INSERT INTO actors(
                    actor_id, display_name, actor_type, created_at, identity_kind
                ) VALUES (?, ?, 'client', ?, 'agent')
                ON CONFLICT(actor_id) DO NOTHING
                """,
                (normalized_actor_id, normalized_name, now),
            )
            if rotated_from_token_id is not None:
                old = connection.execute(
                    """
                    SELECT actor_id, revoked_at, expires_at
                    FROM actor_tokens WHERE token_id = ?
                    """,
                    (rotated_from_token_id,),
                ).fetchone()
                if not old or old["actor_id"] != normalized_actor_id:
                    raise NotFoundError("Token to rotate was not found for this agent")
                if old["revoked_at"] is not None or (
                    old["expires_at"] is not None
                    and self._parse_timestamp(old["expires_at"]) <= datetime.now(UTC)
                ):
                    raise CredentialConflictError("Only an active agent token can be rotated")
                connection.execute(
                    """
                    UPDATE actor_tokens SET revoked_at = COALESCE(revoked_at, ?)
                    WHERE token_id = ?
                    """,
                    (now, rotated_from_token_id),
                )
            connection.execute(
                """
                INSERT INTO actor_tokens(
                    token_id, actor_id, label, secret_hash, created_at, expires_at,
                    revoked_at, last_used_at, rotated_from_token_id
                ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
                """,
                (
                    token_id,
                    normalized_actor_id,
                    normalized_label,
                    secret_hash,
                    now,
                    normalized_expiry,
                    rotated_from_token_id,
                ),
            )
            connection.executemany(
                "INSERT INTO token_scopes(token_id, capability, path_prefix) VALUES (?, ?, ?)",
                [(token_id, grant.capability.value, grant.path_prefix or "") for grant in grants],
            )
            row = connection.execute(
                """
                SELECT t.*, a.display_name AS actor_display_name
                FROM actor_tokens t JOIN actors a ON a.actor_id = t.actor_id
                WHERE t.token_id = ?
                """,
                (token_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError("Issued token could not be reloaded")
            result = self._token_from_row(connection, row)
        return IssuedAgentToken(**result.model_dump(), token=raw_token)

    def rotate_token(self, token_id: str) -> IssuedAgentToken:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT t.*, a.display_name AS actor_display_name
                FROM actor_tokens t JOIN actors a ON a.actor_id = t.actor_id
                WHERE t.token_id = ?
                """,
                (token_id,),
            ).fetchone()
            if row is None:
                raise NotFoundError(f"Agent token not found: {token_id}")
            token = self._token_from_row(connection, row)
        return self.issue_agent_token(
            actor_id=token.actor_id,
            display_name=token.actor_display_name,
            label=token.label,
            scopes=token.scopes,
            expires_at=token.expires_at,
            rotated_from_token_id=token_id,
        )

    def revoke_token(self, token_id: str) -> AgentToken:
        now = utc_now()
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE actor_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_id = ?",
                (now, token_id),
            )
            row = connection.execute(
                """
                SELECT t.*, a.display_name AS actor_display_name
                FROM actor_tokens t JOIN actors a ON a.actor_id = t.actor_id
                WHERE t.token_id = ?
                """,
                (token_id,),
            ).fetchone()
            if row is None:
                raise NotFoundError(f"Agent token not found: {token_id}")
            return self._token_from_row(connection, row)

    def authenticate(self, raw_token: str, *, operation_id: str) -> Principal:
        token_id = self._parse_token_id(raw_token)
        now = datetime.now(UTC)
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT t.*, a.display_name, a.identity_kind
                FROM actor_tokens t JOIN actors a ON a.actor_id = t.actor_id
                WHERE t.token_id = ?
                """,
                (token_id,),
            ).fetchone()
            if row is None or not hmac.compare_digest(
                row["secret_hash"], hashlib.sha256(raw_token.encode("utf-8")).hexdigest()
            ):
                raise AuthenticationError("The bearer token is invalid")
            if row["revoked_at"] is not None:
                raise AuthenticationError("The bearer token has been revoked")
            if row["expires_at"] is not None and self._parse_timestamp(row["expires_at"]) <= now:
                raise AuthenticationError("The bearer token has expired")
            scope_rows = connection.execute(
                "SELECT capability, path_prefix FROM token_scopes WHERE token_id = ?",
                (token_id,),
            ).fetchall()
        last_used_at = row["last_used_at"]
        if last_used_at is None or self._parse_timestamp(last_used_at) <= (
            now - self._last_used_interval
        ):
            self._touch_last_used(token_id, now=now)
        return Principal(
            actor_id=row["actor_id"],
            display_name=row["display_name"],
            identity_kind=row["identity_kind"],
            operation_id=operation_id,
            token_id=token_id,
            scopes=tuple(
                ScopeGrant(
                    capability=Capability(scope["capability"]),
                    path_prefix=scope["path_prefix"] or None,
                )
                for scope in scope_rows
            ),
        )

    def _touch_last_used(self, token_id: str, *, now: datetime) -> None:
        timestamp = now.isoformat(timespec="microseconds")
        cutoff = (now - self._last_used_interval).isoformat(timespec="microseconds")
        try:
            with self.database.connection() as connection:
                connection.execute(
                    """
                    UPDATE actor_tokens SET last_used_at = ?
                    WHERE token_id = ? AND revoked_at IS NULL
                        AND (last_used_at IS NULL OR last_used_at <= ?)
                    """,
                    (timestamp, token_id, cutoff),
                )
        except sqlite3.OperationalError:
            logger.warning("Could not update agent-token last-use telemetry", exc_info=True)

    @staticmethod
    def _parse_token_id(raw_token: str) -> str:
        if not raw_token.startswith("sgm_agt_"):
            raise AuthenticationError("The bearer token format is invalid")
        prefix, separator, secret = raw_token.partition(".")
        token_id = prefix.removeprefix("sgm_")
        if not separator or not secret or not token_id.startswith("agt_"):
            raise AuthenticationError("The bearer token format is invalid")
        return token_id

    @staticmethod
    def _parse_timestamp(value: str) -> datetime:
        parsed = datetime.fromisoformat(value)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)

    @classmethod
    def _validate_expiry(cls, expires_at: str | None) -> str | None:
        if expires_at is None:
            return None
        try:
            parsed = cls._parse_timestamp(expires_at)
        except ValueError as error:
            raise ValidationError("Token expiration must be an ISO 8601 timestamp") from error
        if parsed <= datetime.now(UTC):
            raise ValidationError("Token expiration must be in the future")
        return parsed.astimezone(UTC).isoformat(timespec="microseconds")

    @staticmethod
    def _normalize_scopes(scopes: list[TokenScope]) -> tuple[ScopeGrant, ...]:
        grants = {
            ScopeGrant(Capability(scope.capability), normalize_scope_prefix(scope.path_prefix))
            for scope in scopes
        }
        if not grants:
            raise ValidationError("At least one token scope is required")
        return tuple(
            sorted(grants, key=lambda item: (item.capability.value, item.path_prefix or ""))
        )

    @staticmethod
    def _token_from_row(
        connection: sqlite3.Connection,
        row: sqlite3.Row,
        *,
        scopes: list[sqlite3.Row] | None = None,
    ) -> AgentToken:
        if scopes is None:
            scopes = connection.execute(
                """
                SELECT capability, path_prefix FROM token_scopes
                WHERE token_id = ? ORDER BY capability, path_prefix
                """,
                (row["token_id"],),
            ).fetchall()
        return AgentToken(
            token_id=row["token_id"],
            actor_id=row["actor_id"],
            actor_display_name=row["actor_display_name"],
            label=row["label"],
            scopes=[
                TokenScope(capability=scope["capability"], path_prefix=scope["path_prefix"] or None)
                for scope in scopes
            ],
            created_at=row["created_at"],
            expires_at=row["expires_at"],
            revoked_at=row["revoked_at"],
            last_used_at=row["last_used_at"],
            rotated_from_token_id=row["rotated_from_token_id"],
        )


class AuthenticationService:
    """Resolves transport assertions into one immutable request principal."""

    def __init__(
        self,
        *,
        identity: IdentityService,
        auth_mode: Literal["single_user", "trusted_proxy"],
        trusted_identity_value: str,
        trusted_human_actor_id: str,
        trusted_human_display_name: str,
    ) -> None:
        if auth_mode not in {"single_user", "trusted_proxy"}:
            raise ValueError(f"Unsupported authentication mode: {auth_mode}")
        self.identity = identity
        self.auth_mode = auth_mode
        self.trusted_identity_value = trusted_identity_value
        self.trusted_human_actor_id = trusted_human_actor_id
        self.trusted_human_display_name = trusted_human_display_name

    def resolve(
        self,
        *,
        authorization_header: str | None,
        trusted_identity_assertion: str | None,
        operation_id: str,
    ) -> Principal:
        if authorization_header:
            scheme, separator, credential = authorization_header.partition(" ")
            credential = credential.strip()
            if not separator or scheme.casefold() != "bearer" or not credential:
                raise AuthenticationError("Authorization must use a Bearer token")
            return self.identity.authenticate(credential, operation_id=operation_id)
        if self.auth_mode == "trusted_proxy" and (
            trusted_identity_assertion != self.trusted_identity_value
        ):
            raise AuthenticationError("A trusted human identity assertion is required")
        return Principal.trusted_human(
            actor_id=self.trusted_human_actor_id,
            display_name=self.trusted_human_display_name,
            operation_id=operation_id,
        )
