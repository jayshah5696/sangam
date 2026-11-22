"""Exercise the syntax and comment boundaries of the project Python checks."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_python_standards.py"


def load_checker():
    spec = importlib.util.spec_from_file_location("python_standards", SCRIPT)
    assert spec is not None and spec.loader is not None
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    return checker


@pytest.mark.parametrize(
    "source",
    [
        "[x for row in rows for x in row]",
        "{x for row in rows for x in row}",
        "{x: x for row in rows for x in row}",
        "sum(x for row in rows for x in row)",
        "[x for x in values if x if valid(x)]",
        "[[x for x in row] for row in rows]",
    ],
)
def test_rejects_complicated_comprehensions(source: str) -> None:
    violations = load_checker().check_source(source)
    assert any(code == "GPC001" for _, _, code, _ in violations)


@pytest.mark.parametrize(
    "source",
    [
        "a if ready else b if pending else c",
        "(a if inner else b) if outer else c",
        "a if (b if inner else c) else d",
    ],
)
def test_rejects_nested_conditional_expressions(source: str) -> None:
    assert any(code == "GPC002" for _, _, code, _ in load_checker().check_source(source))


@pytest.mark.parametrize(
    "source",
    [
        "# Explain what this line does\nvalue = 1\n",
        "value = 1  # inline comment\n",
        "def run():\n    # inside function\n    return 1\n",
    ],
)
def test_rejects_implementation_comments(source: str) -> None:
    violations = load_checker().check_source(source)
    assert any(code == "GPC003" for _, _, code, _ in violations)


@pytest.mark.parametrize(
    "source",
    [
        "[transform(x) for x in values if valid(x)]",
        "{key: value for key, value in pairs}",
        "sum(x for x in values)",
        "a if condition else b",
        "rows = []\nfor row in matrix:\n    rows.append([x for x in row])",
        "value = 'x for row in rows for x in row'",
        "value = '# not a comment inside a string'\n",
        (
            '"""Module docstring explaining intent."""\n'
            'def run() -> int:\n    """Return one."""\n    return 1\n'
        ),
        "#!/usr/bin/env python3\npass\n",
        "try:\n    run()\nexcept Exception:  # noqa: BLE001\n    pass\n",
        "value = fn()  # type: ignore[misc]\n",
        "if False:  # pragma: no cover\n    pass\n",
        "# fmt: off\nx = 1\n# fmt: on\n",
        "# ruff: noqa: E501\nx = 1\n",
        "# pyright: ignore[reportGeneralTypeIssues]\nx = 1\n",
        "# mypy: disable-error-code=misc\nx = 1\n",
        "def first():\n    return a if ready else b\ndef second():\n    return c if ready else d",
    ],
)
def test_accepts_simple_expressions_docstrings_and_directives(source: str) -> None:
    assert load_checker().check_source(source) == []


def test_comment_does_not_trigger_comprehension_rule() -> None:
    violations = load_checker().check_source("# [x for row in rows for x in row]\npass\n")
    codes = [code for _, _, code, _ in violations]
    assert "GPC001" not in codes
    assert codes == ["GPC003"]


def test_comment_ratchet_enforces_exact_budget_and_tightening(tmp_path: Path) -> None:
    target = tmp_path / "legacy.py"
    ratchet = tmp_path / "comment-ratchet.json"
    target.write_text("# first\n# second\nx = 1\n", encoding="utf-8")
    ratchet.write_text(json.dumps({"files": {target.as_posix(): 2}}), encoding="utf-8")

    at_budget = subprocess.run(
        [sys.executable, str(SCRIPT), "--ratchet", str(ratchet), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert at_budget.returncode == 0, at_budget.stdout

    target.write_text("# first\n# second\n# third\nx = 1\n", encoding="utf-8")
    above_budget = subprocess.run(
        [sys.executable, str(SCRIPT), "--ratchet", str(ratchet), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert above_budget.returncode == 1
    assert "GPC003" in above_budget.stdout

    target.write_text("# first\nx = 1\n", encoding="utf-8")
    below_budget = subprocess.run(
        [sys.executable, str(SCRIPT), "--ratchet", str(ratchet), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert below_budget.returncode == 1
    assert "below ratchet budget 2" in below_budget.stdout

    ratchet.write_text(
        json.dumps({"files": {target.as_posix(): 1, "missing.py": 1}}), encoding="utf-8"
    )
    stale_entry = subprocess.run(
        [sys.executable, str(SCRIPT), "--ratchet", str(ratchet), str(target)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert stale_entry.returncode == 1
    assert "Stale ratchet entry" in stale_entry.stdout


def test_cli_reports_location_and_nonzero_exit_for_invalid_source(tmp_path: Path) -> None:
    source = tmp_path / "invalid.py"
    source.write_text("items = [x for row in rows for x in row]\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(source)], capture_output=True, text=True, check=False
    )
    assert result.returncode == 1
    assert f"{source}:1:9: GPC001" in result.stdout


def test_cli_rejects_invalid_python_without_a_traceback(tmp_path: Path) -> None:
    source = tmp_path / "invalid.py"
    source.write_text("def broken(\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(source)], capture_output=True, text=True, check=False
    )
    assert result.returncode == 1
    assert "GPC000" in result.stdout
    assert "Traceback" not in result.stderr
