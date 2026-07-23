from __future__ import annotations

import sqlite3
import tempfile
from importlib import resources
from importlib.metadata import version
from pathlib import Path

from fastapi.testclient import TestClient

from sangam import __version__
from sangam.api import create_app
from sangam.config import Settings


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="sangam-installed-smoke-") as temporary:
        root = Path(temporary)
        settings = Settings(
            database_path=root / "database" / "sangam.sqlite3",
            workspace_root=root / "workspace",
            backup_root=root / "backups",
            frontend_dist=root / "frontend",
            backups_enabled=False,
        )
        app = create_app(settings)
        migration_files = sorted(resources.files("sangam.migrations").glob("*.sql"))
        with sqlite3.connect(settings.database_path) as connection:
            applied = connection.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]

        assert version("sangam") == __version__ == app.version
        assert migration_files
        assert applied == len(migration_files)
        assert app.openapi()["info"]["version"] == __version__
        with TestClient(app) as client:
            assert client.get("/api/v1/health").json() == {
                "status": "ok",
                "version": __version__,
            }
        print(
            f"Installed Sangam {__version__}: CLI import, API construction, "
            f"and {applied} packaged migrations passed."
        )


if __name__ == "__main__":
    main()
