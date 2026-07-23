from __future__ import annotations

import re
from pathlib import Path

from sangam.config import Settings

ROOT = Path(__file__).resolve().parents[1]
ENVIRONMENT_NAME = re.compile(r"^\s{6}(SANGAM_[A-Z0-9_]+):", re.MULTILINE)
ENV_FILE_NAME = re.compile(r"^(SANGAM_[A-Z0-9_]+)=", re.MULTILINE)


def main() -> None:
    expected = {f"SANGAM_{name.upper()}" for name in Settings.model_fields}
    inventories = {
        ".env.example": set(ENV_FILE_NAME.findall((ROOT / ".env.example").read_text())),
        "compose.yaml": set(ENVIRONMENT_NAME.findall((ROOT / "compose.yaml").read_text())),
        "deploy/compose.prod.yaml": set(
            ENVIRONMENT_NAME.findall((ROOT / "deploy/compose.prod.yaml").read_text())
        ),
    }
    failed = False
    for label, actual in inventories.items():
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        if missing or extra:
            failed = True
            print(f"{label} does not match sangam.config.Settings:")
            if missing:
                print(f"  missing: {', '.join(missing)}")
            if extra:
                print(f"  unknown: {', '.join(extra)}")
    if failed:
        raise SystemExit(1)
    print(f"Release configuration inventory passed: {len(expected)} settings in all surfaces.")


if __name__ == "__main__":
    main()
