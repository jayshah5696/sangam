from __future__ import annotations

import argparse
import json
import tomllib
from pathlib import Path

from sangam import __version__

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify Sangam release version propagation")
    parser.add_argument("--expected")
    parser.add_argument("--frontend-dist", action="store_true")
    args = parser.parse_args()

    metadata = tomllib.loads((ROOT / "pyproject.toml").read_text())
    canonical = metadata["project"]["version"]
    expected = args.expected.removeprefix("v") if args.expected else canonical
    if canonical != expected:
        raise SystemExit(f"pyproject version {canonical!r} does not match {expected!r}")
    if __version__ != canonical:
        raise SystemExit(f"installed package version {__version__!r} does not match {canonical!r}")
    if "version" in json.loads((ROOT / "frontend/package.json").read_text()):
        raise SystemExit("frontend/package.json must not define a second application version")
    if args.frontend_dist:
        manifest = json.loads((ROOT / "frontend/dist/version.json").read_text())
        if manifest != {"version": canonical}:
            raise SystemExit(f"frontend version manifest does not match {canonical!r}")
    print(f"Sangam version propagation passed: {canonical}")


if __name__ == "__main__":
    main()
