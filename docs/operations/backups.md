# Backups, upgrades, and rollback

## What a backup is

A backup is a **paired artifact**: one SQLite dump plus one workspace tarball taken from the same generation. Restoring only one side is unsupported by design — the pair is what makes a restore trustworthy.

Backups are written to `SANGAM_BACKUP_ROOT`, rotated by `SANGAM_BACKUP_RETENTION_COUNT` (default 14), and self-verified on a schedule (`SANGAM_BACKUP_CHECK_INTERVAL_SECONDS`). Readiness requires a verified backup newer than `SANGAM_BACKUP_READINESS_MAX_AGE_SECONDS`.

## Creating and verifying

From the UI: **Backups → Create backup**, then **Verify**.

From the API/CLI:

```sh
curl -fsS -X POST "$SANGAM_URL/api/v1/backups" -H "Authorization: Bearer $SANGAM_TOKEN"
curl -fsS "$SANGAM_URL/api/v1/backups" -H "Authorization: Bearer $SANGAM_TOKEN" | jq
```

Copy at least one verified backup off-host before any upgrade:

```sh
rsync -av data/backups/ backup-host:sangam-backups/
```

## Rehearsal restore drill

Run the automated rehearsal before you need it, not during an incident. It creates
an isolated source instance, writes a document with two revisions and a PDF,
creates and verifies a paired backup, restores into empty storage, boots a second
instance, and checks readiness, revision history, FTS search, PDF search, and exact PDF bytes:

```sh
just verify-restore-drill
```

The drill uses port `8998` by default, writes a JSON evidence record under
`artifacts/restore-drill/`, and removes its temporary state on success. Use
`--keep` while investigating a failure. A manual rehearsal still follows the same
paired-artifact rule:

The verification harness also has a persistent negative-path check. It proves that
an invalid benchmark count and a wrong per-token document identity fail, and that
the isolated instance cleanup still runs:

```sh
just verify-negative
```

The command stores both rejection reports under `artifacts/verify-sangam/`.

1. Stop the app (or run it against scratch paths).
2. Restore both sides of the pair into `data/database` and `data/workspace`.
3. Handle SQLite sidecars: remove stale `*.sqlite3-wal` / `*.sqlite3-shm` from the restored directory.
4. Start Sangam and confirm `/readiness` passes.
5. Spot-check a document's latest revision in the UI.

## Upgrading

Upgrades are forward-only migrations; there is no downgrade path through the migrator.

1. Create a paired backup, verify it, copy it off-host.
2. Run a rehearsal restore if the migration touches schema you care about.
3. Deploy the new digest-pinned image (`deploy/compose.prod.yaml` refuses a moving tag).
4. Watch logs for migration completion, then check `/health` and `/readiness`.
5. Exercise one read and one write path in the UI.

## Rollback

Rollback = previous image digest + full paired restore:

1. Stop the stack.
2. Set `SANGAM_IMAGE` to the previous signed digest.
3. Restore the pre-upgrade backup pair (both files, sidecar cleanup as above).
4. Start the stack and verify readiness plus a document spot-check.
