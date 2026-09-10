---
name: verify-sangam
description: "Drive and prove user-facing Sangam behavior (Browser UI, CLI, REST API, SQLite FTS5, Scoped Tokens, File Sync, and Performance/Latency) using isolated ephemeral instances and verifiable empirical evidence."
disable-model-invocation: true
---

# Sangam Verification Skill

Every change to Sangam must be proven through observable evidence against a real running instance, not through mocked units or unexercised assertions. This skill provides a self-contained harness to launch, health-check, drive, benchmark, and clean up Sangam with complete isolation.

## 1. Surfaces & Architecture

- **Browser UI:** React 19 + TanStack Router + CodeMirror editor + Pierre diffs. Served as static assets from `frontend/dist` or via Vite dev server.
- **CLI:** `sangam` Typer CLI driven via `uv run sangam` pointing to `SANGAM_API_URL`.
- **API:** FastAPI REST endpoints under `/api/v1/` (`/documents`, `/search`, `/history`, `/diff`, `/restore`, `/publications`, `/agent-tokens`, `/readiness`, `/health`).
- **Database & Search:** SQLite WAL mode with generation-consistent tables and FTS5 full-text indexing.
- **Security & Sandboxing:** Scoped bearer tokens (`read_only`, `workspace`, `admin`) and isolated iframe preview origin (`SANGAM_TRUSTED_PREVIEW_*`).
- **Performance / Latency:** FTS5 search latency percentiles, write throughput, cold boot & readiness response latency.

## 2. Launch

Launch an isolated instance using the repository control harness:

```bash
./scripts/control-sangam.sh launch [PORT]
```

- **Default Port:** `8765` (configurable, e.g. `8999`).
- **Isolation:** Creates a temporary state root in `/tmp/sangam-verify-<RUN_ID>` containing disposable `database/`, `workspace/`, and `backups/` directories.
- **Ready Signal:** Polls `GET http://127.0.0.1:<PORT>/api/v1/readiness` until HTTP 200 OK is returned with status `"ready"`.
- **Environment:**
  - `SANGAM_DATABASE_PATH="/tmp/sangam-verify-<RUN_ID>/database/sangam.sqlite3"`
  - `SANGAM_WORKSPACE_ROOT="/tmp/sangam-verify-<RUN_ID>/workspace"`
  - `SANGAM_BACKUPS_ENABLED=false`
  - `SANGAM_FRONTEND_DIST="$PWD/frontend/dist"`
  - `SANGAM_API_URL="http://127.0.0.1:<PORT>"`
  - `SANGAM_TRUSTED_PREVIEW_BASE_URL="http://preview.localhost:<PORT>/trusted-preview"`
  - `SANGAM_TRUSTED_PREVIEW_HOST="preview.localhost"`
  - `SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS='["http://127.0.0.1:<PORT>"]'`

## 3. Doctor

Before driving, run `doctor` to ensure the instance is running and fully healthy:

```bash
./scripts/control-sangam.sh doctor
```

Doctor confirms:
1. Process PID is alive and owned by this verification run.
2. `GET /api/v1/health` responds HTTP 200.
3. `GET /api/v1/readiness` responds `"status": "ready"` with database, schema, and writable root checks green.
4. Direct SQLite verification passes `PRAGMA quick_check;` and reports the expected schema migration version.
5. Emits `doctor.json` into `artifacts/verify-sangam/<RUN_ID>/doctor.json`.

## 4. Drive

Drive Sangam using user-facing entry points (CLI, API, Playwright, or Benchmark):

### A. CLI Driving
```bash
./scripts/control-sangam.sh cli list
./scripts/control-sangam.sh cli create --title "My Doc" --content "Hello World"
./scripts/control-sangam.sh cli search "Hello"
./scripts/control-sangam.sh cli history <DOC_ID>
```

### B. REST API Driving
```bash
./scripts/control-sangam.sh api GET /documents
./scripts/control-sangam.sh api POST /documents '{"title":"API Doc","content":"API text"}'
./scripts/control-sangam.sh api GET /search?q=API
```

### C. Performance & Latency Benchmarks
Exercise load and verify latency budgets:
```bash
./scripts/control-sangam.sh benchmark [COUNT]
```
Measures:
- Readiness check response latency (target: < 25ms)
- Document write throughput (writes/sec, p50, p95)
- FTS5 search query latency (searches/sec, p50, p95)
- SQLite row consistency confirmation

### D. Deterministic Data Seeding
Populate the instance with multi-modal verification assets (Markdown, HTML widgets, binary PDFs, and scoped agent tokens):
```bash
./scripts/control-sangam.sh seed
# Or via Justfile:
just verify-seed
```
Generates verifiable proof and FTS5 search verification manifest to `artifacts/verify-sangam/<RUN_ID>/seed.json`.

### E. Browser UI Driving (Playwright)
Run the dedicated browser test suite:
```bash
just test-e2e
# Or focused:
pnpm --dir frontend exec playwright test e2e/workspace-organizer.spec.ts
```

## 5. Evidence

All proof artifacts are collected under:
`artifacts/verify-sangam/<RUN_ID>/`

Required proof standards:
- **CLI Actions:** stdout JSON payload, exit code `0`, and read-only second query (e.g. `read` or `search`) confirming persistence.
- **Mutations:** Verification of returned `current_revision_id` and SQLite DB inspection.
- **Performance:** `benchmark.json` with p50/p90/p95/p99 latency numbers and throughput metrics.
- **Security:** 403 Forbidden assertions on unauthorized token operations.
- **UI:** ARIA snapshots or screenshots with the app identity visible.

## 6. Cleanup

Tear down the instance after driving:

```bash
./scripts/control-sangam.sh cleanup
```

- **Invariant:** Cleanup terminates the recorded process PID and deletes `/tmp/sangam-verify-<RUN_ID>`, but **never deletes** `artifacts/verify-sangam/<RUN_ID>`.
- The proof artifacts survive teardown for audit and reporting.

## 7. Feature Map

See `features/README.md` for individual feature verification recipes:
- [Create Document](features/create-document.md)
- [Search Workspace](features/search-workspace.md)
- [Revisions & Diff](features/revisions-and-diff.md)
- [Performance & Load](features/performance-and-load.md)
- [Agent Tokens & Security](features/agent-tokens-and-security.md)
- [File Materialization & Disk Sync](features/file-materialization.md)
- [Trusted Preview & HTML Sandboxing](features/trusted-preview.md)
