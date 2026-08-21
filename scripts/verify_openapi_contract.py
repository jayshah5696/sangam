from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from pathlib import Path

from sangam.api import create_app
from sangam.config import Settings

ROOT = Path(__file__).resolve().parents[1]
FINGERPRINT = ROOT / "frontend" / "src" / "generated" / "openapi.sha256"


def contract_digest() -> str:
    with tempfile.TemporaryDirectory(prefix="sangam-openapi-") as directory:
        root = Path(directory)
        app = create_app(
            Settings(
                database_path=root / "sangam.sqlite3",
                workspace_root=root / "workspace",
                backup_root=root / "backups",
                frontend_dist=root / "dist",
                backups_enabled=False,
            )
        )
        payload = json.dumps(
            app.openapi(), sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ).encode()
    return hashlib.sha256(payload).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Fail when Sangam OpenAPI changes without a reviewed frontend contract update."
    )
    parser.add_argument("--print", action="store_true", dest="print_digest")
    args = parser.parse_args()
    actual = contract_digest()
    if args.print_digest:
        print(actual)
        return
    expected = FINGERPRINT.read_text(encoding="utf-8").strip()
    if actual != expected:
        raise SystemExit(
            "OpenAPI contract drifted. Review frontend API parsing, then update "
            f"{FINGERPRINT.relative_to(ROOT)} to {actual}."
        )
    print(f"OpenAPI contract: {actual}")


if __name__ == "__main__":
    main()
