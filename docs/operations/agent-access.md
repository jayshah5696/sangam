# Agent access

External AI agents work on Sangam through the same API as the human owner,
authenticating with scoped bearer tokens instead of shared session credentials.
The activity ledger attributes agent operations to their actors. Sangam checks
capability and path grants on each request.

## Discovery endpoints

Every running Sangam instance exposes public, credential-free discovery
resources:

- `GET /llms.txt`: Short index pointing agents to available interfaces and
  contracts.
- `GET /skills/sangam/SKILL.md`: Portable operating skill covering safe search,
  read, create, update, conflict recovery, PDF research, and publishing.
- `GET /api/v1/openapi.json`: Machine-readable OpenAPI 3.1 contract with
  schemas, bearer security definitions, and error shapes.
- `GET /api/v1/docs`: Interactive browser API reference.

Discovery requires no Sangam credentials. An upstream proxy can still require
authentication before forwarding a request.

## Issue a token

Create tokens in **Settings -> Agents & access** or via
`POST /api/v1/agent-tokens`. The access-health summary at the top of that panel
shows active, expired, and soon-to-expire tokens, recent denials, and recent
agent activity without blocking token management if the summary query fails.

Each token defines:

- **Actor ID:** Written to the activity ledger as `agent:<name>`.
- **Display name and label:** Human-readable description of the agent's role.
- **Capabilities:** Grant only what the agent needs from `read`, `search`,
  `create`, `update`, `move`, `tag`, `restore`, `delete`, `publish`, and
  `inference`.
- **Path boundary:** Optional recursive path prefix restricting access (e.g.,
  `research/` or `projects/agent-x/`).
- **Expiry:** Optional timestamp after which the token stops working.

After creating a token:

1. **Copy token:** Save the secret bearer token immediately in your agent's
   secret store as `SANGAM_TOKEN`. Sangam shows the secret once and does not
   store it in recoverable plaintext.
2. **Copy agent setup:** Copy the separate, secret-free setup snippet with the
   instance URL and discovery commands:

   ```sh
   export SANGAM_API_URL='https://sangam.example.com'
   curl --fail "$SANGAM_API_URL/skills/sangam/SKILL.md"
   curl --fail "$SANGAM_API_URL/api/v1/openapi.json"
   ```

Inject `SANGAM_TOKEN` through the agent's secret manager. Never paste bearer
tokens into prompts, repositories, or discovery files.

