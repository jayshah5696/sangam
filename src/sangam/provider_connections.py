from __future__ import annotations

import os
import re
from dataclasses import dataclass, field, replace
from typing import Literal
from urllib.parse import urlsplit

import httpx
from agents.models.openai_provider import OpenAIProvider
from openai import AsyncOpenAI
from pydantic import BaseModel, ConfigDict, Field
from pydantic import ValidationError as PydanticValidationError

from sangam.db import Database, utc_now
from sangam.errors import ConflictError, IntegrationError, NotFoundError, ValidationError

ProviderProtocol = Literal["openai_responses", "openai_chat_completions"]
ProviderHealth = Literal["unknown", "ready", "unreachable", "incompatible"]
ProviderStatus = Literal["disabled", "missing_credential", "ready", "unreachable", "incompatible"]

_CONNECTION_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{1,63}$")
_CREDENTIAL_ENV = re.compile(r"^[A-Z][A-Z0-9_]{2,127}$")
_CONNECTION_COLUMNS = """
    connection_id, name, preset, protocol, base_url, credential_env,
    enabled, version, health_status, last_checked_at, last_error
"""


@dataclass(frozen=True)
class ProviderConnection:
    """A provider-neutral inference endpoint with a server-owned credential reference."""

    connection_id: str
    name: str
    protocol: ProviderProtocol
    base_url: str
    credential_env: str | None
    enabled: bool
    version: int
    health_status: ProviderHealth
    last_checked_at: str | None
    last_error: str | None
    preset: str | None = None
    api_key: str | None = field(default=None, repr=False, compare=False)

    @property
    def credential_present(self) -> bool:
        return self.credential_env is None or bool(self.api_key)

    @property
    def status(self) -> ProviderStatus:
        if not self.enabled:
            return "disabled"
        if not self.credential_present:
            return "missing_credential"
        if self.health_status == "unreachable":
            return "unreachable"
        if self.health_status == "incompatible":
            return "incompatible"
        return "ready"


@dataclass(frozen=True)
class DiscoveredModel:
    model_id: str
    name: str
    publisher: str
    supports_tools: bool | None
    supports_reasoning: bool | None


class _StoredConnection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connection_id: str
    name: str
    preset: str | None
    protocol: ProviderProtocol
    base_url: str
    credential_env: str | None
    enabled: bool
    version: int = Field(ge=1)
    health_status: ProviderHealth
    last_checked_at: str | None
    last_error: str | None


class _RemoteModel(BaseModel):
    model_config = ConfigDict(extra="allow")

    id: str = Field(min_length=1, max_length=240)
    name: str | None = None
    owned_by: str | None = None
    supported_parameters: list[str] | None = None


class _RemoteModelList(BaseModel):
    model_config = ConfigDict(extra="allow")

    data: list[_RemoteModel]


