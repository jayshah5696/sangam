"""Wait until the required CI checks are green for one exact commit.

The tag workflow uses this instead of re-running the test suite that CI already ran on the
same commit. It fails closed: a missing, failed, cancelled, or timed-out check blocks the
release. Re-run or re-dispatch CI for the commit and run the release workflow again.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict

# Branch protection requires these names, so a green set means the commit passed CI.
REQUIRED_CHECKS = (
    "Source, UI, and docs",
    "Wheel and sdist clean install",
    "Container, Compose, and blocking scan",
)


class CheckRun(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str
    status: str
    conclusion: str | None = None
    started_at: str | None = None


@dataclass(frozen=True)
class Verdict:
    state: Literal["passed", "failed", "waiting"]
    detail: str


def evaluate(runs: Sequence[CheckRun], required: Sequence[str] = REQUIRED_CHECKS) -> Verdict:
    """Judge the newest run of each required check; a re-run replaces an older failure."""
    newest: dict[str, CheckRun] = {}
    for run in runs:
        current = newest.get(run.name)
        if current is None or (run.started_at or "") >= (current.started_at or ""):
            newest[run.name] = run

    failed: list[str] = []
    waiting: list[str] = []
    for name in required:
        run = newest.get(name)
        if run is None:
            waiting.append(f"{name} (not started)")
        elif run.status != "completed":
            waiting.append(f"{name} ({run.status})")
        elif run.conclusion != "success":
            failed.append(f"{name} ({run.conclusion})")

    if failed:
        return Verdict("failed", "Required checks did not pass: " + ", ".join(failed))
    if waiting:
        return Verdict("waiting", "Waiting for: " + ", ".join(waiting))
    return Verdict("passed", "All required checks passed: " + ", ".join(required))


def fetch_check_runs(repository: str, sha: str) -> list[CheckRun]:
    output = subprocess.run(
        [
            "gh",
            "api",
            "--paginate",
            f"repos/{repository}/commits/{sha}/check-runs?per_page=100",
            "--jq",
            ".check_runs[] | {name, status, conclusion, started_at}",
        ],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    return [CheckRun.model_validate(json.loads(line)) for line in output.splitlines() if line]


def wait_for_ci(
    repository: str,
    sha: str,
    *,
    timeout_seconds: float,
    poll_seconds: float,
    required: Sequence[str] = REQUIRED_CHECKS,
    fetch: Callable[[str, str], list[CheckRun]] = fetch_check_runs,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> Verdict:
    deadline = clock() + timeout_seconds
    while True:
        verdict = evaluate(fetch(repository, sha), required)
        print(f"[{sha[:12]}] {verdict.state}: {verdict.detail}", flush=True)
        if verdict.state != "waiting":
            return verdict
        if clock() + poll_seconds > deadline:
            return Verdict("failed", f"Timed out. {verdict.detail}")
        sleep(poll_seconds)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True, help="owner/name")
    parser.add_argument("--sha", required=True, help="full commit SHA the tag points to")
    parser.add_argument("--timeout-minutes", type=float, default=45)
    parser.add_argument("--poll-seconds", type=float, default=30)
    args = parser.parse_args()

    verdict = wait_for_ci(
        args.repository,
        args.sha,
        timeout_seconds=args.timeout_minutes * 60,
        poll_seconds=args.poll_seconds,
    )
    if verdict.state != "passed":
        raise SystemExit(
            f"{verdict.detail}\nRun CI for this commit (workflow_dispatch on ci.yml) "
            "and re-run the release workflow."
        )


if __name__ == "__main__":
    main()
