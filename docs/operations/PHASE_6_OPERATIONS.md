# Phase 6 operations

## Configure Karakeep

Generate a read-capable API key from Karakeep's Settings > API Keys page. Keep
the credential on the Sangam server and set the API root including `/api/v1`:

```bash
SANGAM_KARAKEEP_BASE_URL=http://karakeep:3000/api/v1
SANGAM_KARAKEEP_API_KEY=replace-with-karakeep-api-key
SANGAM_KARAKEEP_TIMEOUT_SECONDS=20
```

For Docker Compose, place the values in the untracked `.env` file and recreate
the Sangam container. Do not put the API key in a browser configuration file,
URL, screenshot, issue, or committed Compose override.

Open **Karakeep imports** from the workspace navigation. The connection card
must report that bookmark-read permission was verified before search is
enabled.

## Import and correct a bookmark

Search using a normal Karakeep full-text query or qualifier, select one result,
and choose **Import**. Confirm that the import detail includes:

- The expected Karakeep ID and original URL.
- Title, author, archive and modification times, and source tags.
- The expected attachment count and descriptors.
- `current` status and a linked Sangam Document.

Open the working copy and inspect its first history entry. The actor must be
`integration:karakeep`. Edit the Markdown normally; corrections are ordinary
human-attributed revisions and remain searchable through Sangam's shared
workspace search.

## Refresh without overwriting corrections

Choose **Check for refresh** from an imported source. If the normalized source
is unchanged, no revision is created. If it changed, the import enters
`review_required` and the working Document remains untouched.

Compare the accepted extraction with the corrected working copy. Edit the
proposed Markdown so it preserves the corrections you still want, then choose
**Apply reviewed revision**. Sangam requires the current expected revision. A
simultaneous editor save returns a conflict instead of replacing it; reload the
import review and merge again.

## Limits and attachment policy

The default maximum Karakeep source payload is 5 MB:

```bash
SANGAM_MAX_KARAKEEP_SOURCE_BYTES=5000000
```

The accepted range is 1 KB through 50 MB. Raise it only after checking SQLite
backup size and the largest archived article you intend to import.

Phase 6 records available attachment IDs, types, and filenames as provenance.
It does not download or mirror attachment bytes. Retrieve archive artifacts
from Karakeep during archive recovery; Sangam's normal backup covers imported
Markdown, snapshots, metadata, and revision history.

## Failure and retry

Failed imports and refreshes retain a bounded `last_error`. Check:

1. The configured base URL includes `/api/v1` and is reachable from the Sangam
   container or process.
2. The API key has not expired or been revoked and can read bookmarks.
3. Karakeep returns full content for the selected bookmark.
4. The source payload is within the configured limit.

Retry an initial failure by importing the same bookmark again. Retry a failed
refresh with **Check for refresh**. Sangam also converts any `importing` record
left by a process restart to `failed`; it never assumes the interrupted remote
read completed.

## Credential rotation

Create a replacement key in Karakeep, update the server-side environment, and
recreate or restart Sangam. Verify the connection card, then revoke the old
Karakeep key. Rotation does not change import IDs, Document IDs, snapshots, or
revision attribution.

## Recovery verification

After restoring the normal Sangam SQLite and workspace backup set:

- Open several Karakeep import details and confirm provenance and attachment
  descriptors are present.
- Open their linked Documents and confirm revision history and tags.
- Confirm a `review_required` import still shows accepted, proposed, and
  working content.
- Reconfigure the Karakeep API key separately; it is intentionally not stored
  in the database backup.
- Run a connection check and an explicit refresh on one representative item.

Do not repair imports by editing snapshot pointers, bookmark IDs, Document IDs,
or revision rows directly in SQLite.
