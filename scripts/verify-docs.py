"""Verify canonical Markdown links, Mermaid fences, repo paths, and just recipes."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
LINK = re.compile(r"!?\[[^\]]*]\(([^)\s]+)(?:\s+['\"].*?['\"])?\)")
EXTERNAL_PREFIXES = ("http://", "https://", "mailto:", "sangam://")
DEVELOPER_HOME_PATH = re.compile(r"(?:/Users/[A-Za-z0-9._-]+/|/home/[A-Za-z0-9._-]+/)")
REPO_PATH = re.compile(
    r"`((?:src/sangam|frontend/(?:src|e2e|scripts|tools|public|patches)"
    r"|scripts|tests|docs/(?:adr|api|operations|assets)"
    r"|\.agents/skills|\.github/workflows)/[A-Za-z0-9_./\-]+)`"
)
DOC_PATH = re.compile(r"`(docs/[A-Za-z0-9_./\-]+\.md)`")
JUST_COMMAND = re.compile(r"`just\s+([a-z][a-z0-9_-]+)(?:\s[^`]*)?`")
JUST_RECIPE = re.compile(r"^([a-zA-Z0-9][a-zA-Z0-9_-]*)(?:\s+[^:]*)?:(?!=)")


def load_just_recipes(root: Path = ROOT) -> set[str]:
    """Return every recipe name defined in the root justfile."""
    justfile = root / "justfile"
    if not justfile.exists():
        return set()
    recipes: set[str] = set()
    for line in justfile.read_text(encoding="utf-8").splitlines():
        match = JUST_RECIPE.match(line)
        if match:
            recipes.add(match.group(1))
    return recipes


def canonical_markdown_files(root: Path = ROOT) -> list[Path]:
    """Return all tracked canonical Markdown files checked for stale references."""
    top_level = [
        root / name
        for name in ("README.md", "AGENTS.md", "DESIGN.md", "PRODUCT.md", "SECURITY.md")
        if (root / name).exists()
    ]
    docs_files = sorted((root / "docs").rglob("*.md")) if (root / "docs").exists() else []
    skill_files = (
        sorted((root / ".agents" / "skills").rglob("*.md"))
        if (root / ".agents" / "skills").exists()
        else []
    )
    return [*top_level, *docs_files, *skill_files]


def verify_file(
    path: Path,
    *,
    root: Path = ROOT,
    recipes: set[str] | None = None,
) -> list[str]:
    """Return every broken link, stale reference, home path, or invalid Mermaid fence in a file."""
    errors: list[str] = []
    content = path.read_text(encoding="utf-8")
    relative = path.relative_to(root)
    rel_posix = relative.as_posix()
    known_recipes = load_just_recipes(root) if recipes is None else recipes

    for match in LINK.finditer(content):
        target = unquote(match.group(1))
        if target.startswith(EXTERNAL_PREFIXES) or target.startswith("#"):
            continue
        local_path = target.split("#", 1)[0].split("?", 1)[0]
        if not local_path:
            continue
        resolved = (path.parent / local_path).resolve(strict=False)
        if not resolved.is_relative_to(root.resolve()) or not resolved.exists():
            line = content.count("\n", 0, match.start()) + 1
            errors.append(f"{relative}:{line}: broken local link: {target}")

    in_mermaid = False
    mermaid_start = 0
    mermaid_lines: list[str] = []
    for line_number, line in enumerate(content.splitlines(), start=1):
        if not in_mermaid and line.strip() == "```mermaid":
            in_mermaid = True
            mermaid_start = line_number
            mermaid_lines = []
        elif in_mermaid and line.strip() == "```":
            if not any(item.strip() for item in mermaid_lines):
                errors.append(f"{relative}:{mermaid_start}: empty Mermaid diagram")
            in_mermaid = False
        elif in_mermaid:
            mermaid_lines.append(line)

        if DEVELOPER_HOME_PATH.search(line):
            errors.append(
                f"{relative}:{line_number}: hardcoded developer home path; "
                "use a portable placeholder"
            )

        for match in REPO_PATH.finditer(line):
            candidate = match.group(1).rstrip(".,:)")
            if any(char in candidate for char in ("*", "<", ">", "{", "}")) or candidate.endswith(
                "/"
            ):
                continue
            if not (root / candidate).exists():
                errors.append(
                    f"{relative}:{line_number}: missing repository path reference: `{candidate}`"
                )

        if not rel_posix.startswith(".agents/skills/verify-sangam/features/"):
            for match in DOC_PATH.finditer(line):
                candidate = match.group(1)
                if "*" not in candidate and not (root / candidate).exists():
                    errors.append(
                        f"{relative}:{line_number}: missing documentation path "
                        f"reference: `{candidate}`"
                    )

        if known_recipes:
            for match in JUST_COMMAND.finditer(line):
                recipe = match.group(1)
                if recipe not in known_recipes:
                    errors.append(
                        f"{relative}:{line_number}: unknown just recipe reference: `just {recipe}`"
                    )

    if in_mermaid:
        errors.append(f"{relative}:{mermaid_start}: unclosed Mermaid fence")
    return errors


def main() -> int:
    """Validate all canonical Markdown documentation files in the repository."""
    files = canonical_markdown_files(ROOT)
    recipes = load_just_recipes(ROOT)
    errors: list[str] = []
    for path in files:
        errors.extend(verify_file(path, root=ROOT, recipes=recipes))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(
        f"Verified {len(files)} Markdown files: local links, repo references, "
        "just recipes, and Mermaid fences are valid."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
