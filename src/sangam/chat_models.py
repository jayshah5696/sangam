from __future__ import annotations

import json
from dataclasses import dataclass

import httpx

from sangam.db import Database, utc_now
from sangam.errors import IntegrationError, ValidationError
from sangam.schemas import ChatModelInfo, ChatModelSettings


@dataclass(frozen=True)
class CatalogModel:
    """A model the workspace can offer, independent of whether it is enabled."""

    id: str
    name: str
    provider: str


def _provider_of(model_id: str) -> str:
    return model_id.split("/", 1)[0] if "/" in model_id else "other"


# A small, vetted starting catalog of tool-capable Responses models. The full
# OpenRouter catalog is large and volatile, so Sangam ships a curated set and
# lets the operator pull the live list on demand from the Models settings page.
CURATED_CATALOG: tuple[CatalogModel, ...] = (
    CatalogModel("openai/gpt-5.4-mini", "GPT-5.4 Mini", "openai"),
    CatalogModel("openai/gpt-5.4-nano", "GPT-5.4 Nano", "openai"),
    CatalogModel("openai/gpt-5.4", "GPT-5.4", "openai"),
    CatalogModel("openai/gpt-5.6-terra", "GPT-5.6 Terra", "openai"),
    CatalogModel("anthropic/claude-sonnet-4.5", "Claude Sonnet 4.5", "anthropic"),
    CatalogModel("google/gemini-2.5-flash", "Gemini 2.5 Flash", "google"),
)


@dataclass(frozen=True)
class ModelSettingsState:
    openrouter_enabled: bool
    default_model: str
    enabled_models: tuple[str, ...]
    catalog: tuple[CatalogModel, ...]
    catalog_fetched_at: str | None


class ChatModelSettingsRepository:
    """Persists the operator's model catalog, enabled set, and default choice."""

    def __init__(
        self,
        database: Database,
        *,
        seed_default_model: str,
        seed_enabled_models: tuple[str, ...],
    ) -> None:
        self.database = database
        self._seed_default_model = seed_default_model
        self._seed_enabled_models = seed_enabled_models

    def _seed_catalog(self) -> tuple[CatalogModel, ...]:
        catalog: dict[str, CatalogModel] = {model.id: model for model in CURATED_CATALOG}
        for model_id in (self._seed_default_model, *self._seed_enabled_models):
            catalog.setdefault(
                model_id,
                CatalogModel(model_id, _pretty_name(model_id), _provider_of(model_id)),
            )
        return tuple(catalog.values())

    def get(self) -> ModelSettingsState:
        with self.database.transaction() as connection:
            row = connection.execute("SELECT * FROM chat_model_settings WHERE id = 1").fetchone()
            if row is None:
                state = ModelSettingsState(
                    openrouter_enabled=True,
                    default_model=self._seed_default_model,
                    enabled_models=self._seed_enabled_models,
                    catalog=self._seed_catalog(),
                    catalog_fetched_at=None,
                )
                self._write(connection, state)
                return state
            return _state_from_row(row)

    def update(
        self,
        *,
        openrouter_enabled: bool,
        default_model: str,
        enabled_models: list[str],
    ) -> ModelSettingsState:
        current = self.get()
        catalog_ids = {model.id for model in current.catalog}
        deduped: list[str] = list(dict.fromkeys(enabled_models))
        if not deduped:
            raise ValidationError("Enable at least one model")
        unknown = [model_id for model_id in deduped if model_id not in catalog_ids]
        if unknown:
            raise ValidationError(f"Unknown model in selection: {unknown[0]}")
        if default_model not in deduped:
            raise ValidationError("The default model must be one of the enabled models")
        state = ModelSettingsState(
            openrouter_enabled=openrouter_enabled,
            default_model=default_model,
            enabled_models=tuple(deduped),
            catalog=current.catalog,
            catalog_fetched_at=current.catalog_fetched_at,
        )
        with self.database.transaction() as connection:
            self._write(connection, state)
        return state

    def replace_catalog(self, models: list[CatalogModel]) -> ModelSettingsState:
        current = self.get()
        catalog: dict[str, CatalogModel] = {}
        for model in models:
            catalog.setdefault(model.id, model)
        # Preserve any currently enabled model even if the fresh catalog omits it,
        # so a refresh never silently drops a model the operator is relying on.
        for model_id in (current.default_model, *current.enabled_models):
            catalog.setdefault(
                model_id,
                CatalogModel(model_id, _pretty_name(model_id), _provider_of(model_id)),
            )
        state = ModelSettingsState(
            openrouter_enabled=current.openrouter_enabled,
            default_model=current.default_model,
            enabled_models=current.enabled_models,
            catalog=tuple(catalog.values()),
            catalog_fetched_at=utc_now(),
        )
        with self.database.transaction() as connection:
            self._write(connection, state)
        return state

    @staticmethod
    def _write(connection, state: ModelSettingsState) -> None:
        connection.execute(
            """
            INSERT INTO chat_model_settings(
                id, openrouter_enabled, default_model, enabled_models_json,
                catalog_json, catalog_fetched_at, updated_at
            ) VALUES (1, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                openrouter_enabled = excluded.openrouter_enabled,
                default_model = excluded.default_model,
                enabled_models_json = excluded.enabled_models_json,
                catalog_json = excluded.catalog_json,
                catalog_fetched_at = excluded.catalog_fetched_at,
                updated_at = excluded.updated_at
            """,
            (
                1 if state.openrouter_enabled else 0,
                state.default_model,
                json.dumps(list(state.enabled_models)),
                json.dumps([_catalog_to_dict(model) for model in state.catalog]),
                state.catalog_fetched_at,
                utc_now(),
            ),
        )


