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


@pytest.fixture
def mutation_headers() -> dict[str, str]:
    return {"X-Actor": "human:jay", "Idempotency-Key": "test-mutation"}


def headers(key: str, actor: str = "human:jay") -> dict[str, str]:
    return {"X-Actor": actor, "Idempotency-Key": key}
