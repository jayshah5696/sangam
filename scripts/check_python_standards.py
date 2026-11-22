"""Check Python readability and comment rules that Ruff does not provide.

GPC001 follows Google Python style guide section 2.7. GPC002 makes the
simple-expression guidance in section 2.11 concrete for Sangam. GPC003 bans
implementation comments while allowing docstrings, tool directives, and a
per-file ratchet baseline.
"""

from __future__ import annotations

import ast
import io
import json
import sys
import tokenize
from collections.abc import Sequence
from pathlib import Path

type Violation = tuple[int, int, str, str]

_COMPREHENSIONS = (ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp)
_DIRECTIVE_PREFIXES = (
    "# noqa",
    "# type:",
    "# pyright:",
    "# mypy:",
    "# pragma:",
    "# fmt:",
    "# ruff:",
)
_DEFAULT_RATCHET = Path(__file__).resolve().with_name("comment-ratchet.json")


def is_directive_comment(comment_text: str, *, line_number: int) -> bool:
    """Return True when a Python comment token is a supported machine directive."""
    stripped = comment_text.strip()
    if line_number == 1 and stripped.startswith("#!"):
        return True
    lower = stripped.lower()
    return any(lower.startswith(prefix) for prefix in _DIRECTIVE_PREFIXES)


def load_comment_ratchet(ratchet_path: Path) -> dict[str, int]:
    """Load the per-file comment ratchet map from JSON."""
    payload = json.loads(ratchet_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or not isinstance(payload.get("files"), dict):
        raise ValueError(f"Invalid comment ratchet schema in {ratchet_path}")
    budgets: dict[str, int] = {}
    for key, value in payload["files"].items():
        if (
            not isinstance(key, str)
            or isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
        ):
            raise ValueError(f"Invalid comment ratchet entry {key!r}: {value!r}")
        budgets[key] = value
    return budgets


def _check_comments(source: str, *, allowed_comments: int, ratchet_label: str) -> list[Violation]:
    disallowed: list[tuple[int, int]] = []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type == tokenize.COMMENT and not is_directive_comment(
            token.string, line_number=token.start[0]
        ):
            disallowed.append((token.start[0], token.start[1] + 1))

    violations: list[Violation] = []
    if len(disallowed) > allowed_comments:
        for line, column in disallowed[allowed_comments:]:
            violations.append(
                (
                    line,
                    column,
                    "GPC003",
                    "Delete implementation comments; move decisions to docs/adr/ "
                    "or file an issue for workarounds.",
                )
            )
    elif allowed_comments > 0 and len(disallowed) < allowed_comments:
        violations.append(
            (
                1,
                1,
                "GPC003",
                f"File has {len(disallowed)} implementation comments, below ratchet budget "
                f"{allowed_comments}; lower or remove its entry in {ratchet_label}.",
            )
        )
    return violations


def check_source(
    source: str,
    *,
    allowed_comments: int = 0,
    ratchet_label: str = "scripts/comment-ratchet.json",
) -> list[Violation]:
    """Return source locations and rule codes for invalid expressions, comments, or syntax."""
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
                        "Use a loop instead of multiple clauses or nested comprehensions.",
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
    try:
        violations.extend(
            _check_comments(source, allowed_comments=allowed_comments, ratchet_label=ratchet_label)
        )
    except tokenize.TokenError as error:
        line, column = error.args[1] if len(error.args) > 1 else (1, 0)
        violations.append((line, column + 1, "GPC000", str(error.args[0])))
    return sorted(violations)


def _ratchet_key(path: Path, base_dir: Path) -> str:
    try:
        return path.resolve().relative_to(base_dir.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def main(argv: Sequence[str]) -> int:
    """Check explicit paths, or the application, scripts, and tests by default."""
    ratchet_path: Path | None = None
    raw_paths: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == "--ratchet" and index + 1 < len(argv):
            ratchet_path = Path(argv[index + 1])
            index += 2
            continue
        raw_paths.append(arg)
        index += 1

    using_default_roots = not raw_paths
    roots = (
        [Path(path) for path in raw_paths]
        if raw_paths
        else [Path("src"), Path("scripts"), Path("tests")]
    )
    active_ratchet_path = ratchet_path or (_DEFAULT_RATCHET if using_default_roots else None)
    ratchet_label = (
        str(active_ratchet_path) if active_ratchet_path else "scripts/comment-ratchet.json"
    )
    budgets: dict[str, int] = {}
    if active_ratchet_path is not None and active_ratchet_path.exists():
        try:
            budgets = load_comment_ratchet(active_ratchet_path)
        except (OSError, ValueError, json.JSONDecodeError) as error:
            print(f"{active_ratchet_path}:1:1: GPC000 {error}")
            return 1

    base_dir = Path.cwd()
    files: set[Path] = set()
    for root in roots:
        if root.is_dir():
            files.update(root.rglob("*.py"))
        else:
            files.add(root)

    seen_keys: set[str] = set()
    failed = False
    for path in sorted(files):
        key = _ratchet_key(path, base_dir)
        seen_keys.add(key)
        allowed = budgets.get(key, 0)
        try:
            violations = check_source(
                path.read_text(encoding="utf-8"),
                allowed_comments=allowed,
                ratchet_label=ratchet_label,
            )
        except (OSError, UnicodeError) as error:
            violations = [(1, 1, "GPC000", str(error))]
        for line, column, code, message in violations:
            print(f"{path}:{line}:{column}: {code} {message}")
            failed = True

    if active_ratchet_path is not None and (using_default_roots or ratchet_path is not None):
        for stale_key in sorted(set(budgets) - seen_keys):
            print(
                f"{active_ratchet_path}:1:1: GPC003 "
                f"Stale ratchet entry for {stale_key!r}; remove it."
            )
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