def _catalog_to_dict(model: CatalogModel) -> dict[str, str]:
    return {"id": model.id, "name": model.name, "provider": model.provider}


def _state_from_row(row) -> ModelSettingsState:
    catalog = tuple(
        CatalogModel(item["id"], item["name"], item["provider"])
        for item in json.loads(row["catalog_json"])
    )
    return ModelSettingsState(
        openrouter_enabled=bool(row["openrouter_enabled"]),
        default_model=row["default_model"],
        enabled_models=tuple(json.loads(row["enabled_models_json"])),
        catalog=catalog,
        catalog_fetched_at=row["catalog_fetched_at"],
    )


def _pretty_name(model_id: str) -> str:
    tail = model_id.split("/", 1)[-1]
    return tail.replace("-", " ").replace(":", " ").title()


class ChatModelCatalog:
    """Reads persisted model settings and refreshes the catalog from OpenRouter."""

    def __init__(
        self,
        repository: ChatModelSettingsRepository,
        *,
        api_key: str | None,
        base_url: str,
        timeout_seconds: float,
    ) -> None:
        self.repository = repository
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout_seconds = timeout_seconds

    @property
    def configured(self) -> bool:
        return self._api_key is not None

    def state(self) -> ModelSettingsState:
        return self.repository.get()

    def as_schema(self) -> ChatModelSettings:
        state = self.state()
        enabled = set(state.enabled_models)
        catalog = [
            ChatModelInfo(
                id=model.id,
                name=model.name,
                provider=model.provider,
                enabled=model.id in enabled,
            )
            for model in state.catalog
        ]
        return ChatModelSettings(
            openrouter_configured=self.configured,
            openrouter_enabled=state.openrouter_enabled,
            default_model=state.default_model,
            enabled_models=list(state.enabled_models),
            catalog=catalog,
            catalog_fetched_at=state.catalog_fetched_at,
        )

    def update(
        self, *, openrouter_enabled: bool, default_model: str, enabled_models: list[str]
    ) -> ChatModelSettings:
        self.repository.update(
            openrouter_enabled=openrouter_enabled,
            default_model=default_model,
            enabled_models=enabled_models,
        )
        return self.as_schema()

    def refresh_from_openrouter(self) -> ChatModelSettings:
        if self._api_key is None:
            raise ValidationError("Set SANGAM_OPENROUTER_API_KEY before fetching models")
        models = self._fetch_openrouter_models()
        self.repository.replace_catalog(models)
        return self.as_schema()

    def _fetch_openrouter_models(self) -> list[CatalogModel]:
        try:
            response = httpx.get(
                f"{self._base_url}/models",
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {self._api_key}",
                },
                timeout=self._timeout_seconds,
                follow_redirects=False,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise IntegrationError(
                "OpenRouter could not be reached or returned an invalid response"
            ) from error
        data = payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(data, list):
            raise IntegrationError("OpenRouter returned an unexpected models response")
        models: list[CatalogModel] = []
        for entry in data:
            if not isinstance(entry, dict):
                continue
            model_id = entry.get("id")
            if not isinstance(model_id, str) or not model_id:
                continue
            # Only surface models that can drive Sangam's tool loop.
            supported = entry.get("supported_parameters")
            if isinstance(supported, list) and "tools" not in supported:
                continue
            name = entry.get("name")
            models.append(
                CatalogModel(
                    id=model_id,
                    name=name if isinstance(name, str) and name else _pretty_name(model_id),
                    provider=_provider_of(model_id),
                )
            )
        if not models:
            raise IntegrationError("OpenRouter returned no tool-capable models")
        return models
