# Contributing

Use `just` recipes as the standard interface for setup, formatting, linting,
testing, and verification. Run `just` with no arguments to list all recipes.

## Local setup

```sh
just setup   # install locked Python (uv) and frontend (pnpm) dependencies
just serve   # API on http://127.0.0.1:8000, Vite on http://127.0.0.1:5173
```

## Verification gates

Run the relevant gates before opening a pull request. CI runs the same recipes:

```sh
just format     # format Python (ruff) and frontend (prettier)
just test       # Python lint, standards, format, mypy, OpenAPI, pytest + frontend format, build, lint, vitest
just test-docs  # local Markdown links, repo paths, just recipes, Mermaid fences, markdownlint
just test-e2e   # Playwright desktop, narrow, touch-mobile, and axe accessibility suite
just check      # full gate: test, test-docs, validate-compose, check-distribution, package smoke
```

Run `just test-docs` for documentation changes. The reference checker covers
the top-level guides, `docs/**/*.md`, and `.agents/skills/**/*.md`.
`markdownlint` covers the top-level guides and `docs/**/*.md`. Check heading
fragments when renaming sections because the link checker only checks files.

## Conventions

- **Coding standards:** Read [coding-standards.md](coding-standards.md) for
  enforced Python, TypeScript, CSS, and comment rules. Non-obvious invariants
  belong in [docs/adr/README.md](adr/README.md), not inline implementation
  comments.
- **Backend:** Python 3.13+, FastAPI, strict `mypy` across `src/sangam/`. Follow
  the existing service-module layout under `src/sangam/`.
- **Frontend:** React 19, TypeScript, TanStack Router and Query, and CodeMirror
  6. Read [DESIGN.md](../DESIGN.md) and [ui-system.md](ui-system.md) before
  changing application UI, and reuse semantic design tokens and shared component
  anatomy. See [brand.md](brand.md) for logo and SVG rules.
- **API contract:** Review intentional API changes with `just verify-openapi`
  and update the baseline via `just update-openapi-baseline`. See
  [api-contract.md](api-contract.md).
- **Migrations:** Add forward-only SQL files under `src/sangam/migrations/`.
  Never edit an already applied migration.
- **Tests:** Test observable behavior and real failure modes, not internal
  mocks. For backend, API, CLI, or data-integrity changes, prove behavior
  against an isolated live server with `just verify-behavior` (or a targeted
  `just verify-*` recipe).
- **Commits and releases:** Use conventional commit prefixes (`feat:`, `fix:`,
  `docs:`, `refactor:`, `chore:`). Releases are tagged from `main` after
  completing [operations/release-checklist.md](operations/release-checklist.md).

## Agent contributors

Repository rules for coding agents live in [AGENTS.md](../AGENTS.md). For AI
agents operating a deployed Sangam instance rather than developing Sangam
itself, see the skill at
[.agents/skills/sangam-agent-guide/SKILL.md](../.agents/skills/sangam-agent-guide/SKILL.md).
