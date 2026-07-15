<p align="center">
  <img src="./frontend/public/sangam-mark.svg" alt="Sangam logo" width="112" />
</p>

<h1 align="center">Sangam</h1>

A single-user, self-hosted document server where a human and identified AI agents work with ordinary files through the same small API.

Phase 1 is implemented: one Markdown document can move end to end through the browser, HTTP API, CLI, SQLite revision history, and an ordinary workspace file.

The workspace base now adds nested folders, tags, categories, full-text search, resizable sidebars, and four selectable themes.

## Screenshots

### River workspace

![Sangam workspace using the River theme](./docs/assets/workspace-river.png)

| Midnight | Parchment |
| --- | --- |
| ![Sangam workspace using the Midnight theme](./docs/assets/workspace-midnight.png) | ![Sangam workspace using the Parchment theme](./docs/assets/workspace-parchment.png) |

### Cobalt workspace settings

![Sangam workspace settings using the Cobalt theme](./docs/assets/workspace-settings.png)

<details>
<summary>Phase 1 baseline</summary>

![Sangam Phase 1 document editor](./docs/assets/phase-1-ui.png)

</details>

## Project documents

- [Product vision and technical decisions](./docs/VISION.md)
- [Brand identity and logo usage](./docs/BRAND.md)
- [Seven-phase vertical implementation](./docs/IMPLEMENTATION_PHASES.md)
- [Phase 1 implementation and verification](./docs/PHASE_1.md)
- [Phase 1 development, deployment, and recovery operations](./docs/operations/PHASE_1_OPERATIONS.md)
- [Workspace organization and theming enhancements](./docs/WORKSPACE_BASE.md)

## Quick start

```bash
uv sync --all-groups
npm --prefix frontend ci
just serve
```

The development server runs the API on `http://127.0.0.1:8000` and the Vite frontend on the URL it prints.

Run the backend tests and frontend verification:

```bash
just test
```

Build or serve the production container:

```bash
just docker-build
just docker-serve
```

`just docker-serve` rebuilds the image, binds Sangam to `http://127.0.0.1:8000`, and mounts the three persistent `data/` directories. Override its defaults when needed, for example: `just port=8080 image=sangam:dev docker-serve`.
