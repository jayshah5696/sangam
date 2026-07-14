# Phase 1 implementation

Phase 1 is implemented as a single vertical slice. The browser, CLI, and HTTP routes all use the same `DocumentService`; there is no direct client write path to the workspace or database.

## Production UI

![Sangam Phase 1 document editor](./assets/phase-1-ui.png)

## What is present

- FastAPI application under `/api/v1`, with structured errors and generated OpenAPI documentation.
- SQLite migration runner, WAL mode, foreign keys, full synchronization, stable document IDs, immutable text revisions, tombstones, and bootstrapped actors.
- Create, read, update, materialize, move, delete, list, history, and restore operations.
- Required expected revision on every mutation of an existing document. Stale requests return `409` with the current revision ID.
- Required idempotency keys. Retrying the same mutation reuses its document and revision; reusing a key for different input returns `409`.
- Recoverable disk materialization: database commit, pending state, sibling temporary file, file and directory flush, atomic rename, hash verification, then clean state.
- Startup recovery for pending or missing projections.
- Conservative reconciliation for unexpected hashes, possible moves, and unknown files. Unknown files require explicit reindex. Accepted disk edits are revisions attributed to `system:reconcile`.
- React 19 browser client with TanStack file-based routes, a file list, direct CodeMirror 6 Markdown editing, debounced autosave states, conflict retention, materialization, history, and restore.
- Python CLI commands for `list`, `read`, `create`, `update`, `materialize`, `history`, and `restore`.
- Multi-stage Docker image and Compose deployment with host-mounted database, workspace, and backup directories.

## Verification map

The automated suite covers:

- Complete API lifecycle and stable identity across materialization and movement.
- Immutable history and restore-as-new-revision behavior.
- Stale writes with preservation of the accepted head.
- Same-request idempotent retries and different-request key rejection.
- Traversal, absolute, malformed, wrong-extension, duplicate, and symlink-escape paths.
- Tombstone deletion and recovery.
- Failures before atomic rename and after rename but before clean-state recording.
- Restart recovery of a pending materialization.
- Missing files, unexpected disk content, possible out-of-band moves, unknown files, explicit import, and reconciliation attribution.

Run all local checks:

```bash
uv run ruff check .
uv run ruff format --check .
uv run pytest
cd frontend
npm ci
npm run build
npm run lint
```

Run the production-image smoke test:

```bash
./scripts/docker-smoke.sh
```

The smoke test builds the image and verifies the API, CLI, host-mounted materialized file, container restart persistence, and startup detection of an out-of-band edit.

## Phase boundary

Search, tags, diffs, rendered Markdown preview, file-tree refinement, backup
automation, and reconciliation UI were delivered in
[Phase 2](./PHASE_2.md). Agent tokens, publishing, editable HTML, PDFs,
Karakeep, and chat remain deferred to later phases.
