from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

ChatReasoningEffort = Literal["none", "low", "medium", "high", "xhigh", "max"]


@dataclass(frozen=True)
class ChatServerConfig:
    api_key: str | None
    base_url: str
    http_referer: str | None
    app_title: str
    domain_key: str
    available_models: tuple[str, ...]
    default_model: str
    reasoning_effort: ChatReasoningEffort
    max_turns: int
    max_tool_result_bytes: int
    max_context_messages: int
    timeout_seconds: float


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SANGAM_", env_file=".env", extra="ignore")

    database_path: Path = Field(default=Path("data/database/sangam.sqlite3"))
    deployment_mode: Literal["development", "production"] = "development"
    workspace_root: Path = Field(default=Path("data/workspace"))
    backup_root: Path = Field(default=Path("data/backups"))
    backup_retention_count: int = Field(default=14, ge=2, le=365)
    backup_check_interval_seconds: int = Field(default=3600, ge=60)
    backup_readiness_max_age_seconds: int = Field(default=129_600, ge=3_600, le=604_800)
    backups_enabled: bool = True
    frontend_dist: Path = Field(default=Path("frontend/dist"))
    max_document_bytes: int = Field(default=2_000_000, ge=1_024, le=50_000_000)
    max_pdf_bytes: int = Field(default=100_000_000, ge=1_024, le=1_000_000_000)
    pdf_extraction_shutdown_timeout_seconds: float = Field(default=5.0, ge=0.1, le=60.0)
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
    chat_reasoning_effort: ChatReasoningEffort = "low"
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
        if self.deployment_mode == "production":
            self._validate_production()
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        self.backup_root.mkdir(parents=True, exist_ok=True)

    def _validate_production(self) -> None:
        errors: list[str] = []
        if self.auth_mode == "single_user":
            errors.append("SANGAM_AUTH_MODE must not be single_user")
        if self.auth_mode == "trusted_proxy":
            if not self.trusted_identity_header.strip():
                errors.append("SANGAM_TRUSTED_IDENTITY_HEADER is required")
            if not self.trusted_identity_value.strip():
                errors.append("SANGAM_TRUSTED_IDENTITY_VALUE is required")
        if self.auth_mode == "cloudflare_access":
            if not self.cloudflare_access_team_domain or not _is_https_origin(
                self.cloudflare_access_team_domain
            ):
                errors.append("SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN must be an HTTPS origin")
            if not self.cloudflare_access_audience:
                errors.append("SANGAM_CLOUDFLARE_ACCESS_AUDIENCE is required")
            if not self.cloudflare_access_email:
                errors.append("SANGAM_CLOUDFLARE_ACCESS_EMAIL is required")

        preview_secret = self.preview_hmac_secret.get_secret_value()
        if preview_secret == "development-only-preview-secret-change-me":
            errors.append("SANGAM_PREVIEW_HMAC_SECRET must not use the development default")
        if not _is_https_url(self.publication_base_url):
            errors.append("SANGAM_PUBLICATION_BASE_URL must be an HTTPS URL")
        if not _is_https_url(self.trusted_preview_base_url):
            errors.append("SANGAM_TRUSTED_PREVIEW_BASE_URL must be an HTTPS URL")

        preview_url = urlsplit(self.trusted_preview_base_url)
        publication_url = urlsplit(self.publication_base_url)
        if not self.trusted_preview_host:
            errors.append("SANGAM_TRUSTED_PREVIEW_HOST is required")
        elif preview_url.hostname != self.trusted_preview_host:
            errors.append("SANGAM_TRUSTED_PREVIEW_HOST must match SANGAM_TRUSTED_PREVIEW_BASE_URL")
        elif publication_url.hostname == self.trusted_preview_host:
            errors.append("SANGAM_TRUSTED_PREVIEW_HOST must use an isolated publication origin")
        if not self.trusted_preview_parent_origins:
            errors.append("SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS must not be empty")
        for origin in self.trusted_preview_parent_origins:
            if not _is_https_origin(origin):
                errors.append("SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS entries must be HTTPS origins")
                break
            if urlsplit(origin).hostname == self.trusted_preview_host:
                errors.append("SANGAM_TRUSTED_PREVIEW_HOST must be isolated from parent origins")
                break
        for source in self.trusted_preview_connect_src:
            parsed = urlsplit(source)
            if parsed.scheme not in {"https", "wss"} or not parsed.netloc:
                errors.append("SANGAM_TRUSTED_PREVIEW_CONNECT_SRC entries must use HTTPS or WSS")
                break
        if not self.chatkit_domain_key.strip() or self.chatkit_domain_key == "local-dev":
            errors.append("SANGAM_CHATKIT_DOMAIN_KEY must be a registered production key")
        if self.openrouter_http_referer and not _is_https_origin(self.openrouter_http_referer):
            errors.append("SANGAM_OPENROUTER_HTTP_REFERER must be an HTTPS origin")

        if errors:
            details = "\n- ".join(errors)
            raise ValueError(f"Unsafe production configuration:\n- {details}")

    def chat_server_config(self) -> ChatServerConfig:
        return ChatServerConfig(
            api_key=(
                self.openrouter_api_key.get_secret_value() if self.openrouter_api_key else None
            ),
            base_url=self.openrouter_base_url,
            http_referer=self.openrouter_http_referer,
            app_title=self.openrouter_app_title,
            domain_key=self.chatkit_domain_key,
            available_models=self.chat_available_models,
            default_model=self.chat_default_model,
            reasoning_effort=self.chat_reasoning_effort,
            max_turns=self.chat_max_tool_rounds,
            max_tool_result_bytes=self.chat_max_tool_result_bytes,
            max_context_messages=self.chat_max_context_messages,
            timeout_seconds=self.chat_timeout_seconds,
        )


def _is_https_url(value: str) -> bool:
    parsed = urlsplit(value)
    return (
        parsed.scheme == "https"
        and bool(parsed.netloc)
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
    )


def _is_https_origin(value: str) -> bool:
    parsed = urlsplit(value)
    return (
        parsed.scheme == "https"
        and bool(parsed.netloc)
        and parsed.path in {"", "/"}
        and not parsed.query
        and not parsed.fragment
        and not parsed.username
        and not parsed.password
    )
