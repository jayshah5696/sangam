from __future__ import annotations

import json
from typing import Any

import pytest
from conftest import issue_agent_token
from fastapi.testclient import TestClient


def _selection(client: TestClient, **overrides: object) -> dict[str, object]:
    current = client.get("/api/v1/chat/models").json()
    return {
        "expected_version": current["version"],
        "workspace_enabled": current["workspace_enabled"],
        "default_model": current["default_model"],
        "enabled_models": current["enabled_models"],
        "unknown_model_overrides": [],
        **overrides,
    }


def test_chat_models_are_connection_scoped_and_seeded_from_defaults(
    client: TestClient,
) -> None:
    body = client.get("/api/v1/chat/models").json()
    assert body["workspace_enabled"] is True
    assert body["default_model"] == "openrouter::openai/gpt-5.6-luna"
    assert all(item.startswith("openrouter::") for item in body["enabled_models"])
    catalog_ids = {model["id"] for model in body["catalog"]}
    assert set(body["enabled_models"]).issubset(catalog_ids)
    assert {model["protocol"] for model in body["catalog"]} == {"openai_responses"}
    assert body["version"] == 1


def test_updating_model_selection_uses_optimistic_concurrency(
    client: TestClient,
) -> None:
    body = _selection(
        client,
        default_model="openrouter::openai/gpt-5.4",
        enabled_models=[
            "openrouter::openai/gpt-5.4",
            "openrouter::openai/gpt-5.4-mini",
        ],
    )
    updated = client.put("/api/v1/chat/models", json=body)
    assert updated.status_code == 200
    assert updated.json()["version"] == 2

    stale = client.put("/api/v1/chat/models", json=body)
    assert stale.status_code == 409
    assert stale.json()["error"]["details"] == {
        "expected_version": 1,
        "current_version": 2,
    }


def test_unknown_manual_model_requires_explicit_override(client: TestClient) -> None:
    model = "openrouter::custom-provider/custom-model-1"
    rejected = client.put(
        "/api/v1/chat/models",
        json=_selection(
            client,
            default_model=model,
            enabled_models=[model],
        ),
    )
    assert rejected.status_code == 422

    accepted = client.put(
        "/api/v1/chat/models",
        json=_selection(
            client,
            default_model=model,
            enabled_models=[model],
            unknown_model_overrides=[model],
        ),
    )
    assert accepted.status_code == 200
    entry = next(item for item in accepted.json()["catalog"] if item["id"] == model)
    assert entry["compatibility"] == "unknown"
    assert entry["operator_override"] is True


def test_runtime_distinguishes_disabled_from_missing_credential(client: TestClient) -> None:
    missing = client.get("/api/v1/chat/config").json()
    assert missing["status"] == "missing_credential"
    assert missing["inference_enabled"] is False

    disabled = client.put(
        "/api/v1/chat/models",
        json=_selection(client, workspace_enabled=False),
    )
    assert disabled.status_code == 200
    runtime = client.get("/api/v1/chat/config").json()
    assert runtime["status"] == "disabled"
    assert "History" not in runtime["message"]


def test_provider_connections_accept_safe_custom_endpoints_and_reject_unsafe_ones(
    client: TestClient,
) -> None:
    created = client.post(
        "/api/v1/chat/connections",
        json={
            "connection_id": "local-vllm",
            "name": "Local vLLM",
            "protocol": "openai_chat_completions",
            "base_url": "http://127.0.0.1:9000/v1",
            "credential_env": None,
            "enabled": True,
        },
    )
    assert created.status_code == 201
    assert created.json()["status"] == "ready"
    assert created.json()["protocol"] == "openai_chat_completions"

    unsafe = client.post(
        "/api/v1/chat/connections",
        json={
            "connection_id": "unsafe",
            "name": "Unsafe",
            "protocol": "openai_responses",
            "base_url": "http://provider.example/v1",
            "credential_env": "UNSAFE_KEY",
            "enabled": True,
        },
    )
    assert unsafe.status_code == 422


