"""Exercise stale Markdown reference, link, home-path, and just-recipe checks."""

import importlib.util
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify-docs.py"


def load_verifier():
    spec = importlib.util.spec_from_file_location("verify_docs", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_verify_docs_rejects_stale_references_and_home_paths(tmp_path: Path) -> None:
    verifier = load_verifier()
    (tmp_path / "justfile").write_text("test:\n    echo ok\n", encoding="utf-8")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "real.md").write_text("# Real\n", encoding="utf-8")
    doc = tmp_path / "docs" / "guide.md"
    doc.write_text(
        "\n".join(
            [
                "# Guide",
                "See [missing](missing.md) and `src/sangam/missing.py` and `docs/nope.md`.",
                "Run `just nonexistent-recipe` or `/Users/dev/project/sangam`.",
                "```mermaid",
                "```",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    errors = verifier.verify_file(doc, root=tmp_path)
    joined = "\n".join(errors)
    assert "broken local link: missing.md" in joined
    assert "missing repository path reference: `src/sangam/missing.py`" in joined
    assert "missing documentation path reference: `docs/nope.md`" in joined
    assert "unknown just recipe reference: `just nonexistent-recipe`" in joined
    assert "hardcoded developer home path" in joined
    assert "empty Mermaid diagram" in joined


def test_verify_docs_accepts_valid_references(tmp_path: Path) -> None:
    verifier = load_verifier()
    (tmp_path / "justfile").write_text(
        'test:\n    echo ok\n\ntest-e2e args="":\n    echo ok\n', encoding="utf-8"
    )
    (tmp_path / "src" / "sangam").mkdir(parents=True)
    (tmp_path / "src" / "sangam" / "api.py").write_text("", encoding="utf-8")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "real.md").write_text("# Real\n", encoding="utf-8")
    doc = tmp_path / "docs" / "guide.md"
    doc.write_text(
        "\n".join(
            [
                "# Guide",
                "See [Real](real.md), `src/sangam/api.py`, and `docs/real.md`.",
                "Run `just test` or `just test-e2e` against `/path/to/checkout`.",
                "```mermaid",
                "flowchart LR",
                "    A --> B",
                "```",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    assert verifier.verify_file(doc, root=tmp_path) == []
