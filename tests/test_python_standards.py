"""Exercise the syntax boundaries of the Google-derived Python checks."""

import importlib.util
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
        "[transform(x) for x in values if valid(x)]",
        "{key: value for key, value in pairs}",
        "sum(x for x in values)",
        "a if condition else b",
        "rows = []\nfor row in matrix:\n    rows.append([x for x in row])",
        "value = 'x for row in rows for x in row'",
        "# [x for row in rows for x in row]\npass",
        "def first():\n    return a if ready else b\ndef second():\n    return c if ready else d",
    ],
)
def test_accepts_simple_independent_expressions(source: str) -> None:
    assert load_checker().check_source(source) == []


def test_cli_reports_location_and_nonzero_exit_for_invalid_source(tmp_path: Path) -> None:
    source = tmp_path / "invalid.py"
    source.write_text("items = [x for row in rows for x in row]\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(source)], capture_output=True, text=True
    )
    assert result.returncode == 1
    assert f"{source}:1:9: GPC001" in result.stdout


def test_cli_rejects_invalid_python_without_a_traceback(tmp_path: Path) -> None:
    source = tmp_path / "invalid.py"
    source.write_text("def broken(\n", encoding="utf-8")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), str(source)], capture_output=True, text=True
    )
    assert result.returncode == 1
    assert "GPC000" in result.stdout
    assert "Traceback" not in result.stderr
