"""Compare cold-process healthy startup with repairing the complete same corpus."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings


def settings(root: Path) -> Settings:
    return Settings(
        database_path=root / "database.sqlite3",
        workspace_root=root / "workspace",
        backup_root=root / "backups",
        frontend_dist=root / "no-frontend",
        backups_enabled=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--count", type=int, default=250)
    parser.add_argument("--measure-root", type=Path)
    parser.add_argument("--seed-root", type=Path)
    parser.add_argument("--baseline-source", type=Path)
    args = parser.parse_args()
    if args.measure_root:
        start = time.perf_counter()
        with TestClient(create_app(settings(args.measure_root))) as client:
            response = client.get("/api/v1/readiness")
            response.raise_for_status()
            elapsed = (time.perf_counter() - start) * 1000
        print(json.dumps({"startup_ms": elapsed}))
        return
    if args.count < 1:
        parser.error("count must be positive")
    if args.seed_root:
        seed(args.seed_root, args.count)
        return
    if args.baseline_source:
        source = args.baseline_source.resolve()
        if not (source / "src/sangam").is_dir():
            parser.error("baseline source must contain src/sangam")
        baseline_environment = {**os.environ, "PYTHONPATH": str(source / "src")}
        with tempfile.TemporaryDirectory(prefix="sangam-search-before-after-") as temporary:
            root = Path(temporary)
            before = root / "before"
            before.mkdir()
            subprocess.run(
                [sys.executable, __file__, "--seed-root", str(before), "--count", str(args.count)],
                env=baseline_environment,
                check=True,
                timeout=120,
            )
            after = root / "after"
            shutil.copytree(before, after)
            # Exclude the one-time migration repair from healthy-startup samples.
            measure(after)
            samples = {
                "main_full_rebuild": [measure(before, baseline_environment) for _ in range(3)],
                "incremental_healthy": [measure(after) for _ in range(3)],
            }
        baseline_commit = subprocess.check_output(
            ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
        ).strip()
        report = {
            "documents": args.count,
            "content_bytes_per_document": len("searchable text\n" * 256),
            "baseline_commit": baseline_commit,
            "cold_process_startup_ms": samples,
            "comparison": (
                "Main full rebuild versus this branch after its one-time migration repair."
            ),
        }
        save_report(report, "artifacts/search-startup-before-after.json")
        return
    with tempfile.TemporaryDirectory(prefix="sangam-search-startup-") as temporary:
        root = Path(temporary)
        seed(root, args.count)
        samples: dict[str, list[float]] = {"healthy": [], "full_repair": []}
        for _ in range(3):
            for mode in samples:
                if mode == "full_repair":
                    with sqlite3.connect(root / "database.sqlite3") as connection:
                        connection.execute(
                            "INSERT OR IGNORE INTO search_dirty_documents "
                            "SELECT document_id FROM documents"
                        )
                samples[mode].append(measure(root))
        report = {
            "documents": args.count,
            "content_bytes_per_document": len("searchable text\n" * 256),
            "cold_process_startup_ms": samples,
            "comparison": (
                "Healthy startup versus forcing every document to need repair in this build; "
                "not a previous-release benchmark."
            ),
        }
        save_report(report, "artifacts/search-startup.json")


def seed(root: Path, count: int) -> None:
    with TestClient(create_app(settings(root))) as client:
        for index in range(count):
            response = client.post(
                "/api/v1/documents",
                json={"title": f"Note {index}", "content": "searchable text\n" * 256},
                headers={"Idempotency-Key": f"seed-{index}"},
            )
            response.raise_for_status()


def measure(root: Path, environment: dict[str, str] | None = None) -> float:
    result = subprocess.run(
        [sys.executable, __file__, "--measure-root", str(root)],
        env=environment,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    return json.loads(result.stdout)["startup_ms"]


def save_report(report: dict, destination: str) -> None:
    output = Path(destination)
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
