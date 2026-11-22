# ADR 0007: Banning implementation comments with ratcheted lint rules

## Status

Accepted

## Context

Inline implementation comments accumulate three failure modes in agent-assisted codebases:

1. **Tautologies** restate obvious code line by line, adding maintenance noise.
2. **Stale comments** reference past phases, resolved issue numbers, or superseded behavior.
3. **Excuses** rationalize hacky workarounds or swallowed errors instead of fixing root causes or filing trackable issues.

Meanwhile, genuine architectural decisions buried inside one file are hard to discover across the repository.

## Decision

1. **Ban implementation comments in Python, TypeScript/JavaScript, and CSS**
   - Python (`src/`, `scripts/`, `tests/`): `GPC003` in `scripts/check_python_standards.py` rejects `#` comments.
   - TypeScript/JavaScript (`frontend/`): `anti-slop/no-comments` in `frontend/tools/oxlint/anti-slop/rules/no-comments.ts` rejects `//` and non-JSDoc `/* */` comments.
   - CSS (`frontend/src/styles/*.css`, `frontend/src/styles.css`): `frontend/scripts/check-ui-system.mjs` rejects `/* */` comments.

2. **Explicit exemptions**
   - **Documentation comments** remain allowed: Python Google-style docstrings (`"""..."""`, validated by Ruff `D2`/`D3`/`D4`) and TypeScript JSDoc blocks (`/** ... */`).
   - **Machine directives and safety invariants** remain allowed: shebangs (`#!`), `# noqa`, `# type: ignore`, `# pyright:`, `# mypy:`, `# pragma:`, `# fmt:`, `# ruff:`, `// SAFETY:` (required by `anti-slop/require-safety-comment-for-type-assertion`), `eslint-disable`/`eslint-enable`, `oxlint-disable`/`oxlint-enable`, `@ts-*`, `@vitest-environment`, `vite-ignore`/`@vite-ignore`, `prettier-ignore`, `istanbul`/`v8`/`c8`, and triple-slash TypeScript references (`/// <reference ... />`).

3. **Ratchet baseline support**
   - Each checker supports a JSON ratchet file (`scripts/comment-ratchet.json`, `frontend/tools/oxlint/comment-ratchet.json`, and `frontend/scripts/css-comment-ratchet.json`) mapping relative file paths to their maximum remaining comment count.
   - Any file not listed has a budget of `0`. Adding comments above a file's budget fails lint. Removing comments below a file's listed budget also fails lint until the ratchet entry is lowered or deleted, guaranteeing the count only moves downward.
   - After the full-codebase cleanup, all three ratchet baselines start empty (`{"files": {}}`).

4. **Repeatable workflow**
   - The repository includes the `.agents/skills/delete-comment/SKILL.md` skill so contributors and agents can repeat the categorize -> delete / file issue / move to ADR -> tighten ratchet workflow on any future branch or imported code.

## Consequences

- New code cannot introduce ad-hoc implementation comments.
- Non-obvious invariants belong in `docs/adr/`, public contracts belong in docstrings/JSDoc, and workarounds must be tracked as issues rather than normalized in comments.

## Tracked workaround issues from the initial audit

- [#583](https://github.com/jayshah5696/sangam/issues/583): Surface clipboard copy failures in Claim Matrix and Publications instead of swallowing errors.
- [#584](https://github.com/jayshah5696/sangam/issues/584): Stop swallowing storage and network errors during evidence revision remapping.
- [#585](https://github.com/jayshah5696/sangam/issues/585): Stop suppressing project-attachment errors and deduplicate HTML cleaning in URL capture.
- [#586](https://github.com/jayshah5696/sangam/issues/586): Remove circular import and lazy `PdfResearchService` fallback in `DocumentService`.
- [#587](https://github.com/jayshah5696/sangam/issues/587): Replace Pierre FileTree `unsafeCSS` and shadow-DOM focus workarounds.
- [#588](https://github.com/jayshah5696/sangam/issues/588): Fix isolated HTML preview host CSP compatibility under WebKit.
- [#589](https://github.com/jayshah5696/sangam/issues/589): Replace in-place JSON schema dict mutation for `TaskDraft` provenance enum.
- [#590](https://github.com/jayshah5696/sangam/issues/590): Replace 1-second SQLite polling loop in MCP subscriptions with event-driven updates.