def test_connection_update_rejects_stale_version_and_never_returns_secret(
    client: TestClient,
) -> None:
    original = client.get("/api/v1/chat/connections").json()[0]
    updated = client.put(
        "/api/v1/chat/connections/openrouter",
        json={
            "expected_version": original["version"],
            "name": "OpenRouter primary",
            "protocol": original["protocol"],
            "base_url": original["base_url"],
            "credential_env": original["credential_env"],
            "enabled": True,
        },
    )
    assert updated.status_code == 200
    assert "api_key" not in updated.text
    stale = client.put(
        "/api/v1/chat/connections/openrouter",
        json={
            "expected_version": original["version"],
            "name": "Overwritten",
            "protocol": original["protocol"],
            "base_url": original["base_url"],
            "credential_env": original["credential_env"],
            "enabled": True,
        },
    )
    assert stale.status_code == 409


def test_discovery_parses_provider_wire_data_into_compatibility(
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
                        "supported_parameters": ["tools", "reasoning"],
                    },
                    {
                        "id": "some/embedding-model",
                        "name": "Embeds",
                        "supported_parameters": ["temperature"],
                    },
                ]
            }

    monkeypatch.setattr(
        "sangam.provider_connections.httpx.get", lambda *_args, **_kwargs: FakeResponse()
    )
    service = client.app.state.services.provider_connections
    service._credential_overrides["openrouter"] = "sk-test"

    response = client.post("/api/v1/chat/models/refresh")
    assert response.status_code == 200
    entries = {item["model_id"]: item for item in response.json()["catalog"]}
    assert entries["anthropic/claude-opus-4.1"]["compatibility"] == "verified"
    assert entries["some/embedding-model"]["compatibility"] == "unsupported"


def test_agents_can_read_but_cannot_mutate_global_ai_settings(client: TestClient) -> None:
    token = issue_agent_token(client, capabilities=("read",))
    authorization = {"Authorization": f"Bearer {token}"}
    original = client.get("/api/v1/chat/models", headers=authorization)
    assert original.status_code == 200

    update = client.put(
        "/api/v1/chat/models",
        headers=authorization,
        json=_selection(client, workspace_enabled=False),
    )
    connection = client.post("/api/v1/chat/connections/local/test", headers=authorization)
    assert update.status_code == 403
    assert connection.status_code == 403


def test_mutation_requests_reject_unknown_fields_with_common_envelope(
    client: TestClient,
) -> None:
    response = client.post(
        "/api/v1/documents",
        json={"title": "Typo", "content": "x", "contnet_type": "text/markdown"},
        headers={"Idempotency-Key": "unknown-field"},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_openapi_uses_the_common_error_envelope(client: TestClient) -> None:
    document_post = client.app.openapi()["paths"]["/api/v1/documents"]["post"]
    validation_schema = document_post["responses"]["422"]["content"]["application/json"]["schema"]
    assert validation_schema == {"$ref": "#/components/schemas/ErrorResponse"}


def test_operator_connection_edit_is_authoritative_over_environment_seed(
    client: TestClient,
) -> None:
    service = client.app.state.services.provider_connections
    original = service.get("openrouter")
    saved = service.update(
        "openrouter",
        expected_version=original.version,
        name=original.name,
        protocol=original.protocol,
        base_url="https://gateway.example/v1",
        credential_env=original.credential_env,
        enabled=True,
    )

    service._sync_openrouter_seed("https://different.example/v1")

    reloaded = service.get("openrouter")
    assert saved.version == 2
    assert reloaded.base_url == "https://gateway.example/v1"


def test_legacy_curated_catalog_keeps_verified_compatibility(client: TestClient) -> None:
    repository = client.app.state.services.chat.model_catalog.repository
    repository.get()
    legacy_catalog = [
        {
            "id": "openai/gpt-5.4-mini",
            "name": "GPT-5.4 Mini",
            "provider": "openai",
        }
    ]
    with repository.database.transaction() as connection:
        connection.execute(
            "UPDATE chat_model_settings SET catalog_json = ? WHERE id = 1",
            (json.dumps(legacy_catalog),),
        )

    state = client.get("/api/v1/chat/models").json()
    model = next(item for item in state["catalog"] if item["model_id"] == "openai/gpt-5.4-mini")
    assert model["compatibility"] == "verified"
    assert model["supports_tools"] is True
