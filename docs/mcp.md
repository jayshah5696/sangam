# MCP document workspace

Sangam includes an experimental MCP server, enabled by default, that lets
external MCP clients search, read, annotate, propose changes to, and edit
Markdown and PDF documents through restricted Python (**Code Mode**) and a
sandboxed **MCP App**. Every operation runs through Sangam's canonical
revision-aware services and enforces the connected bearer token's current
grants.

## Surface overview

| Layer | Names | Purpose |
| --- | --- | --- |
| Model tools | `search`, `execute`, `present` | Discover catalog operations, run restricted Python in a Monty worker, and open permitted documents in the MCP App |
| App-only tool | `mcp_app` | Typed bridge actions invoked by the sandboxed MCP App (hosts must honor visibility metadata; server still enforces every grant) |
| Native resources | `sangam://workspace/{workspace_id}`, `sangam://document/{document_id}`, `sangam://execution/{execution_key}`, `sangam://proposal/{proposal_id}`, `sangam://skill/{skill_id}`, `sangam://assistant/{request_key}` | Authorized current-state reads and `subscriptions/listen` invalidation events |
| Code Mode catalog | `documents.*`, `proposals.*`, `pdf.*`, `skills.*`, `assistant.*`, `conversations.read`, `executions.get` | Async Python functions callable inside `execute` using keyword arguments |

## Local walkthrough

Run a disposable local demo with built frontend assets, an isolated database and
workspace, seeded Markdown documents (**Sangam MCP walkthrough** and
**Walkthrough companion notes**), a five-page PDF, and a registered review
skill:

```sh
just setup
just mcp-demo
```

The command listens on port `8873` and prints the host URL plus a mode-`0600`
path to a disposable bearer token (never the token itself). Keep that terminal
open; pressing Ctrl+C stops the server and deletes the temporary workspace and
key. Use `just mcp-demo 8874` to pick another port, or
`just mcp-demo 8873 true` to include the `inference` grant for the assistant
walkthrough (requires a working provider and model configuration in Sangam).

### Try the MCP App step by step

1. **Connect:** Open `http://127.0.0.1:8873/mcp-host.html`, paste the key
   file's contents into **Sangam API key**, and select **Connect**. The demo key
   grants `read`, `search`, `create`, and `update` under `mcp-demo/`.
2. **Search and draft:** Search for `walkthrough`, open the document, edit a
   paragraph, and wait for **Draft backed up**. The canonical Sangam document
   stays at its previous revision until you save.
3. **Multi-tab drafts and restore:** Expand **Find documents**, search for
   `companion`, open **Walkthrough companion notes**, edit it, then select
   **Reopen App**. Reopening (or reloading and reconnecting with the same actor)
   restores open tabs, active document, separate acknowledged drafts, and cursor
   and scroll locations. Reopening also restores the comparison reference.
4. **Save and close tabs:** Select **Save** on each document until **All changes
   saved** appears, then verify the committed revision in normal Sangam. Clean
   tabs close directly; dirty tabs must be saved or explicitly discarded first.
   Arrow keys, Home, and End navigate tabs.
5. **Compare side by side:** Select **Compare** on another tab to read it beside
   the active editor (with saved content and draft checkpoints labeled
   separately). On narrow screens, expand **Comparison** to inspect it and
   collapse it to resume editing. **Edit this document** switches to that tab,
   and **Remove comparison** keeps both tabs open.
6. **Read and annotate PDFs:** Search for `PDF`, open the walkthrough PDF, move
   across pages, zoom, and search page text. Select text and choose **Highlight
   selected passage**, or save a page note. Annotations use Sangam's canonical
   annotation service while original PDF bytes remain immutable. Reopening
   restores page, zoom, and scroll location. Save or discard an unsaved note
   before leaving the page or document.
7. **Create and review proposals:** On a Markdown tab, open **Review proposals**
   and choose **New proposal** to create a suggestion without altering the saved
   document. Edit **Reviewed wording** if desired and choose **Apply proposal**
   (or **Dismiss proposal** on a second suggestion). Save or discard any local
   document draft before applying.
8. **Create a document:** Choose **New document**, enter a title, a path under
   `mcp-demo/`, and Markdown content, and select **Create document**. The new
   tab opens while existing checkpointed drafts stay intact in their tabs.
