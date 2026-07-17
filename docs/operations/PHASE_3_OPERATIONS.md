# Phase 3 operations

## Authentication boundary

Sangam remains loopback-bound by default. `single_user` mode trusts requests
without a bearer token as the one human and applies token restrictions whenever
a bearer token is present. Do not expose the application port directly to an
untrusted network.

For a proxy-authenticated deployment, configure:

```bash
SANGAM_AUTH_MODE=trusted_proxy
SANGAM_TRUSTED_IDENTITY_HEADER=X-Sangam-Trusted-Identity
SANGAM_TRUSTED_IDENTITY_VALUE=human:jay
SANGAM_TRUSTED_HUMAN_ACTOR_ID=human:jay
SANGAM_TRUSTED_HUMAN_DISPLAY_NAME=Jay
```

Configure the proxy to remove inbound copies of the trusted identity header and
inject it only after authenticating the human. Verify both cases after every
proxy change:

```bash
curl --fail -H 'X-Sangam-Trusted-Identity: human:jay' \
  http://127.0.0.1:8000/api/v1/documents

curl --fail-with-body http://127.0.0.1:8000/api/v1/documents
```

The second request must return `401` in `trusted_proxy` mode.

The trusted identity value is the proxy assertion to compare. The trusted
human actor ID and display name are the canonical Sangam identity attributed to
accepted mutations; they need not equal the proxy assertion value.

## Issue a scoped agent token

Use Settings → Agents & tokens. Recommended first scope:

- `read: /**`
- `search: /**`
- `create: /agents/**`
- `update: /agents/**`
- `move: /agents/**`
- `tag: /agents/**`
- `restore: /agents/**`
- No delete capability until the integration has proved it needs one.

Copy the token immediately and store it in the external agent's secret store.
Sangam cannot display it again.

The last-used timestamp is deliberately approximate within five minutes. This
avoids taking a SQLite write lock for every read-only agent request while still
providing useful operational evidence.

## Configure the CLI

```bash
export SANGAM_API_URL=http://127.0.0.1:8000
export SANGAM_TOKEN='token-shown-once'

sangam search "revision safety" --limit 20
sangam create --title "Research report" \
  --path agents/research-report.md \
  --file report.md
```

Do not place tokens directly in shell history, repository files, Markdown
documents, or command output. Prefer an environment injected by the agent's
secret manager.

## Conflict recovery

A stale mutation returns `409 revision_conflict` with the expected and current
revision IDs plus `X-Operation-ID`.

1. Record the operation ID for review.
2. Read the document again.
3. Merge the intended change with the current content.
4. Retry using a new idempotency key and the current revision ID.
5. Confirm the accepted revision and activity event in the browser.

Never retry a stale write with a fabricated revision ID or by omitting
optimistic concurrency.

## Revoke or rotate

Use Settings → Agents & tokens:

- **Rotate** creates a replacement token and revokes the old token atomically.
- **Revoke** immediately rejects future authentication while retaining the
  token label and past activity for review.

After either action, verify the old token returns `401`:

```bash
curl --fail-with-body \
  -H "Authorization: Bearer $OLD_SANGAM_TOKEN" \
  http://127.0.0.1:8000/api/v1/documents
```

## Credential incident response

If a credential may have leaked:

1. Revoke it immediately.
2. Filter Agent activity by its actor and inspect accepted operations.
3. Review linked document revisions and diffs.
4. Restore unwanted content as new human-attributed revisions.
5. Issue a replacement with the narrowest required capabilities and path.
6. Remove the leaked value from the external secret store and any logs.

The operation ledger intentionally contains no bearer value or document body,
so Sangam's own review screens do not propagate the leaked secret.

## Backup and restore

Actor, token hash, scope, revocation, and activity tables are part of the same
canonical SQLite backup as documents and revisions. A restored database retains
token validity as of the backup time. After a disaster restore, rotate agent
tokens before reconnecting external automation so credentials created or
revoked after the backup cannot create ambiguity.
