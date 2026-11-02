"""Check Python expression readability rules that Ruff does not provide.

GPC001 follows Google Python style guide section 2.7. GPC002 makes the
simple-expression guidance in section 2.11 concrete for Sangam. Both rules
inspect syntax, including comprehensions nested inside other comprehensions.
"""

from __future__ import annotations

import ast
import sys
from collections.abc import Sequence
from pathlib import Path

type Violation = tuple[int, int, str, str]

_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)


def check_source(source: str) -> list[Violation]:
    """Return source locations and rule codes for invalid expressions or syntax."""
    try:
        tree = ast.parse(source)
    except SyntaxError as error:
        return [(error.lineno or 1, error.offset or 1, "GPC000", error.msg)]

    violations: list[Violation] = []
    for node in ast.walk(tree):
        if isinstance(node, _COMPREHENSIONS):
            nested = any(
                isinstance(child, _COMPREHENSIONS) for child in ast.walk(node) if child is not node
            )
            if (
                len(node.generators) > 1
                or sum(len(item.ifs) for item in node.generators) > 1
                or nested
            ):
                violations.append(
                    (
                        node.lineno,
                        node.col_offset + 1,
                        "GPC001",
                        "Use a loop instead of multiple for/filter clauses or nested comprehensions.",
                    )
                )
        elif isinstance(node, ast.IfExp):
            if any(isinstance(child, ast.IfExp) for child in ast.walk(node) if child is not node):
                violations.append(
                    (
                        node.lineno,
                        node.col_offset + 1,
                        "GPC002",
                        "Use if/elif/else instead of nested conditional expressions.",
                    )
                )
    return sorted(violations)


def main(paths: Sequence[str]) -> int:
    """Check explicit paths, or the application, scripts, and tests by default."""
    roots = (
        [Path(path) for path in paths] if paths else [Path("src"), Path("scripts"), Path("tests")]
    )
    files: set[Path] = set()
    for root in roots:
        if root.is_dir():
            files.update(root.rglob("*.py"))
        else:
            files.add(root)
    failed = False
    for path in sorted(files):
        try:
            violations = check_source(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError) as error:
            violations = [(1, 1, "GPC000", str(error))]
        for line, column, code, message in violations:
            print(f"{path}:{line}:{column}: {code} {message}")
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
