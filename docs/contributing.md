# Contributing

## Setup

```sh
uv sync --all-groups
npm --prefix frontend ci
just serve   # API on 127.0.0.1:8000, Vite on 127.0.0.1:5173
```

## Gates

Run these before every PR; CI runs the same set:

```sh
just check      # ruff lint/format, mypy, eslint, prettier, markdownlint
just test       # pytest with coverage + vitest
just test-e2e   # Playwright suite (desktop + narrow viewports, axe checks)
```

Documentation changes must pass markdownlint (`docs/**/*.md`, README,
SECURITY) and the docs-link verifier (`scripts/verify-docs.py`). Mermaid
blocks are validated by CI.

## Conventions

- Backend: Python 3.13+, FastAPI, typed end to end (mypy strict). Follow the
  existing service-module layout under `src/sangam/`.
- Frontend: React 19, TypeScript, TanStack Router/Query, CodeMirror 6.
  Read [UI_SYSTEM.md](UI_SYSTEM.md) before touching any UI; reuse semantic
  tokens and shared component anatomy.
- Migrations: forward-only SQL under `src/sangam/migrations/`. Never edit an
  applied migration.
- Tests mirror behavior, not implementation; add coverage alongside fixes.
- Commits follow conventional prefixes (`feat:`, `fix:`, `docs:`); releases
  are tagged from `main` after [operations/release-checklist.md](operations/release-checklist.md).

## Agent contributors

Repository rules live in [AGENTS.md](../AGENTS.md). For operating a deployed
instance (as opposed to developing Sangam), see the skill at
[.agents/skills/sangam-agent-guide/SKILL.md](../.agents/skills/sangam-agent-guide/SKILL.md).
