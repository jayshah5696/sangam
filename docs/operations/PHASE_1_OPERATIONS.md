# Phase 1 operations

## Development

Install and run the API:

```bash
uv sync --all-groups
uv run uvicorn sangam.main:app --reload
```

In a second terminal, run the browser client:

```bash
cd frontend
npm ci
npm run dev
```

Vite proxies `/api` to `http://127.0.0.1:8000`. API documentation is available at `http://127.0.0.1:8000/api/v1/docs`.

The CLI calls the HTTP API rather than importing the service directly:

```bash
export SANGAM_API_URL=http://127.0.0.1:8000
uv run sangam list
uv run sangam read DOCUMENT_ID
uv run sangam history DOCUMENT_ID
```

Updates and restores require the revision that the caller read:

```bash
uv run sangam update DOCUMENT_ID \
  --expected-revision REVISION_ID \
  --file edited.md
```

## Docker deployment

The Compose file binds Sangam only to host loopback so it is not exposed directly to the LAN:

```bash
mkdir -p data/database data/workspace data/backups
docker compose up --build -d
curl --fail http://127.0.0.1:8000/api/v1/health
```

The durable unit is all three mounted directories plus deployment configuration. Revision history is not a backup.

## Hosting boundary

The container publishes Sangam only on `127.0.0.1:8000`. Put the private-access or reverse-proxy product appropriate to the deployment in front of that listener. Sangam does not depend on a particular tunnel or proxy. Do not publish port 8000 directly through the home router.

## Recovery and reconciliation

At startup Sangam scans the workspace after completing pending materializations.

- A missing known file is reconstructed from the database head unless an unknown file has the same hash and could be an out-of-band move.
- Different bytes at a known path create an `unexpected_hash` conflict and do not alter the database revision.
- A matching file at an unknown path creates a `possible_move` conflict and is not guessed automatically.
- Other unknown Markdown files create `unknown_file` conflicts and are not imported automatically.

Inspect or trigger reconciliation:

```bash
curl http://127.0.0.1:8000/api/v1/reconciliation
curl -X POST http://127.0.0.1:8000/api/v1/reconciliation/scan
```

Explicitly register an unknown Markdown file:

```bash
curl -X POST http://127.0.0.1:8000/api/v1/reconciliation/reindex \
  -H 'Content-Type: application/json' \
  --data '{"path":"imports/example.md"}'
```

Accepting disk content for an unexpected-hash conflict creates a new immutable revision attributed to `system:reconcile`:

```bash
curl -X POST \
  http://127.0.0.1:8000/api/v1/reconciliation/CONFLICT_ID/accept-disk
```