9. **Ask Sangam (inference demo):** With `just mcp-demo 8873 true`, select **Ask
   Sangam**, pick explicit context (active saved document, saved passage, or
   saved open-tab revisions), inspect **Included context**, and send a message.
   Follow up in the same conversation or select **New conversation**. Open a
   resulting proposal with **Review**. **Cancel request** stops running work
   and leaves committed writes in place.
10. **Inspect protocol traffic:** Append `?debug=1` to the host URL to show
    **Connection and tool trace**.

To test conflict recovery, keep a checkpointed App draft, save a different
revision in normal Sangam, and refresh the App. The draft survives alongside the
new saved revision for comparison, and a stale **Save** cannot overwrite it.
Discarding a checkpoint requires confirmation. Abrupt teardown can lose edits
that the server has yet to acknowledge.

### Host and sandbox notes

The local host uses the official TypeScript MCP client and `AppBridge`, inherits
Sangam's saved appearance preferences, and pushes color and font tokens to the
App over standard MCP host context. App HTML is loaded via `resources/read` and
runs inside an opaque-origin `allow-scripts` iframe with network access denied
and no browser storage access. The bearer key stays in host memory, and the host
allows only the exact built App script hash while normal Sangam keeps its own
CSP. The self-contained App bundles the Markdown comparison grammar and PDF.js
(local verification checks that the HTML bundle stays under 6 MB; main Sangam
keeps full language support). App search calls a typed bridge action directly
and requires no model turn. External hosts can supply the same standard theme
and style fields.

## Connect another MCP client

1. In **Settings → Agents & access → MCP setup**, copy the server URL or the
   setup instructions. Use Streamable HTTP in your MCP client.
2. Issue a Sangam agent token in the same Settings panel. Start with scoped
   `read` and `search`. Add `create` or `update` for writes and `inference`
   if the client should call Sangam's configured assistant.
3. Store the token in your client's secret store. The client sends it as
   `Authorization: Bearer <token>`. MCP requires it even in `single_user` mode.
4. Use **Check connection** in Settings to verify the token and discover the
   tool catalog over MCP. This check uses the browser's current origin and
   does not exercise document grants, the Monty worker, or an external host.

For a non-loopback deployment, add the hostname and port to
`SANGAM_MCP_ALLOWED_HOSTS`. The server also accepts `/mcp`. Set
`SANGAM_MCP_ENABLED=false` and restart Sangam to disable both paths. Settings
reports the running configuration.

Use **View MCP activity** or **Activity → Filters → Made through → MCP** to
review audited operations attributed to MCP. The filter works with the existing
actor, token, outcome, date, and export controls. Older audit events without MCP
attribution remain visible under **Anywhere**.

### Code Mode tools and catalog

Call `search` to page through catalog operation schemas and retry rules
(`next_offset` paginates catalog results). Document search also supports
`offset`. Call `execute` with a caller-retained
`execution_key` and Python code using keyword arguments; the final expression is
returned under `output`.

Available catalog functions:

- **Documents:** `documents.search`, `documents.read`, `documents.history`,
  `documents.diff`, `documents.create`, `documents.update`
- **Proposals:** `proposals.list`, `proposals.get`, `proposals.create`,
  `proposals.apply`, `proposals.dismiss`
- **PDF research:** `pdf.status`, `pdf.pages.read`, `pdf.search`,
  `pdf.annotations.list`, `pdf.annotations.create`
- **Centralized skills:** `skills.list`, `skills.get`, `skills.read`
- **Assistant and conversations:** `assistant.submit`, `assistant.get`,
  `assistant.wait`, `assistant.cancel`, `conversations.read`
- **Recovery:** `executions.get`

Example search and update calls:

```python
hits = await documents_search(query="walkthrough", limit=10)
hits["items"]
```

```python
document = await documents_read(document_id="document-id")
await documents_update(
    document_id=document["document_id"],
    expected_revision_id=document["current_revision_id"],
    content="# Revised content",
    operation_key="retain-this-key-for-this-exact-write",
)
```

Key document-operation behaviors:

- `documents_read(document_id="...", revision_id="...")` returns bounded text
  passages with `next_offset`, `revision_id` for the returned text, and current
  metadata (`current_revision_id`, `title`). Always re-read current content
  before preparing an update. Markdown and HTML return source text under normal
  `read` grants.
