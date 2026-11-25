# Backups, upgrades, and rollback

## What a backup is

A backup set contains `database.sqlite3`, `workspace.tar.gz`, and a
`manifest.json` with checksums. Restore the database snapshot and workspace
archive from the same set to keep revisions and materialized files consistent.

Backups are written to `SANGAM_BACKUP_ROOT`, rotated by
`SANGAM_BACKUP_RETENTION_COUNT` (default `14`), and verified when created. The
background task checks for a due backup at startup and every
`SANGAM_BACKUP_CHECK_INTERVAL_SECONDS`. It creates a backup when none exists
for the current UTC date. When backups are enabled, readiness checks the newest
manifest's creation time against `SANGAM_BACKUP_READINESS_MAX_AGE_SECONDS`.
Use **Verify again** to recheck artifact checksums and consistency.

## Create and verify a backup

In the UI, open **Settings -> Operations -> Backups** (or `/backups`), choose
**Back up now**. Sangam verifies the set during creation. Choose **Verify again**
to recheck a set before using it for recovery.

The backup API requires administrator authentication. Open `/api/v1/docs`
from an authenticated browser or use these requests on a local `single_user`
instance. Replace `BACKUP_ID` with the `backup_id` returned by the create call.

```sh
curl -fsS -X POST http://127.0.0.1:8000/api/v1/backups \
  -H 'Idempotency-Key: backup-before-upgrade-2026-11-25'
curl -fsS http://127.0.0.1:8000/api/v1/backups
curl -fsS -X POST http://127.0.0.1:8000/api/v1/backups/BACKUP_ID/verify
```

Use a new key for each new backup. Reuse the same key to retry that create request.

Copy at least one complete verified set to encrypted off-host storage before
every upgrade.

## Rehearse restore before an incident

Run the automated restore drill regularly rather than waiting for an outage:

```sh
just verify-restore-drill
```

The drill launches an isolated source instance (default port `8998`), creates a
two-revision Markdown document and a PDF, takes and verifies a paired backup,
restores into empty storage, boots a second instance, and checks readiness,
revision history, FTS search, PDF search, and exact PDF bytes. It writes a JSON
evidence report under `artifacts/restore-drill/` and removes its temporary state
on success or failure. To retain temporary state, run the underlying script
with `uv run python scripts/restore-drill.py --keep`. The `just` recipe takes
no arguments.

### Manual paired restore

Follow these steps to restore a paired backup by hand:

1. Stop the Sangam process (or target a fresh scratch directory for rehearsal).
2. Move the existing database directory and workspace aside. Keep the backup
   set, including its manifest, in the configured backup root.
3. Restore into empty targets with the repository's restore helper. It verifies
   the set before restoring. Replace `BACKUP_ID` with the chosen set's ID.

   ```sh
   uv run python scripts/restore-backup.py BACKUP_ID \
     --backup-root data/backups \
     --database-path data/database/sangam.sqlite3 \
     --workspace-root data/workspace
   ```

   Use the paths configured for your deployment. Keep the old WAL and SHM
   sidecar files with the old database. Ensure the service user can write to
   the restored directories before starting Sangam.
4. Start Sangam and confirm `http://127.0.0.1:8000/api/v1/readiness` returns
   HTTP `200`.
5. Spot-check a document's latest revision and run a reconciliation check in
   **Settings -> Operations -> Workspace integrity**.

### Negative-path harness check

To confirm that the verification harness fails closed on invalid benchmark
counts, wrong document identity, and SSE streaming errors while still cleaning
up isolated instances, run:

```sh
just verify-negative
```

Rejection logs are saved under `artifacts/verify-sangam/`.

## Upgrade Sangam

Database migrations are forward-only. The migrator has no automatic downgrade
path.

1. Create a paired backup, verify it, and copy it to an off-host location.
2. Rehearse the restore on a copy of production data if the release includes
   schema migrations.
3. Verify the new image signature and deploy the image by digest.
4. Watch container logs for migration completion, then verify
   `/api/v1/health` and `/api/v1/readiness`.
5. Exercise one read path and one write path in the UI.

## Roll back a release

Rolling back always combines the previous signed image digest with a full paired
restore:

1. Stop the running stack.
2. Point `SANGAM_IMAGE` back to the previous signed digest.
3. Follow the [paired restore steps](#manual-paired-restore) with the
   pre-upgrade backup.
4. Start the stack, confirm `/api/v1/readiness`, and spot-check a document.
