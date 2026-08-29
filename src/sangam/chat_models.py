from __future__ import annotations

import json
from dataclasses import dataclass, replace
from typing import Literal

from pydantic import BaseModel, ConfigDict, TypeAdapter
from pydantic import ValidationError as PydanticError

from sangam.db import Database, utc_now
from sangam.errors import ConflictError, IntegrationError, ValidationError
from sangam.provider_connections import (
    DiscoveredModel,
    ProviderConnectionService,
    model_ref,
    split_model_ref,
)
from sangam.schemas import ChatModelInfo, ChatModelSettings

ModelCompatibility = Literal["verified", "unknown", "unsupported"]


@dataclass(frozen=True)
class CatalogModel:
    """A connection-scoped model with explicit compatibility information."""

    connection_id: str
    model_id: str
    name: str
    publisher: str
    protocol: Literal["openai_responses", "openai_chat_completions"]
    compatibility: ModelCompatibility
    supports_tools: bool | None
    supports_reasoning: bool | None
    operator_override: bool = False

    @property
    def id(self) -> str:
        return model_ref(self.connection_id, self.model_id)


class _CatalogEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connection_id: str = "openrouter"
    model_id: str | None = None
    id: str | None = None
    name: str
    publisher: str | None = None
    provider: str | None = None
    protocol: Literal["openai_responses", "openai_chat_completions"] = "openai_responses"
    compatibility: ModelCompatibility = "unknown"
    supports_tools: bool | None = None
    supports_reasoning: bool | None = None
    operator_override: bool = False


_CATALOG_ADAPTER = TypeAdapter(list[_CatalogEntry])


@dataclass(frozen=True)
class ModelSettingsState:
    workspace_enabled: bool
    autonomy_mode: Literal["review", "workspace"]
    default_model: str
    enabled_models: tuple[str, ...]
    catalog: tuple[CatalogModel, ...]
    catalog_fetched_at: str | None
    version: int


def _curated_openrouter_catalog() -> tuple[CatalogModel, ...]:
    entries = (
        ("openai/gpt-5.6-sol", "GPT-5.6 Sol", "openai", True),
        ("openai/gpt-5.6-luna", "GPT-5.6 Luna", "openai", True),
        ("openai/gpt-5.4-mini", "GPT-5.4 Mini", "openai", True),
        ("openai/gpt-5.4-nano", "GPT-5.4 Nano", "openai", True),
        ("openai/gpt-5.4", "GPT-5.4", "openai", True),
        ("openai/gpt-5.6-terra", "GPT-5.6 Terra", "openai", True),
        ("anthropic/claude-sonnet-5", "Claude Sonnet 5", "anthropic", None),
        ("google/gemini-3.7-flash", "Gemini 3.7 Flash", "google", None),
        ("google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", "google", None),
    )
    return tuple(
        CatalogModel(
            connection_id="openrouter",
            model_id=model_id,
            name=name,
            publisher=publisher,
            protocol="openai_responses",
            compatibility="verified",
            supports_tools=True,
            supports_reasoning=reasoning,
        )
        for model_id, name, publisher, reasoning in entries
    )


CURATED_CATALOG = _curated_openrouter_catalog()