- `documents_history(document_id="...", limit=10, cursor="...")` returns
  metadata-only revision pages (`next_cursor`).
- `documents_diff(document_id="...", from_revision_id="...", to_revision_id="...")`
  returns bounded unified diff text (`next_offset` counts characters) plus full
  addition and deletion counts.
- `present(document_id="first-id", additional_document_ids=["second-id"])` opens
  permitted Markdown or PDF documents in the App; `present(layout_id="...")`
  restores a saved layout. For the legacy `document_id` and `workspace_id`
  pair, both IDs must refer to the same document. Layout and checkpoint IDs are explicit references,
  never credentials.

## PDF research in MCP

PDF operations return bounded page text, search hits, and annotations:

```python
page = await pdf_pages_read(document_id="pdf-id", page_number=2)
page["text"]
```

If text extraction is pending, the response includes the document resource and
directs the client to check `pdf.status` again, and `execute` retains a `pending_jobs` entry even if the
program discards that status (without triggering an extra model turn).

In the App, authorized PDF bytes load in revision-bound chunks of at most 64,000
bytes and render locally with bundled PDF.js without network access or worker
permissions (canvas size and text-layer items are capped, with extracted text
fallback on render failure). Large PDFs can use substantial host memory.
`SANGAM_MAX_PDF_BYTES` still applies and defaults to 100 MB. Short host
frames scroll App controls independently so the PDF keeps its reading area.

Creating page notes or highlights requires `update` permission; `read` access
permits viewing and view-location checkpoints. Retry an annotation with the
same operation key and arguments. The annotation ID commits with the write so
a receipt can recover it if execution fails after commit. Document resource
invalidation refreshes notes added via REST or the main UI.

## Centralized skills

Code Mode exposes `skills.list`, `skills.get`, and `skills.read` for explicitly
registered skill documents readable by the current bearer token (including
skills registered by other actors; internal chat keeps its own personal and
project catalog rules). Ordinary readable Markdown files are never treated as
skills unless registered.

```python
catalog = await skills_list(query="walkthrough")
catalog["items"]
```

Each entry provides `_meta.sangam.skill_id`, origin, snapshot URI, frontmatter,
file sizes, and SHA-256 digests. `skills_get(skill_id="...")` returns the latest
snapshot, and `skills_read(uri="...", offset=0, length=1000)` reads bounded
chunks (character offsets for text, byte offsets with base64 output for binary).

Register a document via **Settings -> AI & models -> Chat skills** or
`POST /api/v1/chat/skills`. The registered document becomes `SKILL.md`, and
supporting canonical text or PDF documents map to package-relative paths in YAML
frontmatter:

```yaml
---
name: review-guide
description: Review a specification using the team's checklist
sangam:
  files:
    references/checklist.md: DOCUMENT_ID
    references/paper.pdf: PDF_DOCUMENT_ID
---
Read `references/checklist.md` before preparing the review.
```

Skill bundle rules:

- Relative Markdown links must have mappings; path traversal, collisions, and
  replacing `SKILL.md` are rejected. External links stay references, and export
  never executes scripts.
- Bundles allow up to 32 files (including `SKILL.md`), `SANGAM_MAX_DOCUMENT_BYTES`
  per file, and 16 MiB total. Oversized files fail explicitly. Catalog pages
  also respect `SANGAM_MCP_MAX_RESULT_BYTES`.
- Native clients can use the `io.modelcontextprotocol/skills` extension on
  protocol `2026-07-28` (`skills/list`, `skills/get`, and `resources/read`;
  directory reads are not advertised).
- Snapshots bind all source revisions atomically. Editing a supporting document
  produces a new snapshot. Superseded snapshots expire after
  `SANGAM_MCP_RESULT_RETENTION_DAYS` (default 7 days; reads do not extend TTL).
  Current snapshots remain available while registered and readable. Rediscover
  the skill if a snapshot expired or a source disappeared. Every read and
  recovery rechecks all source grants. Unavailable supporting files produce
  bounded diagnostics instead of a partial export.
- The logical `sangam://skill/{skill_id}` resource supports current-state reads
  and subscription invalidation. The built-in `sangam` skill remains separate
  from user-registered skills.

## Document creation

`documents.create` calls `WorkspaceAccessService.create_document` to create
Markdown with `title`, `content`, optional `path`, and a stable `operation_key`
under existing `create` grants:

