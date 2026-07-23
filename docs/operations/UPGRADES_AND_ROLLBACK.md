# Upgrades and rollback

Sangam 0.1 uses forward-only SQLite migrations. The safe rollback unit is the
signed container digest plus a paired database/workspace backup from before the
upgrade. Never run an older binary against a database that a newer binary has
migrated, and never mix a database from one backup set with workspace files from
another.

## Prepare an upgrade

1. Record the running image digest and inspect the target release notes.
2. Ensure the three host data directories are writable by the image's unprivileged
   UID/GID `10001:10001`. Do not run the application container as root.

   ```bash
   sudo install -d -m 0750 -o 10001 -g 10001 \
     data/database data/workspace data/backups
   ```

3. Create a backup while the old version is healthy, then explicitly verify it:

   ```bash
   curl --fail -X POST \
     -H "Idempotency-Key: pre-upgrade-$(date -u +%Y%m%dT%H%M%SZ)" \
     http://127.0.0.1:8000/api/v1/backups
   curl --fail -X POST \
     http://127.0.0.1:8000/api/v1/backups/BACKUP_ID/verify
   ```

4. Copy that complete backup directory off-host and verify the copied files. Local
   Sangam verification does not prove replication, encryption, or remote retention.
5. Restore the set into empty rehearsal paths and start the target image against
   only those paths. Confirm `/api/v1/health`, `/api/v1/readiness`, documents,
   history, search, PDFs, publications, imports, chat history, and reconciliation.
6. Resolve any rehearsal failure before touching production.

## Deploy

1. Put the application into a maintenance window and stop the old container so no
   writer remains.
2. Set `SANGAM_IMAGE` to the verified target digest in the deployment environment.
3. Validate configuration and start the production Compose definition:

   ```bash
   scripts/validate-compose.sh
   docker compose -f deploy/compose.prod.yaml pull
   docker compose -f deploy/compose.prod.yaml up -d
   ```

4. Wait for both health and readiness, then run the production acceptance section
   of [the release checklist](./RELEASE_CHECKLIST.md).
5. Keep the old data and the pre-upgrade backup until the observation window ends.

## Roll back after a migration

Stopping the new container and selecting the previous image is not sufficient once
migrations or writes occurred. Restore the complete pre-upgrade pair.

1. Stop Sangam and preserve the failed upgraded database/workspace for diagnosis.
2. Ensure the restore destinations are empty. Move any SQLite `-wal` and `-shm`
   sidecars with the failed database; do not leave them beside the restore target.
3. Restore the recorded pre-upgrade set:

   ```bash
   uv run python scripts/restore-backup.py BACKUP_ID \
     --backup-root data/backups \
     --database-path data/database/sangam.sqlite3 \
     --workspace-root data/workspace
   ```

4. Pin `SANGAM_IMAGE` to the previously recorded digest and start Sangam.
5. Verify health/readiness, representative content and PDFs, history, search,
   publications, chat, and a reconciliation scan. Rotate agent/API credentials if
   their state changed after the restored backup.

If the target release failed before it touched persistent state, the operator may
pin the prior digest without restoring. When uncertain, assume persistent state was
modified and use the paired restore.
