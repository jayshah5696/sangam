---
name: delete-comment
description: Audit, categorize, and remove implementation comments across Sangam while moving real decisions to ADRs, tracking hack excuses as issues, and tightening the comment lint ratchets.
---

# Delete-Comment Workflow

Use this skill whenever cleaning implementation comments in a directory, branch, or newly imported code, or when tightening a comment ratchet baseline.

## Policy and Exemptions

Sangam bans implementation comments (`#` in Python, `//` and non-JSDoc `/* */` in TypeScript/JavaScript, and `/* */` in CSS).

Keep these exempt categories intact:

- **Documentation comments**: Python Google-style docstrings (`"""..."""`) and TypeScript JSDoc blocks (`/** ... */`).
- **Machine and safety directives**:
  - Python: `#!` (shebang), `# noqa`, `# type:`, `# pyright:`, `# mypy:`, `# pragma:`, `# fmt:`, `# ruff:`
  - TypeScript/JavaScript: `// SAFETY:` (required by `anti-slop/require-safety-comment-for-type-assertion`), `eslint-disable`, `eslint-enable`, `oxlint-disable`, `oxlint-enable`, `@ts-*`, `@vitest-environment`, `@vite-ignore`, `vite-ignore`, `prettier-ignore`, `istanbul`/`v8`/`c8` ignore, `/// <reference ... />`, `#!`

## Step 1: Extract Every Implementation Comment in Scope

Do not use naive regexes that break on `http://` inside strings or regex literals. Use real parsers:

- **Python**: `tokenize.generate_tokens` over `src/`, `scripts/`, and `tests/`.
- **TypeScript/JavaScript**: `typescript-eslint` `parseForESLint(..., { comment: true })` or `just anti-slop`.
- **CSS**: scan `frontend/src/styles/*.css` and `frontend/src/styles.css` via `frontend/scripts/check-ui-system.mjs`.

Record the exact baseline count of comments and lines before making edits.

## Step 2: Categorize Every Comment

Read each comment in its surrounding code context and assign exactly one category:

1. **Tautology**: Repeats what is already obvious from the code, types, or test assertions.
2. **Stale**: References past phases, resolved issue numbers, or outdated implementation details.
3. **Excuse**: Rationalizes a hacky workaround, swallowed exception, circular import, or skipped check so it propagates instead of being fixed.
4. **Decision Record**: Documents an important, non-obvious architectural invariant or trade-off that future changes must preserve.

## Step 3: Act on Each Category

- **Tautology / Stale**: Delete the comment cleanly. In TSX, delete the whole `{/* ... */}` expression container. If removing a comment leaves an empty `catch {}` block, keep ESLint `no-empty` green (or fix the swallowed error directly).
- **Excuse**: Delete the comment and record a concrete issue to fix the underlying hack (ask the user before creating external GitHub issues unless explicitly told to file immediately).
- **Decision Record**: Move the invariant into an ADR under `docs/adr/` (updating `docs/adr/README.md` if creating a new ADR), then delete the inline comment.

## Step 4: Tighten the Ratchet Baselines

Update the ratchet files so remaining budgets only move downward and cleaned files are removed:

- Python: `scripts/comment-ratchet.json` (enforced by `GPC003` in `scripts/check_python_standards.py`)
- TypeScript/JavaScript: `frontend/tools/oxlint/comment-ratchet.json` (enforced by `anti-slop/no-comments` in `frontend/tools/oxlint/anti-slop/rules/no-comments.ts`)
- CSS: `frontend/scripts/css-comment-ratchet.json` (enforced by `frontend/scripts/check-ui-system.mjs`)

Any file absent from a ratchet file has a budget of `0`. Any file with fewer comments than its listed budget fails lint until its ratchet entry is lowered or deleted.

## Step 5: Verify and Report Lines Shed

Run the canonical project gates:

```bash
just format
just lint
just test
just test-docs
```

Report:

1. Category breakdown (Tautology, Stale, Excuse, Decision Record).
2. ADRs created or updated.
3. Excuse issues filed or proposed for review.
4. Exact lines of code shed (and any remaining ratcheted lines).