class ChatModelSettingsRepository:
    """Persists workspace selection while keeping provider credentials elsewhere."""

    def __init__(
        self,
        database: Database,
        *,
        seed_default_model: str,
        seed_enabled_models: tuple[str, ...],
    ) -> None:
        self.database = database
        self._seed_default_model = _normalize_ref(seed_default_model)
        self._seed_enabled_models = tuple(_normalize_ref(item) for item in seed_enabled_models)

    def _seed_catalog(self) -> tuple[CatalogModel, ...]:
        catalog = {item.id: item for item in CURATED_CATALOG}
        for ref in (self._seed_default_model, *self._seed_enabled_models):
            connection_id, model_id = split_model_ref(ref)
            catalog.setdefault(
                ref,
                CatalogModel(
                    connection_id=connection_id,
                    model_id=model_id,
                    name=_pretty_name(model_id),
                    publisher=_publisher_of(model_id),
                    protocol="openai_responses",
                    compatibility="unknown",
                    supports_tools=None,
                    supports_reasoning=None,
                ),
            )
        return tuple(catalog.values())

    def get(self) -> ModelSettingsState:
        with self.database.transaction() as connection:
            row = connection.execute("SELECT * FROM chat_model_settings WHERE id = 1").fetchone()
            if row is None:
                state = ModelSettingsState(
                    workspace_enabled=True,
                    autonomy_mode="review",
                    default_model=self._seed_default_model,
                    enabled_models=self._seed_enabled_models,
                    catalog=self._seed_catalog(),
                    catalog_fetched_at=None,
                    version=1,
                )
                self._insert(connection, state)
                return state
        return _state_from_row(row)

    def update(
        self,
        *,
        expected_version: int,
        workspace_enabled: bool,
        autonomy_mode: Literal["review", "workspace"],
        default_model: str,
        enabled_models: list[str],
        unknown_model_overrides: list[str],
        connection_protocols: dict[str, Literal["openai_responses", "openai_chat_completions"]]
        | None = None,
    ) -> ModelSettingsState:
        current = self.get()
        if current.version != expected_version:
            raise ConflictError(
                "Chat model settings changed in another session",
                details={
                    "expected_version": expected_version,
                    "current_version": current.version,
                },
            )
        catalog = {item.id: item for item in current.catalog}
        overrides = {_normalize_ref(item) for item in unknown_model_overrides}
        deduped = list(dict.fromkeys(_normalize_ref(item) for item in enabled_models))
        if not deduped:
            raise ValidationError("Enable at least one model")
        for ref in deduped:
            if ref not in catalog:
                connection_id, model_id = split_model_ref(ref)
                catalog[ref] = CatalogModel(
                    connection_id=connection_id,
                    model_id=model_id,
                    name=_pretty_name(model_id),
                    publisher=_publisher_of(model_id),
                    protocol=(connection_protocols or {}).get(connection_id, "openai_responses"),
                    compatibility="unknown",
                    supports_tools=None,
                    supports_reasoning=None,
                    operator_override=ref in overrides,
                )
            model = catalog[ref]
            if model.compatibility == "unsupported":
                raise ValidationError(f"Model is not tool-compatible: {ref}")
            if (
                model.compatibility == "unknown"
                and ref not in overrides
                and not model.operator_override
            ):
                raise ValidationError(
                    f"Model compatibility is unknown and needs an operator override: {ref}"
                )
            if ref in overrides and not model.operator_override:
                catalog[ref] = replace(model, operator_override=True)
        normalized_default = _normalize_ref(default_model)
        if normalized_default not in deduped:
            raise ValidationError("The default model must be one of the enabled models")
        state = ModelSettingsState(
            workspace_enabled=workspace_enabled,
            autonomy_mode=autonomy_mode,
            default_model=normalized_default,
            enabled_models=tuple(deduped),
            catalog=tuple(catalog.values()),
            catalog_fetched_at=current.catalog_fetched_at,
            version=current.version + 1,
        )
        self._compare_and_write(state, expected_version=expected_version)
        return state

    def replace_connection_catalog(
        self, connection_id: str, models: tuple[CatalogModel, ...]
    ) -> ModelSettingsState:
        current = self.get()
        catalog = {item.id: item for item in current.catalog if item.connection_id != connection_id}
        for item in models:
            catalog.setdefault(item.id, item)
        for ref in (current.default_model, *current.enabled_models):
            if ref in catalog:
                continue
            old = next((item for item in current.catalog if item.id == ref), None)
            if old:
                catalog[ref] = old
        state = ModelSettingsState(
            workspace_enabled=current.workspace_enabled,
            autonomy_mode=current.autonomy_mode,
            default_model=current.default_model,
            enabled_models=current.enabled_models,
            catalog=tuple(catalog.values()),
            catalog_fetched_at=utc_now(),
            version=current.version + 1,
        )
        self._compare_and_write(state, expected_version=current.version)
        return state

    @staticmethod
    def _insert(connection, state: ModelSettingsState) -> None:
        connection.execute(
            """
            INSERT INTO chat_model_settings(
                id, openrouter_enabled, default_model, enabled_models_json,
                catalog_json, catalog_fetched_at, updated_at, version, autonomy_mode
            ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            _state_values(state),
        )

    def _compare_and_write(self, state: ModelSettingsState, *, expected_version: int) -> None:
        with self.database.transaction() as connection:
            cursor = connection.execute(
                """
                UPDATE chat_model_settings SET
                    openrouter_enabled = ?, default_model = ?, enabled_models_json = ?,
                    catalog_json = ?, catalog_fetched_at = ?, updated_at = ?, version = ?,
                    autonomy_mode = ?
                WHERE id = 1 AND version = ?
                """,
                (*_state_values(state), expected_version),
            )
            if cursor.rowcount != 1:
                current = connection.execute(
                    "SELECT version FROM chat_model_settings WHERE id = 1"
                ).fetchone()
                raise ConflictError(
                    "Chat model settings changed in another session",
                    details={
                        "expected_version": expected_version,
                        "current_version": current["version"] if current else None,
                    },
                )


class ChatModelCatalog:
    def __init__(
        self,
        repository: ChatModelSettingsRepository,
        *,
        connections: ProviderConnectionService,
    ) -> None:
        self.repository = repository
        self.connections = connections

    def state(self) -> ModelSettingsState:
        return self.repository.get()

    def get_model(self, reference: str) -> CatalogModel:
        normalized = _normalize_ref(reference)
        model = next((item for item in self.state().catalog if item.id == normalized), None)
        if model is None:
            raise ValidationError(f"Unknown model reference: {reference}")
        return model

    def as_schema(self) -> ChatModelSettings:
        state = self.state()
        enabled = set(state.enabled_models)
        connections = {item.connection_id: item for item in self.connections.list()}
        return ChatModelSettings(
            workspace_enabled=state.workspace_enabled,
            autonomy_mode=state.autonomy_mode,
            default_model=state.default_model,
            enabled_models=list(state.enabled_models),
            catalog=[
                ChatModelInfo(
                    id=model.id,
                    model_id=model.model_id,
                    connection_id=model.connection_id,
                    connection_name=(
                        connections[model.connection_id].name
                        if model.connection_id in connections
                        else model.connection_id
                    ),
                    name=model.name,
                    publisher=model.publisher,
                    protocol=model.protocol,
                    compatibility=model.compatibility,
                    supports_tools=model.supports_tools,
                    supports_reasoning=model.supports_reasoning,
                    operator_override=model.operator_override,
                    enabled=model.id in enabled,
                )
                for model in state.catalog
            ],
            catalog_fetched_at=state.catalog_fetched_at,
            version=state.version,
        )

    def update(
        self,
        *,
        expected_version: int,
        workspace_enabled: bool,
        autonomy_mode: Literal["review", "workspace"],
        default_model: str,
        enabled_models: list[str],
        unknown_model_overrides: list[str],
    ) -> ChatModelSettings:
        connections = {item.connection_id: item for item in self.connections.list()}
        selected_connection_ids = {
            split_model_ref(_normalize_ref(reference))[0]
            for reference in (default_model, *enabled_models)
        }
        unknown_connections = selected_connection_ids - connections.keys()
        if unknown_connections:
            raise ValidationError(f"Unknown provider connection: {sorted(unknown_connections)[0]}")
        self.repository.update(
            expected_version=expected_version,
            workspace_enabled=workspace_enabled,
            autonomy_mode=autonomy_mode,
            default_model=default_model,
            enabled_models=enabled_models,
            unknown_model_overrides=unknown_model_overrides,
            connection_protocols={
                connection_id: connection.protocol
                for connection_id, connection in connections.items()
            },
        )
        return self.as_schema()

    def refresh(self, connection_id: str) -> ChatModelSettings:
        connection = self.connections.get(connection_id)
        discovered = self.connections.discover_models(connection_id)
        models = tuple(_catalog_from_discovered(connection, item) for item in discovered)
        self.repository.replace_connection_catalog(connection_id, models)
        return self.as_schema()


def _catalog_from_discovered(connection, item: DiscoveredModel) -> CatalogModel:
    compatibility: ModelCompatibility
    if item.supports_tools is False:
        compatibility = "unsupported"
    elif item.supports_tools is True:
        compatibility = "verified"
    else:
        compatibility = "unknown"
    return CatalogModel(
        connection_id=connection.connection_id,
        model_id=item.model_id,
        name=item.name,
        publisher=item.publisher,
        protocol=connection.protocol,
        compatibility=compatibility,
        supports_tools=item.supports_tools,
        supports_reasoning=item.supports_reasoning,
    )


def _state_from_row(row) -> ModelSettingsState:
    try:
        entries = _CATALOG_ADAPTER.validate_python(json.loads(row["catalog_json"]))
        catalog = tuple(_entry_to_model(entry) for entry in entries)
        enabled = tuple(_normalize_ref(item) for item in json.loads(row["enabled_models_json"]))
    except (ValueError, TypeError, KeyError, PydanticError) as error:
        raise IntegrationError("Stored chat model settings are invalid") from error
    return ModelSettingsState(
        workspace_enabled=bool(row["openrouter_enabled"]),
        autonomy_mode=row["autonomy_mode"],
        default_model=_normalize_ref(row["default_model"]),
        enabled_models=enabled,
        catalog=catalog,
        catalog_fetched_at=row["catalog_fetched_at"],
        version=row["version"],
    )


def _entry_to_model(entry: _CatalogEntry) -> CatalogModel:
    raw_id = entry.model_id or entry.id
    if not raw_id:
        raise ValueError("Catalog entry has no model ID")
    if "::" in raw_id:
        connection_id, raw_id = split_model_ref(raw_id)
    else:
        connection_id = entry.connection_id
    # Catalogs written before connection support stored only an OpenRouter model
    # ID. Recover the curated compatibility contract instead of downgrading a
    # previously supported model to "unknown" during migration.
    if entry.model_id is None and connection_id == "openrouter":
        curated = next((item for item in CURATED_CATALOG if item.model_id == raw_id), None)
        if curated is not None:
            return replace(
                curated,
                name=entry.name,
                publisher=entry.publisher or entry.provider or curated.publisher,
            )
    return CatalogModel(
        connection_id=connection_id,
        model_id=raw_id,
        name=entry.name,
        publisher=entry.publisher or entry.provider or _publisher_of(raw_id),
        protocol=entry.protocol,
        compatibility=entry.compatibility,
        supports_tools=entry.supports_tools,
        supports_reasoning=entry.supports_reasoning,
        operator_override=entry.operator_override,
    )


def _state_values(state: ModelSettingsState) -> tuple[object, ...]:
    return (
        1 if state.workspace_enabled else 0,
        state.default_model,
        json.dumps(list(state.enabled_models)),
        json.dumps([_catalog_to_dict(item) for item in state.catalog]),
        state.catalog_fetched_at,
        utc_now(),
        state.version,
        state.autonomy_mode,
    )


def _catalog_to_dict(model: CatalogModel) -> dict[str, object]:
    return {
        "connection_id": model.connection_id,
        "model_id": model.model_id,
        "name": model.name,
        "publisher": model.publisher,
        "protocol": model.protocol,
        "compatibility": model.compatibility,
        "supports_tools": model.supports_tools,
        "supports_reasoning": model.supports_reasoning,
        "operator_override": model.operator_override,
    }


def _normalize_ref(value: str) -> str:
    normalized = value.strip()
    return normalized if "::" in normalized else model_ref("openrouter", normalized)


def _pretty_name(model_id: str) -> str:
    return model_id.split("/", 1)[-1].replace("-", " ").replace(":", " ").title()


def _publisher_of(model_id: str) -> str:
    return model_id.split("/", 1)[0] if "/" in model_id else "unknown"