```python
created = await documents_create(
    title="Meeting notes",
    path="notes/meeting.md",
    content="# Meeting notes\n",
    operation_key="retain-this-key-for-this-exact-creation",
)
created
```

The response distinguishes `created_revision_id` from `current_revision_id`.
Repeating the same key and arguments returns the original document; changing
arguments conflicts. A create-only token receives its creation reference without
gaining read or update access. An interrupted execution retains committed
creation evidence in its receipt.

In the App, **New document** calls the same operation via `document_create`.
Uncertain responses retain the form fields and key for **Retry creation**, and
if creation succeeded but opening failed, **Open document** retries navigation
only. The form opens from an existing workspace. To create the first document,
use Code Mode and then `present` it. Unsent form text is local until submitted
and can be lost on forced reload.

## Sangam assistant requests

Use `assistant.submit` inside Code Mode when the user asks Sangam's configured
assistant to act. The connection needs the global `inference` grant plus current
document grants, and inference and the chosen model must be enabled in Sangam.

```python
request = await assistant_submit(
    request_key="retain-this-key-for-this-exact-request",
    message="Read this document and propose a clearer introduction.",
    document_id="document-id",
    wait_seconds=2,
)
request
```

Request contract:

- **Shared runtime:** Runs through the normal ChatKit pipeline, admission
  limits, tool permissions, and review policy. YOLO can apply a chat proposal
  from an assistant request. Direct `proposals.create` calls create pending
  proposals for explicit review in either mode.
- **Bounded waiting:** Default wait returns immediately; maximum wait is 2
  seconds. Accepted work continues after `execute` finishes or disconnects.
- **Polling and resources:** Retain `request_key` and `conversation_id`. Inspect
  progress with `assistant_get`, wait briefly with `assistant_wait`, or watch
  `sangam://assistant/{request_key}`. Lookups return bounded answer passages
  with `next_offset`, the run reference, and any proposal and effect references.
  Discarded running request results still appear in
  `pending_jobs`. Completed document effects include their committed revision
  ID.
- **Outcomes:** `completed` means the turn finished (verify revision or effect
  evidence before claiming a change was saved). `needs_review` means a proposal
  or durable effect is waiting. Failed, cancelled, and interrupted states report
  their own status.
- **Idempotency and cancellation:** Reusing `request_key` with identical
  arguments retrieves the existing request; changed arguments conflict. Never
  mint a new key after a lost response. `assistant_cancel` cooperatively stops
  work without undoing committed writes. Server restarts mark unfinished
  requests interrupted without replaying them.
- **Conversations:** Pass `conversation_id` and a fresh `request_key` to
  continue an owned conversation (omitting `document_id` switches to workspace
  context). `conversations_read(conversation_id="...", cursor="...", limit=5)`
  paginates user and assistant messages (use `item_id` and `offset` for 1,200
  character chunks of long messages). Follow `next_cursor` even when a page
  contains only hidden internal records. Clients must know a conversation ID.
- **Access and retention:** Starting a turn requires `inference`; reading or
  cancelling owned requests checks ownership and current source grants (including
  prior-turn sources, skill catalog descriptions, and activated skill files)
  without needing `inference`. Cached execution results recheck these grants.
  Incomplete source inventories require a global `read` grant. Only one request
  can run per conversation at a time. Chat admission and timeout limits apply.
  Request identities count toward the MCP receipt quota. Answers expire after
  `SANGAM_MCP_RESULT_RETENTION_DAYS`. Compact identities and references to
  conversations and committed artifacts remain available for recovery.

### Assistant interaction inside the App

**Ask Sangam** uses typed `assistant_submit`, `assistant_get`,
`assistant_cancel`, and `assistant_messages` bridge actions over the same
service. Context is explicit: the active document and any `context_documents`
from readable open tabs carry exact saved revision IDs (and `selection_text` /
`pdf_page_number` when a saved passage is selected; Markdown selection mode
requires a clean document). Every included document is recorded as an access
dependency before inference. A Markdown selection must occur in the supplied
revision. Saved-revision modes preserve unsaved edits.

The composer displays included references before sending, retains input for
**Retry submission** (which looks up the owned key before resubmitting), and
restores the last accepted request and conversation on reopen. Send or discard
unsent messages before navigating. A forced reload can lose unsent text.
Messages paginate
newest-first via `conversations.read(order="desc")` (Code Mode default remains
`asc`). Proposal links open the shared review view; other durable effects show
status and continue to be approved in main Sangam chat.

