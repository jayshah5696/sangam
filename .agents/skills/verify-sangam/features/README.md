# Sangam Feature Verification Map

This directory is the maintained source for verifying user-facing Sangam behavior. Read this index before driving the app, then use the matching feature recipe to execute and capture proof.

## Baseline Preconditions

- Launch an isolated Sangam instance using `./scripts/control-sangam.sh launch <PORT>`.
- Set an ephemeral data directory in `/tmp/sangam-verify-<RUN_ID>` so runs never touch developer workspace data.
- Run `./scripts/control-sangam.sh doctor` and require HTTP 200 health, ready status, and passing SQLite `PRAGMA quick_check;`.
- Never drive an instance not owned by the current verification run.

## Driving Conventions

- Start every recipe from the baseline state unless preconditions specify otherwise.
- CLI commands are run through `./scripts/control-sangam.sh cli <command> [args...]`.
- API requests are run through `./scripts/control-sangam.sh api <method> <path> [data]`.
- Performance benchmarks are run through `./scripts/control-sangam.sh benchmark [count]`.
- Browser UI interactions are run through Playwright (`just test-e2e` or focused spec).

## Proof Standards

- **Actions & Resulting State:** Capture the mutation response and a subsequent read-only view confirming stored state.
- **CLI Proof:** Record the command, stdout JSON, and exit code.
- **API Proof:** Verify HTTP status code (200/201), `Idempotency-Key` handling, and response body.
- **Performance Proof:** Record latency percentiles (p50, p90, p95, p99) and throughput (req/s) saved to `benchmark.json`.
- **Security Proof:** Verify 403 Forbidden on unauthorized operations and CSP header compliance.
- **Side Effects:** Verify SQLite row count and schema consistency.

## Comprehensive Features

1. [Create a Document](./create-document.md) - Covers CLI and API document creation, title/body persistence, and revision attribution.
2. [Search Workspace](./search-workspace.md) - Covers FTS5 full-text indexing, exact phrases, token matching, and snippets.
3. [Revisions & Diff](./revisions-and-diff.md) - Covers optimistic concurrency control, expected-revision conflicts, and history.
4. [Performance & Load](./performance-and-load.md) - Covers latency percentiles, FTS5 search scalability under load, and cold readiness.
5. [Agent Tokens & Security](./agent-tokens-and-security.md) - Covers scoped agent bearer tokens, TTL, and role boundaries.
6. [File Materialization & Disk Sync](./file-materialization.md) - Covers physical file syncing, bidirectional edit reconciliation, and tombstoning.
7. [Trusted Preview & HTML Sandboxing](./trusted-preview.md) - Covers isolated preview origin, iframe sandboxing, and CSP security.
