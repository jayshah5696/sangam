from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
MARKDOWN_FILES = [ROOT / "README.md", *sorted((ROOT / "docs").rglob("*.md"))]
LINK = re.compile(r"!?\[[^\]]*]\(([^)\s]+)(?:\s+['\"].*?['\"])?\)")
EXTERNAL_PREFIXES = ("http://", "https://", "mailto:", "sangam://")


def verify_file(path: Path) -> list[str]:
    errors: list[str] = []
    content = path.read_text(encoding="utf-8")
    relative = path.relative_to(ROOT)

    for match in LINK.finditer(content):
        target = unquote(match.group(1))
        if target.startswith(EXTERNAL_PREFIXES) or target.startswith("#"):
            continue
        local_path = target.split("#", 1)[0].split("?", 1)[0]
        if not local_path:
            continue
        resolved = (path.parent / local_path).resolve(strict=False)
        if not resolved.is_relative_to(ROOT) or not resolved.exists():
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
            if not any(line.strip() for line in mermaid_lines):
                errors.append(f"{relative}:{mermaid_start}: empty Mermaid diagram")
            in_mermaid = False
        elif in_mermaid:
            mermaid_lines.append(line)
    if in_mermaid:
        errors.append(f"{relative}:{mermaid_start}: unclosed Mermaid fence")
    return errors


def main() -> int:
    errors = [error for path in MARKDOWN_FILES for error in verify_file(path)]
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(
        f"Verified {len(MARKDOWN_FILES)} Markdown files: local links and Mermaid fences are valid."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
