from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "wait_for_ci.py"
spec = importlib.util.spec_from_file_location("wait_for_ci", SCRIPT)
assert spec is not None and spec.loader is not None
wait_for_ci = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = wait_for_ci
spec.loader.exec_module(wait_for_ci)

REQUIRED = ("a", "b")


def run(name: str, status: str = "completed", conclusion: str | None = "success", at: str = "1"):
    return wait_for_ci.CheckRun(
        name=name, status=status, conclusion=conclusion, started_at=f"2026-10-10T00:00:0{at}Z"
    )


def test_passes_only_when_every_required_check_succeeded() -> None:
    verdict = wait_for_ci.evaluate(
        [run("a"), run("b"), run("unrelated", conclusion="failure")], REQUIRED
    )

    assert verdict.state == "passed"


def test_missing_or_running_checks_keep_waiting() -> None:
    assert wait_for_ci.evaluate([run("a")], REQUIRED).state == "waiting"
    running = run("b", status="in_progress", conclusion=None)
    assert wait_for_ci.evaluate([run("a"), running], REQUIRED).state == "waiting"


def test_failure_cancellation_and_skip_block_the_release() -> None:
    for conclusion in ("failure", "cancelled", "skipped", "timed_out", None):
        verdict = wait_for_ci.evaluate([run("a"), run("b", conclusion=conclusion)], REQUIRED)
        assert verdict.state == "failed", conclusion


def test_failure_wins_over_other_pending_checks() -> None:
    verdict = wait_for_ci.evaluate([run("a", conclusion="failure")], REQUIRED)

    assert verdict.state == "failed"


def test_a_newer_rerun_replaces_an_older_failure_and_never_the_reverse() -> None:
    rerun = [run("a", conclusion="failure", at="1"), run("a", at="2"), run("b")]
    assert wait_for_ci.evaluate(rerun, REQUIRED).state == "passed"

    regression = [run("a", at="1"), run("a", conclusion="failure", at="2"), run("b")]
    assert wait_for_ci.evaluate(regression, REQUIRED).state == "failed"


def test_wait_polls_until_checks_finish_then_stops() -> None:
    responses = [
        [run("a")],
        [run("a"), run("b", status="queued", conclusion=None)],
        [run("a"), run("b")],
    ]
    sleeps: list[float] = []

    verdict = wait_for_ci.wait_for_ci(
        "o/r",
        "abc",
        timeout_seconds=600,
        poll_seconds=30,
        required=REQUIRED,
        fetch=lambda _repository, _sha: responses.pop(0),
        sleep=sleeps.append,
        clock=lambda: 0.0,
    )

    assert verdict.state == "passed"
    assert sleeps == [30, 30]


def test_wait_times_out_closed() -> None:
    ticks = iter(range(0, 10_000, 100))

    verdict = wait_for_ci.wait_for_ci(
        "o/r",
        "abc",
        timeout_seconds=250,
        poll_seconds=100,
        required=REQUIRED,
        fetch=lambda _repository, _sha: [run("a")],
        sleep=lambda _seconds: None,
        clock=lambda: float(next(ticks)),
    )

    assert verdict.state == "failed"
    assert verdict.detail.startswith("Timed out.")
