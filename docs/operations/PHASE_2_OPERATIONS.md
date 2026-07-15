# Phase 2 operations

## Development and verification

The `justfile` is the navigation surface for routine project work:

```bash
just                 # list recipes
just serve           # API and browser client with live reload
just test            # lint, format check, backend tests, frontend build/lint/tests
just test-docs       # Markdown style, relative links, and Mermaid fences
just docker-smoke    # production image, persistence, and restart recovery
```

The development UI is bound explicitly to `http://127.0.0.1:5173`; its `/api`
requests proxy to `http://127.0.0.1:8000`.

## Backup lifecycle

The browser's `/backups` route can create and re-verify backup sets. The same
operations are available over the API:

```bash
curl http://127.0.0.1:8000/api/v1/backups
curl -X POST -H 'Idempotency-Key: manual-backup-2026-07-14' \
  http://127.0.0.1:8000/api/v1/backups
curl -X POST http://127.0.0.1:8000/api/v1/backups/BACKUP_ID/verify
```

Each set lives under `data/backups/BACKUP_ID/` and contains
`database.sqlite3`, `workspace.tar.gz`, and `manifest.json`. A green browser
badge means the current artifact sizes, SHA-256 checksums, SQLite integrity, and
archive-member safety all passed.

## Restore drill

Restores require Sangam to be stopped and empty destination paths. Never restore
over a running database or a non-empty workspace.

1. Create and verify a fresh backup in the browser.
2. Stop Sangam.
3. Move the current database and workspace aside; do not delete them until the
   restored service has been verified.
4. Restore into empty targets:

   ```bash
   uv run python scripts/restore-backup.py BACKUP_ID \
     --backup-root data/backups \
     --database-path data/database/sangam.sqlite3 \
     --workspace-root data/workspace
   ```

5. Start Sangam and verify health, document count, a document body, history,
   search, and a materialized workspace file:

   ```bash
   docker compose up -d
   curl --fail http://127.0.0.1:8000/api/v1/health
   curl --fail http://127.0.0.1:8000/api/v1/documents
   ```

6. Run a reconciliation scan. A correct paired restore should not create
   unexpected-hash conflicts:

   ```bash
   curl -X POST http://127.0.0.1:8000/api/v1/reconciliation/scan
   ```

The automated suite performs this restore into new paths and boots a new
`DocumentService` from the restored database and workspace. The manual drill is
still required periodically on the real deployment because filesystem mounts,
permissions, free space, and operator procedure are outside unit-test scope.