## Proposals and review

Code Mode provides full owned-proposal workflows under existing read and update
grants (without requiring `inference`):

- `proposals_list(document_id="...", limit=10, offset=0)`: Metadata-only pages
  filtered by ownership, optional `conversation_id`, and literal read prefixes
  before SQL pagination. Follow `next_offset` for more results.
- `proposals_get(proposal_id="...", length=1000)`: Bounded content reads
  (`content_kind="proposed"` for model wording, `content_kind="applied"` after
  apply with `applied_revision_id`), target head revision, and Trash status.
  Pass `include_evidence=True` to load authorized context, citations, and
  retrieved sources (inaccessible sources are redacted; cached outputs recheck
  grants). `evidence_included` tells clients whether evidence was requested.
  Use `offset` and `length` for content passages. For large evidence sets,
  select the needed fields in Code Mode before returning them.
  Also exposed at `sangam://proposal/{proposal_id}`.
- `proposals_create(...)`: Creates an owned suggestion against an exact
  `expected_revision_id` with `summary`, full `content`, `operation_key`, and
  optional rationale/citations. Never auto-applies, even in YOLO mode.
- `proposals_apply(...)`: Commits exact reviewed `content` against
  `expected_revision_id` using `operation_key`, honoring Sangam's apply
  reservation and returning `applied_revision_id`. Stale bases conflict instead
  of rebasing. Recovery keeps the reservation's original key. Retry with that
  key and the exact reviewed content.
- `proposals_dismiss(...)`: Dismisses an owned pending or stale proposal under
  `read` access without creating a revision. Dismissal takes `reason` and
  `operation_key`. Creation and dismissal use actor-scoped idempotency.
  Receipts distinguish proposal record writes from document commits. An
  interrupted apply can already have a committed revision.

```python
proposal = await proposals_create(
    document_id="document-id",
    expected_revision_id="base-revision",
    content="# Proposed wording",
    summary="Clarify the introduction",
    operation_key="retained-create-key",
)
proposal
```

In the App, **Review proposals** loads the full proposal and base revision in
bounded passages into the shared diff and editable wording view. Apply and
dismiss call the same canonical service and block apply while the workspace has
an unsaved document draft. After a lost response, the App checks the original
key. It keeps the exact arguments when the result is uncertain or committed,
and allows corrections after confirmed rejection. Concurrent changes preserve
local review edits until reload or discard. Unsubmitted review edits stay
local. Finish or discard them before navigating or closing the App. External proposals without a chat thread also appear in
main Sangam's **Review changes** inbox.

## Subscriptions and execution recovery

### Resource subscriptions

On protocol `2026-07-28`, clients can subscribe via `subscriptions/listen` to
explicit `sangam://` URIs. Each stream checks canonical state once per second
(picking up REST and UI changes too) and emits only the changed URI. Streams do
not trigger model turns or guarantee every intermediate event; reconnect by
subscribing again and re-reading current state. Revocation, expiry, or lost
access ends the stream when its authorization check detects the change.
Each stream checks its own authority. Workspace resources show the draft and
saved revision separately. Document resources return metadata.

Conservative defaults limit the server to 64 active streams, 25 URIs per stream,
and 64 buffered notifications per stream. Clean App views refresh automatically
on updates while preserving drafts and conflict state; hosts without
subscriptions fall back to bounded polling.

### Execution isolation and recovery

Every `execute` runs fresh in a separate Monty worker with no cross-call state,
no filesystem/network/shell callbacks, and a sanitized environment with secrets
stripped.

- **Duplicate delivery:** Re-sending an in-flight `execution_key` returns
  `status: "running"`, `output_available: false`, and `reason: "in_progress"`
  without starting a second worker. Never replay a mutating program or change
  write keys after a lost response.
- **Inspecting failures:** Call `executions_get(execution_key="original-key")`
  or read `sangam://execution/{execution_key}` (which works even at receipt
  quota or when execution admission is full). Receipts report committed,
  rejected, and uncertain write outcomes. Earlier committed writes remain
  saved after a later callback fails. Python can catch callback exceptions.
  An in-flight receipt is provisional. Check the original key again for the
  final result.
