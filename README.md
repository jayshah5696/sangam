# Sangam

A single-user, self-hosted document server where a human and identified AI agents work with ordinary files through the same small API.

Phase 1 is implemented: one Markdown document can move end to end through the browser, HTTP API, CLI, SQLite revision history, and an ordinary workspace file.

The workspace base now adds nested folders, tags, categories, full-text search, resizable sidebars, and four selectable themes.

## Project documents

- [Product vision and technical decisions](./docs/VISION.md)
- [Seven-phase vertical implementation](./docs/IMPLEMENTATION_PHASES.md)
- [Phase 1 implementation and verification](./docs/PHASE_1.md)
- [Phase 1 development, deployment, and recovery operations](./docs/operations/PHASE_1_OPERATIONS.md)
- [Workspace organization and theming enhancements](./docs/WORKSPACE_BASE.md)

## Quick start

```bash
uv sync --all-groups
uv run uvicorn sangam.main:app --reload
```

Run the frontend in a second terminal:

```bash
cd frontend
npm ci
npm run dev
```

Or build and run the production container with `docker compose up --build`.
