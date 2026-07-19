from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
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
    max_document_bytes: int = Field(default=2_000_000, ge=1_024, le=50_000_000)
    max_pdf_bytes: int = Field(default=100_000_000, ge=1_024, le=1_000_000_000)
    max_publication_asset_bytes: int = Field(default=10_000_000, ge=1_024, le=100_000_000)
    max_karakeep_source_bytes: int = Field(default=5_000_000, ge=1_024, le=50_000_000)
    karakeep_base_url: str | None = None
    karakeep_api_key: SecretStr | None = None
    karakeep_timeout_seconds: float = Field(default=20.0, ge=1.0, le=120.0)
    openrouter_api_key: SecretStr | None = None
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_http_referer: str | None = None
    openrouter_app_title: str = "Sangam"
    chatkit_domain_key: str = "local-dev"
    chat_default_model: str = Field(default="openai/gpt-5.4-mini", min_length=1, max_length=160)
    chat_available_models: tuple[str, ...] = (
        "openai/gpt-5.4-mini",
        "openai/gpt-5.4-nano",
        "openai/gpt-5.6-terra",
    )
    chat_reasoning_effort: Literal["none", "low", "medium", "high", "xhigh", "max"] = "low"
    chat_timeout_seconds: float = Field(default=120.0, ge=5.0, le=600.0)
    chat_max_tool_rounds: int = Field(default=8, ge=1, le=20)
    chat_max_tool_result_bytes: int = Field(default=40_000, ge=1_024, le=500_000)
    chat_max_context_messages: int = Field(default=20, ge=2, le=100)
    auth_mode: Literal["single_user", "trusted_proxy", "cloudflare_access"] = "single_user"
    trusted_identity_header: str = "X-Sangam-Trusted-Identity"
    trusted_identity_value: str = "human:jay"
    trusted_human_actor_id: str = Field(
        default="human:jay", pattern=r"^human:[a-z0-9][a-z0-9._-]{1,63}$"
    )
    trusted_human_display_name: str = Field(default="Jay", min_length=1, max_length=120)
    cloudflare_access_team_domain: str | None = None
    cloudflare_access_audience: str | None = None
    cloudflare_access_email: str | None = None
    preview_hmac_secret: SecretStr = Field(
        default=SecretStr("development-only-preview-secret-change-me"), min_length=32
    )
    preview_token_ttl_seconds: int = Field(default=120, ge=30, le=600)
    trusted_preview_base_url: str = "http://127.0.0.1:8000/trusted-preview"
    publication_base_url: str = "http://127.0.0.1:8000/p"
    trusted_preview_host: str | None = None
    trusted_preview_connect_src: tuple[str, ...] = ()
    trusted_preview_parent_origins: tuple[str, ...] = (
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://127.0.0.1:8000",
    )

    def prepare(self) -> None:
        if self.chat_default_model not in self.chat_available_models:
            raise ValueError(
                "SANGAM_CHAT_DEFAULT_MODEL must be listed in SANGAM_CHAT_AVAILABLE_MODELS"
            )
        if len(set(self.chat_available_models)) != len(self.chat_available_models):
            raise ValueError("SANGAM_CHAT_AVAILABLE_MODELS must not contain duplicates")
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        self.backup_root.mkdir(parents=True, exist_ok=True)
