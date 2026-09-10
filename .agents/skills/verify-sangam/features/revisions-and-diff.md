# Revisions & Diff

Sangam enforces immutable revision histories for all document mutations. Concurrent updates must pass `--expected-revision` to prevent silent overwrites.

## Sub-features

- `rev-history`: Lists the append-only revision DAG for a document.
- `rev-conflict`: Confirms that updating with a stale revision is rejected with HTTP 409 conflict.
- `rev-diff`: Computes diffs between any two historical revisions.
- `rev-restore`: Restores an earlier snapshot as a new revision without destroying intermediary history.

## How to get to it (user POV)

- Run `sangam history <DOC_ID>` to see changes.
- Run `sangam update <DOC_ID> --expected-revision <REV_ID> --content <NEW>` in CLI.
- Use the revision inspector and restore button in the browser UI.

## Driving it with control-sangam

Preconditions:
- Instance is healthy via `./scripts/control-sangam.sh doctor`.
- A target document exists with revision `r1`.

- **Perform Valid Update:**
  ```bash
  ./scripts/control-sangam.sh cli update <DOC_ID> --expected-revision <REV_1> --content "Version 2 Content"
  ```
  Expected: Success, returns new `current_revision_id: <REV_2>`.

- **Provoke Concurrency Conflict:**
  ```bash
  ./scripts/control-sangam.sh cli update <DOC_ID> --expected-revision <REV_1> --content "Conflicting Content"
  ```
  Expected: Command fails with exit code `1` and error payload indicating revision mismatch (HTTP 409 Conflict).

- **Diff Verification:**
  ```bash
  ./scripts/control-sangam.sh cli diff <DOC_ID> --from-revision <REV_1> --to-revision <REV_2>
  ```
  Expected: Returns unified diff showing modifications between revisions.

## Gotchas

- Never update without `--expected-revision`. Sangam's safety model intentionally rejects uncoordinated writes.
- Restoring an old revision does not delete new revisions; it appends a fresh revision with the restored content.
