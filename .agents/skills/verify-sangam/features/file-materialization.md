# File Materialization & Workspace Sync

Sangam stores documents in SQLite with immutable revision trees, but also allows syncing files directly to the local workspace filesystem so external editors, Git, and local tools can manipulate Markdown files.

## Sub-features

- `materialize-doc`: Materialize a specific document to disk at `SANGAM_WORKSPACE_ROOT/<path>`.
- `workspace-scan`: Scan the workspace filesystem for external edits and reconcile modified files into fresh document revisions.
- `materialize-delete`: Handle file removal or tombstoning without corrupting the historical database state.

## How to get to it (user POV)

- CLI: `sangam materialize <DOCUMENT_ID>`
- API: `POST /api/v1/documents/<DOCUMENT_ID>/materialize`
- Direct disk: Inspecting `$SANGAM_WORKSPACE_ROOT/notes/` for physical `.md` files.

## Driving it with control-sangam

Preconditions:
- Instance is healthy via `./scripts/control-sangam.sh doctor`.
- Ephemeral workspace root exists at `$SANGAM_WORKSPACE_ROOT`.

### 1. Create a Document with a Disk Path
```bash
./scripts/control-sangam.sh cli create --title "Architecture Overview" --path "docs/arch.md" --content "# Architecture\n\nVerified file materialization."
```

### 2. Verify File On Disk
Check physical file creation inside the isolated workspace directory:
```bash
# Path inside the active ephemeral run dir
test -f "$SANGAM_WORKSPACE_ROOT/docs/arch.md"
cat "$SANGAM_WORKSPACE_ROOT/docs/arch.md"
```
Expected: File exists and contains the exact Markdown content.

### 3. External Edit & Reconciliation
Modify the physical file on disk:
```bash
echo -e "\nAdded via external editor." >> "$SANGAM_WORKSPACE_ROOT/docs/arch.md"
```
Trigger workspace reconciliation and verify that Sangam records a new revision attributing the external modification:
```bash
./scripts/control-sangam.sh api POST /workspace/reconcile
```
Expected: HTTP 200 with reconciliation summary listing `docs/arch.md` updated.

## Gotchas

- Documents without an explicit `--path` are database-only (`materialization_state: none`).
- Conflicting simultaneous edits between disk and database trigger optimistic concurrency warnings.
