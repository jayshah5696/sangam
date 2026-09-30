from __future__ import annotations

import argparse
import hashlib
import json
import tempfile
from datetime import date
from pathlib import Path

from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings
from sangam.openapi_compatibility import compare_contracts

ROOT = Path(__file__).resolve().parents[1]
FINGERPRINT = ROOT / "frontend" / "src" / "generated" / "openapi.sha256"
BASELINE = ROOT / "docs" / "api" / "openapi-baseline.json"


def contract_digest(document: dict | None = None) -> str:
    payload = json.dumps(
        document if document is not None else _openapi_document(),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode()
    return hashlib.sha256(payload).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compare generated OpenAPI against the reviewed compatibility baseline."
    )
    parser.add_argument("--print", action="store_true", dest="print_digest")
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="accept the current schema as the reviewed baseline (requires --reason)",
    )
    parser.add_argument(
        "--reason",
        help="review reference or rationale recorded in the baseline, such as a PR number",
    )
    args = parser.parse_args()
    document = _openapi_document()
    actual = contract_digest(document)
    if args.print_digest:
        print(actual)
        return
    if args.update_baseline:
        reason = (args.reason or "").strip()
        if not reason:
            parser.error("--update-baseline requires a non-empty --reason")
        payload = document
        payload["x-sangam-baseline-review"] = {"date": date.today().isoformat(), "reason": reason}
        BASELINE.parent.mkdir(parents=True, exist_ok=True)
        BASELINE.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        FINGERPRINT.write_text(actual + "\n", encoding="utf-8")
        print(f"Accepted OpenAPI baseline {actual}: {reason}")
        return

    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    changes = compare_contracts(baseline, document)
    for change in changes:
        print(f"{change.classification.upper():10} {change.location}: {change.message}")
    blocking = [change for change in changes if change.classification in {"breaking", "review"}]
    if blocking:
        print(
            "\nOpenAPI compatibility check failed. Review the changes, update frontend boundary "
            "validation as needed, then accept an intentional contract change with "
            "--update-baseline --reason."
        )
        raise SystemExit(1)
    expected = FINGERPRINT.read_text(encoding="utf-8").strip()
    if actual != expected:
        print(f"OpenAPI digest changed: {expected} -> {actual}")
        print(
            "Review the complete baseline diff, then use --update-baseline --reason. "
            "The classifier does not cover every OpenAPI feature."
        )
        raise SystemExit(1)
    else:
        print(f"OpenAPI contract matches the reviewed baseline: {actual}")


def _openapi_document() -> dict:
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
        with TestClient(app):
            return app.openapi()


if __name__ == "__main__":
    main()
