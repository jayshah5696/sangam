from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient


def test_chat_models_are_seeded_from_config_defaults(client: TestClient) -> None:
    response = client.get("/api/v1/chat/models")
    assert response.status_code == 200
    body = response.json()
    assert body["openrouter_enabled"] is True
    assert body["default_model"] == "openai/gpt-5.4-mini"
    assert body["enabled_models"] == [
        "openai/gpt-5.4-mini",
        "openai/gpt-5.4-nano",
        "openai/gpt-5.6-terra",
    ]
    catalog_ids = {model["id"] for model in body["catalog"]}
    # The curated catalog must be a superset of the enabled defaults so the
    # settings page always has something to toggle on.
    assert set(body["enabled_models"]).issubset(catalog_ids)
    enabled = {model["id"] for model in body["catalog"] if model["enabled"]}
    assert enabled == set(body["enabled_models"])


def test_updating_model_selection_persists_and_drives_runtime_config(client: TestClient) -> None:
    updated = client.put(
        "/api/v1/chat/models",
        json={
            "openrouter_enabled": True,
            "default_model": "openai/gpt-5.4",
            "enabled_models": ["openai/gpt-5.4", "openai/gpt-5.4-mini"],
        },
    )
    assert updated.status_code == 200
    assert updated.json()["default_model"] == "openai/gpt-5.4"

    reloaded = client.get("/api/v1/chat/models").json()
    assert reloaded["default_model"] == "openai/gpt-5.4"
    assert reloaded["enabled_models"] == ["openai/gpt-5.4", "openai/gpt-5.4-mini"]

    config = client.get("/api/v1/chat/config").json()
    assert config["default_model"] == "openai/gpt-5.4"
    assert config["available_models"] == ["openai/gpt-5.4", "openai/gpt-5.4-mini"]


def test_update_rejects_default_outside_enabled_set(client: TestClient) -> None:
    response = client.put(
        "/api/v1/chat/models",
        json={
            "openrouter_enabled": True,
            "default_model": "openai/gpt-5.4",
            "enabled_models": ["openai/gpt-5.4-mini"],
        },
    )
    assert response.status_code == 422


def test_update_rejects_models_absent_from_catalog(client: TestClient) -> None:
    response = client.put(
        "/api/v1/chat/models",
        json={
            "openrouter_enabled": True,
            "default_model": "made-up/model",
            "enabled_models": ["made-up/model"],
        },
    )
    assert response.status_code == 422


def test_turning_openrouter_off_marks_chat_unconfigured(client: TestClient) -> None:
    client.put(
        "/api/v1/chat/models",
        json={
            "openrouter_enabled": False,
            "default_model": "openai/gpt-5.4-mini",
            "enabled_models": ["openai/gpt-5.4-mini"],
        },
    )
    # Even without an API key in tests, the explicit off switch is reflected so the
    # UI can distinguish "turned off" from "never configured".
    config = client.get("/api/v1/chat/config").json()
    assert config["configured"] is False


def test_refresh_replaces_catalog_from_openrouter(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict[str, Any]:
            return {
                "data": [
                    {
                        "id": "anthropic/claude-opus-4.1",
                        "name": "Claude Opus 4.1",
                        "supported_parameters": ["tools", "temperature"],
                    },
                    {
                        "id": "some/embedding-model",
                        "name": "Embeds",
                        "supported_parameters": ["temperature"],
                    },
                    {"id": "google/gemini-3-pro", "name": "Gemini 3 Pro"},
                ]
            }

    def fake_get(*_args: Any, **_kwargs: Any) -> FakeResponse:
        return FakeResponse()

    monkeypatch.setattr("sangam.chat_models.httpx.get", fake_get)
    catalog = client.app.state.services.chat.model_catalog
    monkeypatch.setattr(catalog, "_api_key", "sk-test")

    response = client.post("/api/v1/chat/models/refresh")
    assert response.status_code == 200
    body = response.json()
    catalog_ids = {model["id"] for model in body["catalog"]}
    # Tool-capable and tool-parameter-unspecified models are kept; the
    # embedding-only model is filtered out.
    assert "anthropic/claude-opus-4.1" in catalog_ids
    assert "google/gemini-3-pro" in catalog_ids
    assert "some/embedding-model" not in catalog_ids
    # Previously enabled defaults survive a refresh even if the fresh feed omits them.
    assert set(body["enabled_models"]).issubset(catalog_ids)
    assert body["catalog_fetched_at"] is not None


def test_refresh_without_api_key_is_rejected(client: TestClient) -> None:
    response = client.post("/api/v1/chat/models/refresh")
    assert response.status_code == 422