For an MCP client, use **MCP setup** in the same Settings panel. Copy the MCP
URL and setup instructions, then store the same scoped token in the client.
**Check connection** verifies the token and tool catalog. **View MCP activity**
opens the filtered audit history. See [Connect another MCP client](../mcp.md#connect-another-mcp-client).

## Call the API and CLI

The REST API lives under `/api/v1`, and the `sangam` CLI wraps common workflows:

```sh
export SANGAM_API_URL=https://sangam.example.com

sangam search "write-ahead logs" --limit 20
sangam create --path research/notes.md --title "Notes" --file notes.md
sangam read "$DOCUMENT_ID" --json
sangam update "$DOCUMENT_ID" --expected-revision "$CURRENT_REVISION_ID" --file notes.md --summary "Pass 2"
sangam history "$DOCUMENT_ID"
sangam diff "$DOCUMENT_ID" --from-revision "$OLDER_REVISION_ID" --to-revision "$CURRENT_REVISION_ID"
sangam restore "$DOCUMENT_ID" "$OLDER_REVISION_ID" --expected-revision "$CURRENT_REVISION_ID"
sangam publish "$DOCUMENT_ID" notes --access unlisted
```

Set `DOCUMENT_ID` and the revision variables from Sangam's responses. Read the
latest `current_revision_id` before each revision-guarded CLI command. The CLI
generates a fresh idempotency key for each invocation. To retry an ambiguous
write with the same key, use REST and retain the exact request.

For REST document mutations with a revision guard, send
`expected_revision_id` or a supported `If-Match` or `If-None-Match` header.
A stale body revision returns `409 revision_conflict`. A failed HTTP
precondition returns `412 precondition_failed`. Re-read the current document
and use a new idempotency key for the revised request.

Send the `Idempotency-Key` header where the route requires it. Reuse the key
and exact request after a network timeout to avoid applying the write twice.
The document replay response can reflect a newer current revision.

Path boundaries are checked on every request. An operation outside the token's
prefix returns HTTP `403 forbidden` even when the capability is
present.

## Chat proposals

Workspace chat creates revision-pinned **proposals** for edits to existing
documents. Review mode leaves proposals pending. YOLO mode attempts to apply
them under the requester's current grants. The owner opens **Review changes**
to apply, edit, request a revision for, or dismiss pending and stale proposals.
Proposals survive server restarts.

The review inbox displays cited supporting passages, retrieved sources, and
recorded turn context (source document, revision, selected passage, PDF page, or
annotation) in separate sections. Older proposals without recorded context and
sources that are no longer readable are labeled explicitly. Choosing
**Prepare revision request in chat** fills the source thread's composer with
your feedback and proposal metadata without sending automatically, leaving the
original proposal available. See [chat-capabilities.md](../chat-capabilities.md)
for the full contract.

## Incident response

If an agent token is exposed or behaves unexpectedly:

1. **Revoke immediately** in **Settings -> Agents & access** or via
   `DELETE /api/v1/agent-tokens/{token_id}`. Revocation takes effect on the next
   request and on the next tool call or effect check in any running chat turn.
2. **Inspect Activity insights** to review recent denials, conflicts,
   publication changes, and failures. Acknowledging an item clears it from
   **Needs attention** without deleting immutable ledger rows; a later matching
   failure reappears automatically.
3. **Filter the Activity view** by actor and token ID (filters persist in the
   URL). Expand an operation to inspect its immutable events and follow links to
   affected documents.
4. **Restore affected documents** from immutable revision history with
   `sangam restore` or the document history inspector.
5. **Rotate related tokens** if any shared secret material may have been
   exposed.

## Technical reference

### Path scope rules

Path grants are recursive prefixes:

- `docs`, `docs/*`, and `docs/**` grant the same subtree, including nested
  descendants.
- `/`, `*`, `**`, `/*`, `/**`, an empty prefix, or an omitted prefix grant root access.
- Malformed prefixes such as `//`, `*/*`, and embedded wildcards are rejected.
- Legacy stored literal wildcard prefixes are not rewritten automatically on
  upgrade. Review and reissue those grants through Settings or the token API.

Scoped organization reads filter before pagination. Ancestor folders outside a
token's grant appear only as structural paths with authorized document counts;
their category, tags, and timestamps stay empty and their metadata version is
`0`. Listing global tags requires a global `read` grant.

### ETags and conditional HTTP requests

Document JSON responses return a strong `ETag` covering all represented fields,
including tags, trust level, extraction status, and materialization state. Raw
and download endpoints compute validators over bytes and media type instead. Use
the JSON `ETag` for document mutations. The `current_revision_id` field and
`X-Sangam-Revision-ID` header identify content revisions, not HTTP
representations.

- Supported routes: `GET`, raw, and download endpoints, plus update, move,
  materialize, delete, restore, duplicate, metadata, and trust mutations all
  support `If-Match` and `If-None-Match`.
- Matching semantics: `If-Match` uses strong comparison; `If-None-Match` uses
  weak comparison. Comma-separated lists evaluate with OR semantics and may
  contain commas inside quoted tags. Only unquoted `*` acts as a wildcard; `"*"`
  is treated as an ordinary tag.
- Error and status codes: Malformed headers and empty header values return HTTP
  `422` (empty quoted tags are valid). `If-Match` failure takes precedence over
  `If-None-Match`. A matching `GET` cache condition returns `304` with its
  validator. Failed mutation preconditions return `412 precondition_failed`.
- Interaction with body guards: HTTP preconditions do not replace explicit body
  revision, metadata, or trust version guards, which still return `409`. A
  revision mutation may omit `expected_revision_id` when supplying an HTTP
  precondition; metadata and trust updates still require their body version
  fields. Restore evaluates against the retained deleted document. Missing
  resources return `404`.
- Ordering and replay: Authorization runs before precondition parsing and
  idempotency replay. Storage rechecks preconditions inside the committing
  transaction after replay lookup. Identical retries keep the same request
  identity, including wildcard headers. Reusing an idempotency key with a
  changed body or precondition header returns `409`. Replay returns the current
  result and repairs pending text materialization without restoring an old
  snapshot.

### Audit redaction and verification

Audit redaction scrubs supported token strings in free text and paths, plus
complete private PEM blocks, before diff generation. Edit counts still reflect
the original edit, and saved document content is preserved unchanged. Request
headers are sanitized for request context and are not persisted in the activity
ledger.

Run `just verify-security 8893` to exercise isolated live HTTP requests, scoped
tokens, conditional headers, storage integrity, and audit redaction through the
canonical verification harness.
