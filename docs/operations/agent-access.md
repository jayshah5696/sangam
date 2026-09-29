# Agent access

## Path scopes and conditional HTTP requests

Path grants are recursive prefixes. `docs`, `docs/*`, and `docs/**` grant the
same subtree, including deeper descendants. Root aliases are `/`, `*`, `**`,
`/*`, and `/**`. Empty or absent prefixes also grant the root. Malformed
prefixes such as `//`, `*/*`, and embedded wildcards are rejected. Stored
literal wildcard prefixes are not rewritten on upgrade. Administrators must
review and reissue those grants through token settings or the issuance API.

Scoped organization reads filter before pagination. Ancestors outside the
grant have structural paths and authorized document counts. Their category
and tags are empty, their metadata version is zero, and their timestamps are
empty. Global tag enumeration requires a
global read grant. Organization reads use the normal activity boundary.

Document JSON responses have a strong `ETag` over all represented fields,
including tags, trust, extraction status, and materialization state. The raw
and download validators cover the bytes and media type. These validators are
different contracts. Use the JSON validator for document mutations. The
`current_revision_id` body field and `X-Sangam-Revision-ID` GET response header
identify content revisions, not HTTP representations.

GET, raw, and download support `If-Match` and `If-None-Match`. Update, move,
materialize, delete, restore, duplicate, metadata, and trust support both
conditions. `If-Match` compares strong tags. `If-None-Match` compares weakly.
Lists use OR comparison and may contain commas inside quoted tags. Only the
unquoted `*` is a wildcard. `"*"` is an ordinary tag. Malformed fields return
422. Empty tags are valid, but empty fields are rejected. An `If-Match`
failure takes precedence over an `If-None-Match` match. A matching GET cache
condition returns an empty 304 response with its validator. False mutation
conditions return 412 with `precondition_failed`.

HTTP conditions do not replace supplied body revision, metadata, or trust
version guards. Those independent guards still return 409. A revision body
guard may be omitted when a revision mutation supplies an HTTP condition.
Metadata and trust still require their body versions. Restore evaluates the
retained deleted document. Missing resources retain the normal 404 policy.

Authorization precedes condition parsing and replay. Storage rechecks the
condition after replay lookup inside the committing transaction while the
document pipeline is coordinated. Identical successful retries keep the
same request identity, including wildcard requests. Changed bodies or
headers with the same key return 409. Replay returns the current result and
repairs pending text materialization. It does not restore an old snapshot.

Audit redaction covers supported token strings in free text and paths, and
complete private PEM blocks before diff generation. Edit counts still
describe the original edit. Document content is preserved. Request headers
are sanitized for request context, but are not newly persisted in the
activity ledger. Mutation and audit atomicity already existed before this
repair.

Run `just verify-security 8893` for isolated live HTTP, token, storage, and
audit-export proof through the canonical behavior harness.

Agents interact with Sangam through the same API as humans, using scoped bearer tokens instead of shared credentials. Agent edits are attributed, revision-checked, idempotent, and reviewable.

## Discovery endpoints

Every running Sangam instance exposes public, credential-free discovery resources:

- `GET /llms.txt` — small index pointing agents to interfaces and contracts.
- `GET /skills/sangam/SKILL.md` — portable agent skill instructions for safe search, read, create, update, conflict recovery, PDF research, and publishing workflows.
- `GET /api/v1/openapi.json` — machine-readable OpenAPI 3.1 contract with schemas, bearer security, and error examples.
- `GET /api/v1/docs` — interactive browser reference for exploring routes.

These public resources explain the interface and safe workflows but grant no access. Scoped bearer tokens remain the only identity and capability boundary.

## Issuing a token

Create tokens in **Settings → Agents & access** (or via `POST /api/v1/agent-tokens`). The access-health summary shows active, expired, and soon-to-expire tokens, recent denied attempts, and the latest agent activity without blocking token management if the summary is unavailable. A token specifies:

- **Actor ID** — becomes the actor (`agent:<name>`) in the activity ledger
- **Display name & label** — human-readable description of the agent's role
- **Capabilities** — `read`, `search`, `create`, `update`, `move`, `tag`, `restore`, `delete`, `publish`, `inference`; grant the minimum required set
- **Path boundary** — optional prefix restricting mutations (e.g., `research/` or `projects/agent-x/`)
- **Expiry** — optional absolute deadline after which the token is invalid

After issuance:

1. **Copy token** — copy the secret bearer token immediately and store it in your external agent's secret store as `SANGAM_TOKEN`. Sangam displays the secret once and never stores it in recoverable plaintext.
2. **Copy agent setup** — copy separate secret-free setup instructions containing the instance URL and discovery curls:

   ```sh
   export SANGAM_API_URL='https://sangam.example.com'
   curl --fail "$SANGAM_API_URL/skills/sangam/SKILL.md"
   curl --fail "$SANGAM_API_URL/api/v1/openapi.json"
   ```

   Provide these instructions to the agent and inject `SANGAM_TOKEN` via its secret manager. Never paste secret tokens into prompts, repositories, or discovery files.

## Calling the API

The REST API lives under `/api/v1`. The `sangam` CLI wraps it:

```sh
export SANGAM_API_URL=https://sangam.example.com
export SANGAM_TOKEN=sgm_agt_...

sangam search "write-ahead logs" --limit 20
sangam read <document_id>
sangam create --path research/notes.md --title "Notes" --file notes.md
sangam update <document_id> --expected-revision <rev_id> --file notes.md --summary "Pass 2"
sangam history <document_id>
sangam diff <document_id> --from <rev_1> --to <rev_2>
sangam restore <document_id> --revision <rev_id>
sangam publish <document_id> --access-policy unlisted --slug notes
```

Every mutating call must carry:

- **Expected revision** (`expected_revision_id`) — the server rejects with `409 revision_conflict` if the document was modified since you read it. On conflict: re-read, merge intent onto the new current revision, and retry with a fresh key.
- **Idempotency key** (`Idempotency-Key` header) — ensures retries after network timeouts never double-apply operations.

Path boundaries are enforced per request: an operation outside the token's allowed path prefix returns `403 authorization_denied` even if the capability is granted.

## Chat proposals

Agents driving the workspace chat produce **proposals**, not direct writes: a suggested revision pinned to the revision it was generated from. The human reviews the diff in the UI and applies or discards it. Proposals survive restarts and remain recoverable. See [docs/chat-capabilities.md](../chat-capabilities.md) for full capability definitions and durable effect contracts.

Open **Review changes** in the workspace to inspect pending or stale proposals.
When a proposal has recorded turn context, the inbox shows its source document,
revision, selected passage, PDF page, or annotation. The inbox labels older
proposals without recorded context and sources that are no longer readable
separately.

The inbox separates cited supporting passages from retrieved sources and recorded
turn context. You can edit the wording before applying it. **Prepare revision
request in chat** fills the source thread's composer with your feedback and the
exact proposal context. Choose **Send** to deliver it. Preparing feedback leaves
the original proposal available for review.

## Incident response

If a token is compromised:

1. **Revoke immediately** in **Settings → Agents & access** (or via `DELETE /api/v1/agent-tokens/<token_id>`). Revocation takes effect instantly.
2. **Review Activity insights** to find recent access, conflict, publication, and other failures. Acknowledging an item removes it from Needs attention without deleting its immutable activity events. A later matching failure appears again automatically.
3. **Open the Activity view** with the actor and token filters preserved in the URL. Expand an operation to inspect its immutable events, then follow the document or access-management link.
4. **Restore damaged files** from revision history using `sangam restore` or the document history inspector.
5. **Rotate related tokens** if shared secret material was potentially exposed.