- **Retention and revocation:** Detailed outputs expire after
  `SANGAM_MCP_RESULT_RETENTION_DAYS` (`reason: "result_expired"`), while compact
  receipts remain. Cached results retain source access dependencies and block
  retrieval if grants narrow, including dependencies inherited from earlier
  executions. Cancellation retains write references even if a commit finishes
  after the caller stops waiting. Server restarts mark running executions
  interrupted without replaying them. Trashing a source document preserves
  authorized recovery evidence under current grants.
- **Workspace drafts:** Layouts and per-document checkpoints use optimistic
  versions under actor ownership and create no document revisions until saved.
  Save clears its own checkpoint. Replaying an old Save cannot erase a newer
  draft. Quota failures preserve the last acknowledged copy. Drafts survive
  App closure and server restarts. A draft on a tab that loses read access
  stays stored until access returns. Clean layouts expire after
  `SANGAM_MCP_WORKSPACE_RETENTION_DAYS` (default 30 days). Polling does not renew
  retention, and dirty drafts protect their layouts. Closing a clean tab frees
  its checkpoint quota.
- **Navigation and view state:** The App checkpoints the outgoing draft and
  disables editing until the active tab changes. Recover or discard an
  unresolved Save before switching documents. View locations have their own
  optimistic version and require current read access. Saving a location
  changes neither the document revision nor the draft version.

## Limits and current scope

The Monty worker pool admits 2 concurrent executions without an unbounded queue.
Each execution enforces:

| Guard | Default limit |
| --- | --- |
| Wall-clock deadline | 10 seconds |
| Interpreter CPU budget | 1 second |
| Allocation budget | 32 MB |
| Recursion depth | 100 frames |
| Host callbacks | 32 calls |
| Worker process caps | 512 MiB Unix address space, 30 s CPU backstop; worker recycled per checkout |

These are conservative initial bounds requiring Unix resource limits (other
platforms are unverified). Host callbacks finishing after cancellation hold
admission capacity until they settle. See [Configuration](configuration.md#mcp)
for configurable byte caps, quotas, and retention periods. Document byte
limits also govern writes and drafts.

Outside current scope: simultaneous multi-pane editing, HTML/PDF source editing,
binary uploads, OAuth issuance, native MCP Tasks, and other workspace admin
operations. See the
[broader technical design](tasks/mcp-sota/02-tech-design-sangam-mcp.md) and
[ADR 0005](adr/0005-mcp-workspace-bridge-and-app.md). Local host verification
does not guarantee compatibility with every third-party MCP host.

## Upgrade compatibility

Migrations preserve existing proposal IDs, review evidence, and apply
reservations when adding ownership and allowing proposals without a chat
thread. Older assistant turns without a complete source inventory require
global `read`. Adding App provenance and declared context dependencies also
preserves earlier assistant request hashes and execution write evidence.

## Verification

```sh
just test
just verify-mcp
just test-e2e 'e2e/mcp-workspace.spec.ts'
```

- `just verify-mcp`: Starts an isolated server with built frontend assets, drives
  `/mcp` and `/mcp/` through the official Python MCP client, and verifies auth,
  Monty search, App resources, checkpointing, failure-after-commit recovery,
  duplicate delivery, conflicts, revocation, multi-tab restore, PDF reads and
  annotation recovery, and SQLite integrity. It checks exact PDF bytes and
  recovery after a dependency is trashed. Writes `mcp-slice.json` under
  `artifacts/verify-sangam/` without credentials. CI runs this check after the
  frontend build.
- `just verify-mcp-assistant 8899`: Opt-in live-provider proof verifying
  background completion, exact request replay, conversation continuation,
  source-access denial, Code Mode and App document creation, context binding,
  and proposal apply across MCP, REST, SQLite, and native resources. It
  requires a configured provider and fails if inference is unavailable. It
  also checks that the submitted proposal leaves the document unchanged until
  apply.
- `just test-e2e 'e2e/mcp-workspace.spec.ts'`: Exercises the real client and
  `AppBridge` across desktop/narrow Chromium, touch-mobile Chromium, and mobile
  WebKit (mocking only the model provider; live inference is proved separately
  by `verify-mcp-assistant`). Captures go to Playwright artifacts. Backend
  integration tests also cover interpreter exhaustion, cached output grants,
  concurrent duplicates, cancellation during a write, draft migration, and
  save replay with newer drafts.
