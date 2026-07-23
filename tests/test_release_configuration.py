from __future__ import annotations

from pathlib import Path

import pytest

from sangam.config import Settings


def production_settings(tmp_path: Path, **overrides: object) -> Settings:
    values: dict[str, object] = {
        "deployment_mode": "production",
        "database_path": tmp_path / "database" / "sangam.sqlite3",
        "workspace_root": tmp_path / "workspace",
        "backup_root": tmp_path / "backups",
        "auth_mode": "cloudflare_access",
        "cloudflare_access_team_domain": "https://team.cloudflareaccess.com",
        "cloudflare_access_audience": "production-audience",
        "cloudflare_access_email": "owner@example.com",
        "preview_hmac_secret": "a-unique-production-preview-secret-000000000000000000",
        "publication_base_url": "https://docs.example.com/p",
        "trusted_preview_base_url": "https://preview.example.com/trusted-preview",
        "trusted_preview_host": "preview.example.com",
        "trusted_preview_parent_origins": ("https://sangam.example.com",),
        "chatkit_domain_key": "domain_pk_production",
    }
    values.update(overrides)
    return Settings(**values)  # type: ignore[arg-type]


def test_production_configuration_accepts_explicit_secure_values(tmp_path: Path) -> None:
    settings = production_settings(tmp_path)

    settings.prepare()

    assert settings.database_path.parent.is_dir()
    assert settings.workspace_root.is_dir()
    assert settings.backup_root.is_dir()


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"auth_mode": "single_user"}, "AUTH_MODE"),
        ({"cloudflare_access_team_domain": "http://team.example.com"}, "TEAM_DOMAIN"),
        ({"cloudflare_access_audience": None}, "AUDIENCE"),
        ({"cloudflare_access_email": None}, "EMAIL"),
        (
            {"preview_hmac_secret": "development-only-preview-secret-change-me"},
            "PREVIEW_HMAC_SECRET",
        ),
        ({"publication_base_url": "http://docs.example.com/p"}, "PUBLICATION_BASE_URL"),
        (
            {"trusted_preview_base_url": "http://preview.example.com/trusted-preview"},
            "TRUSTED_PREVIEW_BASE_URL",
        ),
        ({"trusted_preview_host": None}, "TRUSTED_PREVIEW_HOST"),
        (
            {"trusted_preview_parent_origins": ("http://sangam.example.com",)},
            "PARENT_ORIGINS",
        ),
        (
            {"trusted_preview_parent_origins": ("https://preview.example.com",)},
            "isolated from parent",
        ),
        ({"trusted_preview_connect_src": ("http://api.example.com",)}, "CONNECT_SRC"),
        ({"chatkit_domain_key": "local-dev"}, "CHATKIT_DOMAIN_KEY"),
        ({"openrouter_http_referer": "http://sangam.example.com"}, "HTTP_REFERER"),
    ],
)
def test_production_configuration_rejects_unsafe_values(
    tmp_path: Path, overrides: dict[str, object], message: str
) -> None:
    settings = production_settings(tmp_path, **overrides)

    with pytest.raises(ValueError, match=message):
        settings.prepare()


def test_development_configuration_keeps_local_defaults(tmp_path: Path) -> None:
    settings = Settings(
        database_path=tmp_path / "database" / "sangam.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
    )

    settings.prepare()

    assert settings.deployment_mode == "development"
