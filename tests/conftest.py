from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return Settings(
        database_path=tmp_path / "database" / "sangam.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
        backups_enabled=False,
        frontend_dist=tmp_path / "missing-frontend",
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


def headers(key: str) -> dict[str, str]:
    return {"Idempotency-Key": key}


def issue_agent_token(
    client: TestClient,
    *,
    actor_id: str = "agent:cli",
    display_name: str = "Sangam CLI",
    capabilities: tuple[str, ...] = ("read", "search", "restore"),
    path_prefix: str | None = None,
) -> str:
    response = client.post(
        "/api/v1/agent-tokens",
        json={
            "actor_id": actor_id,
            "display_name": display_name,
            "label": "test token",
            "scopes": [
                {"capability": capability, "path_prefix": path_prefix}
                for capability in capabilities
            ],
        },
    )
    assert response.status_code == 201
    return response.json()["token"]