class ProviderConnectionRepository:
    def __init__(self, database: Database) -> None:
        self.database = database

    def list(self) -> tuple[ProviderConnection, ...]:
        with self.database.connection() as connection:
            rows = connection.execute(
                f"SELECT {_CONNECTION_COLUMNS} FROM provider_connections "
                "ORDER BY name COLLATE NOCASE, connection_id"
            ).fetchall()
        return tuple(self._from_row(row) for row in rows)

    def get(self, connection_id: str) -> ProviderConnection:
        with self.database.connection() as connection:
            row = connection.execute(
                f"SELECT {_CONNECTION_COLUMNS} FROM provider_connections WHERE connection_id = ?",
                (connection_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Provider connection not found: {connection_id}")
        return self._from_row(row)

    def create(self, value: ProviderConnection) -> ProviderConnection:
        now = utc_now()
        with self.database.transaction() as connection:
            try:
                connection.execute(
                    """
                    INSERT INTO provider_connections(
                        connection_id, name, preset, protocol, base_url, credential_env,
                        enabled, version, health_status, last_checked_at, last_error,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        value.connection_id,
                        value.name,
                        value.preset,
                        value.protocol,
                        value.base_url,
                        value.credential_env,
                        1 if value.enabled else 0,
                        value.version,
                        value.health_status,
                        value.last_checked_at,
                        value.last_error,
                        now,
                        now,
                    ),
                )
            except Exception as error:
                if "UNIQUE constraint failed" in str(error):
                    raise ConflictError("That provider connection ID already exists") from error
                raise
        return self.get(value.connection_id)

    def update(self, value: ProviderConnection, *, expected_version: int) -> ProviderConnection:
        next_version = expected_version + 1
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE provider_connections SET
                    name = ?, protocol = ?, base_url = ?, credential_env = ?, enabled = ?,
                    version = ?, health_status = ?, last_checked_at = ?,
                    last_error = ?, updated_at = ?
                WHERE connection_id = ? AND version = ?
                """,
                (
                    value.name,
                    value.protocol,
                    value.base_url,
                    value.credential_env,
                    1 if value.enabled else 0,
                    next_version,
                    value.health_status,
                    value.last_checked_at,
                    value.last_error,
                    utc_now(),
                    value.connection_id,
                    expected_version,
                ),
            )
            if cursor.rowcount != 1:
                current = connection.execute(
                    "SELECT version FROM provider_connections WHERE connection_id = ?",
                    (value.connection_id,),
                ).fetchone()
                if current is None:
                    raise NotFoundError(f"Provider connection not found: {value.connection_id}")
                raise ConflictError(
                    "Provider connection settings changed in another session",
                    details={
                        "expected_version": expected_version,
                        "current_version": current["version"],
                    },
                )
        return self.get(value.connection_id)

    def record_health(
        self,
        connection_id: str,
        *,
        health_status: ProviderHealth,
        error: str | None,
    ) -> ProviderConnection:
        current = self.get(connection_id)
        return self.update(
            replace(
                current,
                health_status=health_status,
                last_checked_at=utc_now(),
                last_error=error,
            ),
            expected_version=current.version,
        )

    @staticmethod
    def _from_row(row) -> ProviderConnection:
        try:
            stored = _StoredConnection.model_validate(dict(row))
        except PydanticValidationError as error:
            raise IntegrationError(
                "Stored provider connection is invalid",
                details={"connection_id": row["connection_id"]},
            ) from error
        return ProviderConnection(**stored.model_dump())


class ProviderConnectionService:
    """Owns connection validation, credential resolution, discovery, and SDK adapters."""

    def __init__(
        self,
        repository: ProviderConnectionRepository,
        *,
        deployment_mode: Literal["development", "production"],
        timeout_seconds: float,
        openrouter_api_key: str | None,
        openrouter_base_url: str,
        openrouter_http_referer: str | None,
        openrouter_app_title: str,
    ) -> None:
        self.repository = repository
        self.deployment_mode = deployment_mode
        self.timeout_seconds = timeout_seconds
        self.openrouter_http_referer = openrouter_http_referer
        self.openrouter_app_title = openrouter_app_title
        self._credential_overrides = {"openrouter": openrouter_api_key}
        self._sync_openrouter_seed(openrouter_base_url)

    def list(self) -> tuple[ProviderConnection, ...]:
        return tuple(self._with_credential(item) for item in self.repository.list())

    def get(self, connection_id: str) -> ProviderConnection:
        return self._with_credential(self.repository.get(connection_id))

    def create(
        self,
        *,
        connection_id: str,
        name: str,
        protocol: ProviderProtocol,
        base_url: str,
        credential_env: str | None,
        enabled: bool,
    ) -> ProviderConnection:
        normalized_id = connection_id.strip().lower()
        if not _CONNECTION_ID.fullmatch(normalized_id):
            raise ValidationError(
                "Connection IDs must use 2 to 64 lowercase letters, numbers, underscores, or dashes"
            )
        value = ProviderConnection(
            connection_id=normalized_id,
            name=self._validate_name(name),
            protocol=protocol,
            base_url=self._validate_base_url(base_url),
            credential_env=self._validate_credential_env(credential_env),
            enabled=enabled,
            version=1,
            health_status="unknown",
            last_checked_at=None,
            last_error=None,
        )
        return self._with_credential(self.repository.create(value))

    def update(
        self,
        connection_id: str,
        *,
        expected_version: int,
        name: str,
        protocol: ProviderProtocol,
        base_url: str,
        credential_env: str | None,
        enabled: bool,
    ) -> ProviderConnection:
        current = self.repository.get(connection_id)
        endpoint_changed = current.base_url != base_url.rstrip("/") or current.protocol != protocol
        value = replace(
            current,
            name=self._validate_name(name),
            protocol=protocol,
            base_url=self._validate_base_url(base_url),
            credential_env=self._validate_credential_env(credential_env),
            enabled=enabled,
            health_status="unknown" if endpoint_changed else current.health_status,
            last_checked_at=None if endpoint_changed else current.last_checked_at,
            last_error=None if endpoint_changed else current.last_error,
        )
        return self._with_credential(
            self.repository.update(value, expected_version=expected_version)
        )

    def test(self, connection_id: str) -> tuple[ProviderConnection, tuple[DiscoveredModel, ...]]:
        connection = self.get(connection_id)
        if connection.status == "disabled":
            raise ValidationError("Enable the connection before testing it")
        if connection.status == "missing_credential":
            raise ValidationError(
                f"Set {connection.credential_env} in the server environment before testing"
            )
        try:
            models = self._fetch_models(connection)
        except IntegrationError as error:
            health: ProviderHealth = (
                "incompatible" if error.details.get("response_shape") else "unreachable"
            )
            updated = self.repository.record_health(
                connection_id, health_status=health, error=error.message
            )
            raise IntegrationError(error.message, details={"status": health}) from error
        updated = self.repository.record_health(connection_id, health_status="ready", error=None)
        return self._with_credential(updated), models

    def discover_models(self, connection_id: str) -> tuple[DiscoveredModel, ...]:
        connection = self.get(connection_id)
        if connection.status == "missing_credential":
            raise ValidationError(
                f"Set {connection.credential_env} in the server environment before discovery"
            )
        return self._fetch_models(connection)

    def model_provider(self, connection_id: str) -> OpenAIProvider:
        connection = self.get(connection_id)
        if connection.status != "ready":
            raise IntegrationError(
                "The selected provider connection is not ready",
                details={"connection_id": connection_id, "status": connection.status},
            )
        headers: dict[str, str] = {}
        if connection.preset == "openrouter":
            headers["X-Title"] = self.openrouter_app_title
            if self.openrouter_http_referer:
                headers["HTTP-Referer"] = self.openrouter_http_referer
        client = AsyncOpenAI(
            api_key=connection.api_key or "not-required",
            base_url=connection.base_url,
            timeout=self.timeout_seconds,
            default_headers=headers,
        )
        return OpenAIProvider(
            openai_client=client,
            use_responses=connection.protocol == "openai_responses",
        )

    def _fetch_models(self, connection: ProviderConnection) -> tuple[DiscoveredModel, ...]:
        headers = {"Accept": "application/json"}
        if connection.api_key:
            headers["Authorization"] = f"Bearer {connection.api_key}"
        try:
            response = httpx.get(
                f"{connection.base_url}/models",
                headers=headers,
                timeout=self.timeout_seconds,
                follow_redirects=False,
            )
            response.raise_for_status()
        except httpx.HTTPError as error:
            raise IntegrationError(
                "The provider connection could not be reached",
                details={"connection_id": connection.connection_id},
            ) from error
        try:
            payload = _RemoteModelList.model_validate(response.json())
        except (ValueError, PydanticValidationError) as error:
            raise IntegrationError(
                "The endpoint did not return an OpenAI-compatible models response",
                details={"connection_id": connection.connection_id, "response_shape": True},
            ) from error
        discovered = tuple(
            DiscoveredModel(
                model_id=item.id,
                name=item.name or _pretty_name(item.id),
                publisher=item.owned_by or _publisher_of(item.id),
                supports_tools=(
                    None
                    if item.supported_parameters is None
                    else "tools" in item.supported_parameters
                ),
                supports_reasoning=(
                    None
                    if item.supported_parameters is None
                    else "reasoning" in item.supported_parameters
                ),
            )
            for item in payload.data
        )
        if not discovered:
            raise IntegrationError(
                "The provider returned an empty model catalog",
                details={"connection_id": connection.connection_id, "response_shape": True},
            )
        return discovered

    def _with_credential(self, value: ProviderConnection) -> ProviderConnection:
        key = self._credential_overrides.get(value.connection_id)
        if key is None and value.credential_env:
            key = os.environ.get(value.credential_env)
        return replace(value, api_key=key)

    def _sync_openrouter_seed(self, base_url: str) -> None:
        current = self.repository.get("openrouter")
        normalized = self._validate_base_url(base_url)
        if current.base_url == normalized:
            return
        # Environment configuration only migrates the untouched preset. Once an
        # operator edits the connection, SQLite is authoritative across restarts.
        if current.version != 1 or current.health_status != "unknown":
            return
        self.repository.update(
            replace(current, base_url=normalized, health_status="unknown"),
            expected_version=current.version,
        )

    @staticmethod
    def _validate_name(value: str) -> str:
        normalized = " ".join(value.strip().split())
        if not 1 <= len(normalized) <= 120:
            raise ValidationError("Connection names must be between 1 and 120 characters")
        return normalized

    def _validate_base_url(self, value: str) -> str:
        normalized = value.strip().rstrip("/")
        parsed = urlsplit(normalized)
        if (
            not parsed.netloc
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValidationError(
                "Provider base URL must be an origin or API root without credentials"
            )
        if parsed.scheme == "https":
            return normalized
        if (
            self.deployment_mode == "development"
            and parsed.scheme == "http"
            and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        ):
            return normalized
        raise ValidationError("Provider base URL must use HTTPS; development allows loopback HTTP")

    @staticmethod
    def _validate_credential_env(value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        normalized = value.strip()
        if not _CREDENTIAL_ENV.fullmatch(normalized):
            raise ValidationError(
                "Credential references must be uppercase environment variable names"
            )
        return normalized


def model_ref(connection_id: str, model_id: str) -> str:
    return f"{connection_id}::{model_id}"


def split_model_ref(value: str) -> tuple[str, str]:
    connection_id, separator, model_id = value.partition("::")
    if not separator or not connection_id or not model_id:
        raise ValidationError("Model references must include a stable connection ID")
    return connection_id, model_id


def _pretty_name(model_id: str) -> str:
    return model_id.split("/", 1)[-1].replace("-", " ").replace(":", " ").title()


def _publisher_of(model_id: str) -> str:
    return model_id.split("/", 1)[0] if "/" in model_id else "unknown"
