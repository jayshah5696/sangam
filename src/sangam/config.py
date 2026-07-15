from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SANGAM_", env_file=".env", extra="ignore")

    database_path: Path = Field(default=Path("data/database/sangam.sqlite3"))
    workspace_root: Path = Field(default=Path("data/workspace"))
    backup_root: Path = Field(default=Path("data/backups"))
    backup_retention_count: int = Field(default=14, ge=2, le=365)
    backup_check_interval_seconds: int = Field(default=3600, ge=60)
    backups_enabled: bool = True
    frontend_dist: Path = Field(default=Path("frontend/dist"))

    def prepare(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        self.backup_root.mkdir(parents=True, exist_ok=True)
