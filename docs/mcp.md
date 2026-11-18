# MCP document workspace

The experimental MCP integration finds Markdown and PDF documents through restricted
Python and opens them in an MCP App. The App can search for more documents,
switch between tabs, checkpoint separate drafts, and save through Sangam's
existing revision-aware write service. The normal UI, REST API, and MCP share
permissions.

## Local walkthrough

```sh
just setup
just mcp-demo
```

The command builds the frontend and self-contained App, starts port 8873 with
an isolated database/workspace, and seeds **Sangam MCP walkthrough** and
**Walkthrough companion notes**, plus a five-page PDF and a registered review skill. It prints
the host URL and a mode-0600 disposable key file path, never the key itself.
Keep that terminal running. Use `just mcp-demo 8874` for another port.
For the assistant walkthrough, use `just mcp-demo 8873 true`. This gives the
disposable key the existing inference grant. Sangam must already have a working
provider and model configuration.

1. Open `http://127.0.0.1:8873/mcp-host.html`.
2. Paste the key file's contents into **Sangam API key** and select **Connect**.
   The key can read, search, create, and update only `mcp-demo/`.
3. Search for `walkthrough` and open the result.
4. Edit a paragraph and wait for **Draft backed up**. The normal Sangam document
   still holds its previous saved revision.
5. Expand **Find documents** inside the App. Search for `companion` and open
   **Walkthrough companion notes**. Switch tabs to recover the first draft.
6. Edit the second document, then select **Reopen App**. The server restores
   the open tabs, active document, and separate acknowledged drafts. Reloading
   the host and reconnecting with the same actor also restores them.
7. Select **Save** for each document. **All changes saved** means the canonical
   service committed that document's revision. Open normal Sangam to check it.
8. Close a clean tab with its close button. Save or explicitly discard a dirty
   draft before closing its tab. Arrow keys, Home, and End move between tabs.
9. Select a different tab's **Compare** button to read it beside the active
   editor. The pane labels saved content and draft checkpoints separately.
   On narrow screens, expand **Comparison** to use the document area, then
   collapse it to return to editing. **Edit this document** selects its tab.
10. Cursor and scroll locations are saved separately from drafts. Reopening
    restores each document's location and the comparison reference. Closing a
    clean tab removes its saved view. **Remove comparison** leaves both tabs open.
11. Search inside the App for `PDF` and open the walkthrough PDF. Move between
    pages, change zoom, and search page text. Select a passage and choose
    **Highlight selected passage**, or save a page note. These use the same
    annotation service as normal Sangam. The original PDF bytes stay unchanged.
12. Reopen the App to restore the PDF page, zoom, and scroll location. Save or
    explicitly discard an unsaved note before changing pages or documents.
13. Open a Markdown tab and select **Review proposals**, then **New proposal**.
    Enter a summary and proposed content, then select **Create proposal**. The
    document stays unchanged. Review the comparison and edit **Reviewed wording**
    before selecting **Apply proposal**. The result names the saved revision.
    Create another suggestion and select **Dismiss proposal** to close it without
    changing the document. Save or discard any document draft before applying.
14. Select **New document**. Enter a title, a path under `mcp-demo/`, and initial
    Markdown, then select **Create document**. The new tab opens after creation.
    The outgoing document's checkpointed draft remains in its own tab.
15. With the inference-enabled demo, select **Ask Sangam**. Choose the saved active
    document, a selected saved passage, or saved revisions of the open tabs.
    Inspect **Included context**, enter a message, and select **Send message**.
    Follow up in the same conversation or select **New conversation**. A proposed
    edit opens through its **Review** button and uses the existing apply/dismiss
    workflow. **Cancel request** stops running work without undoing completed writes.
16. Add `debug=1` to the host URL to expose **Connection and tool trace**.

The local host uses Sangam's saved appearance preferences and shared navigation,
tab, editor, and control styles. Its theme selector uses the existing palettes.
The App receives color and font tokens through standard MCP host context, including
updates while a document is open. External hosts can provide the same standard
theme and style fields. The App does not read browser storage inside its sandbox.

To see a conflict, keep a checkpointed App draft, save a different revision in
normal Sangam, then refresh the App. The draft survives, the App shows the new
saved content for comparison, and a stale Save cannot overwrite it. Discard
requires confirmation. Unacknowledged edits can still be lost on abrupt teardown.

The local host uses the official TypeScript MCP client and AppBridge. Search
runs actual Python in Monty. Search inside the App calls its typed bridge handler
directly and does not require a model turn. App HTML comes from `resources/read` and runs in an
opaque-origin `allow-scripts` iframe with network access denied. The key stays
in host memory. The host permits only the exact built App script hash; normal
Sangam keeps its existing CSP. No model response or domain operation is simulated.

The App's shared revision comparison bundles the Markdown syntax grammar.
The main Sangam application retains its full language support. HTTP verification
checks that the self-contained HTML stays below six million bytes, including its
PDF parser and comparison renderer. This is a local bundle check, not a limit
guaranteed by every MCP host.

Press Ctrl+C in the demo terminal to stop and remove the disposable workspace
and key. Verification artifacts remain under `artifacts/verify-sangam/`.

## Connect another MCP client

Set `SANGAM_MCP_ENABLED=true` on an existing instance. Connect to `/mcp` or `/mcp/` with
the same bearer key used for REST. Set `SANGAM_MCP_ALLOWED_HOSTS` for a public
request hostname and port. This creates no tunnel; remote clients cannot reach
your machine's localhost automatically. Even single-user mode requires a key.

The model tools are `search`, `execute`, and `present`. The typed interaction
tool `mcp_app` has App-only visibility. Hosts must honor visibility metadata;
it never substitutes for authorization. Every operation checks current grants.

The catalog contains `documents.search`, `documents.read`, `documents.history`,
`documents.diff`, `documents.create`, `documents.update`, `proposals.list`, `proposals.get`,
`proposals.create`, `proposals.apply`, `proposals.dismiss`,
`executions.get`, `pdf.status`, `pdf.pages.read`, `pdf.search`,
`pdf.annotations.list`, `pdf.annotations.create`, `skills.list`, `skills.get`,
`skills.read`, `assistant.submit/get/wait/cancel`, and `conversations.read`.
Discovery returns schemas,
retry rules, and `next_offset` for further catalog pages. Calls use keyword
arguments. For example:

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

Each execute requires a caller-retained `execution_key`. Its final expression
appears under the small `output` field. Search supports `offset` pagination;
read results include the revision and a `next_offset` for bounded passages.

`documents_read(document_id="...", revision_id="...")` reads an exact text
revision. Its `revision_id` identifies the returned content. Its
`current_revision_id` and `title` describe current document metadata. Read current
content again before preparing an update; historical text is not a current read.
Markdown and HTML return source text under the existing read grant.

`documents_history(document_id="...", limit=10, cursor="...")` returns revision
metadata without document bodies. Follow `next_cursor`. Use exact revision IDs
with `documents_diff(document_id="...", from_revision_id="...", to_revision_id="...")`.
The diff returns bounded unified text and `next_offset`, with additions/deletions
for the full comparison. Text offsets count characters. PDF research operations
remain the way to inspect PDF content and annotations.

`present(document_id="first-id", additional_document_ids=["second-id"])`
opens a set of permitted Markdown or PDF documents. `present(layout_id="layout-id")`
restores the saved open-document list and active tab. A legacy
`document_id`/`workspace_id` pair must refer to the same document. Layout and
document checkpoint IDs are explicit references, not credentials.

PDF operations return bounded page passages, search hits, or annotations. For example:

```python
page = await pdf_pages_read(document_id="pdf-id", page_number=2)
page["text"]
```

Extraction can still be pending. The response identifies the document resource
and tells the assistant to check `pdf.status` again. Execute also retains a
`pending_jobs` field when a program observes pending extraction, even if its
final expression discards that status. This does not schedule another model turn.

The App loads authorized PDF bytes in chunks of at most 64,000 bytes, bound to
the opened revision. PDF.js and its parsing code are bundled into the App and
run in the iframe without network access or a separate worker permission.
Rendering caps canvas size and text-layer items. If rendering fails, the App
offers extracted page text. Loading a large PDF can still use substantial host
memory; the existing 100 MB source limit applies.
Short host frames scroll the App controls while the PDF keeps its own reading
area. This prevents the header and toolbar from consuming the entire reader.

Page notes and text highlights require the existing update permission. Read
access alone permits viewing and location checkpoints. Annotation retries retain
the exact operation key and request. Migration `041` records the annotation ID
with the canonical write transaction, so execution recovery can identify a note
that committed before a program failed. Document resources include annotation
changes, so current views refresh notes added through the normal API or UI.

## Centralized skills

The catalog also provides `skills.list`, `skills.get`, and `skills.read` through
the existing execute tool. These discover explicitly registered documents under
the connection's current read grants, including guidance registered by another
actor. Internal chat keeps its existing personal/project catalog rules.
Unregistered Markdown documents do not become skills merely because they can be read.

The demo registers **Walkthrough review skill**. Discover its manifest with:

```python
catalog = await skills_list(query="walkthrough")
catalog["items"]
```

Each entry includes its stable document identity under `_meta.sangam.skill_id`,
origin, snapshot URI, original frontmatter, and complete file sizes and SHA-256
digests. `skills_get(skill_id="document-id")` exports the latest available
snapshot. `skills_read(uri="skill-file-uri", offset=0, length=1000)` reads a
bounded passage and returns `next_offset`. Text offsets count characters;
binary offsets count bytes and binary chunks use base64.

Use the existing skill registration UI or `POST /api/v1/chat/skills` with a
document ID. The registered document becomes `SKILL.md`. Explicit supporting
documents map to package-relative paths in its frontmatter:

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

Mappings support canonical text documents and immutable PDFs. Relative Markdown
links must have mappings. Paths cannot traverse directories, collide, or replace
`SKILL.md`. External links remain references. Exporting never runs scripts.
The initial bounds are 32 files including `SKILL.md`, the configured document
byte limit per file, and 16 MiB per bundle. Oversized files fail explicitly.
Catalog pages also respect the configured MCP result limit.

Native clients can use the `io.modelcontextprotocol/skills` extension on protocol
`2026-07-28`: `skills/list`, `skills/get`, and exact file bytes through
`resources/read`. The pinned SDK's extension interface supplies this adapter.
Directory reads are not advertised. Native and Code Mode reads use the same
snapshots; the host decides verification, approval, and activation.

Migration `042` stores manifests and revision references, not editable copies.
One transaction binds all source revisions. A change to a supporting document
also creates a new snapshot. Superseded manifests expire after seven days by
default, using `mcp_result_retention_days`; reads do not extend retention.
Current snapshots remain available while registered and readable. Expired or
missing sources require rediscovery. Every read checks all source grants, and
execution recovery rechecks the same dependencies. Unavailable helpers produce
bounded diagnostics rather than a partial usable manifest. The service-owned
`sangam` skill provides MCP operating guidance separately from user registrations.
The logical `sangam://skill/{skill_id}` resource supports current-state reads and
the existing authorized URI invalidation stream.

## Document creation

`documents.create` calls the same `WorkspaceAccessService.create_document` as
REST and chat. It creates Markdown with `title`, `content`, optional `path`, and
a stable `operation_key`. Existing create grants govern the destination.

```python
created = await documents_create(
    title="Meeting notes",
    path="notes/meeting.md",
    content="# Meeting notes\n",
    operation_key="retain-this-key-for-this-exact-creation",
)
created
```

The result separates `created_revision_id`, the original creation commit, from
`current_revision_id`, which can change later. Repeating the original key and
arguments returns the same document. Changed arguments conflict. An interrupted
execute retains canonical creation evidence in its receipt. A create-only key
can receive its creation reference without gaining read or update authority.

The App uses a typed `document_create` action over the same operation. A lost
response retains the original fields and key for **Retry creation**. If creation
succeeds but opening fails, **Open document** retries navigation rather than
creation. The form starts from an existing workspace. Code Mode can create the
first document and then present it. Form text stays local until Create; a forced
reload can lose an unsent form.

## Sangam assistant requests

Use `assistant.submit` inside Code Mode when the user explicitly wants Sangam's
configured assistant to do work. The connection needs the existing global
`inference` grant and current document grants. Inference and the selected model
must be enabled in Sangam. The default demo key does not include inference;
`just mcp-demo 8873 true` enables that grant for the disposable walkthrough.

```python
request = await assistant_submit(
    request_key="retain-this-key-for-this-exact-request",
    message="Read this document and propose a clearer introduction.",
    document_id="document-id",
    wait_seconds=2,
)
request
```

The server records the exact request identity before inference. The request uses
the normal ChatKit processing path, chat admission limits, tool permissions, and
internal review behavior. MCP adds no approval policy. The default wait returns
immediately; a requested wait is at most two seconds. Accepted work continues
when the execute call finishes or its caller disconnects. Python state stays fresh.

Retain `request_key` and `conversation_id`. Inspect a request with
`assistant_get(request_key="...")`, or wait briefly with
`assistant_wait(request_key="...", wait_seconds=2)`. These return bounded answer
passages with `next_offset`, a run reference, proposal/effect references, and a
checkable `sangam://assistant/{request_key}` resource. Resource subscriptions use
the same authorized invalidation path as documents. A program that discards a
running request's result still returns its reference under `pending_jobs`.
Completed document effects include the revision ID from their canonical result.

`completed` means the assistant turn finished. Confirm saved revision/effect
evidence before claiming a requested change was applied. `needs_review` means a
proposal or effect remains unresolved. Failed, cancelled, and interrupted jobs
report their own outcome. A successful status lookup does not mean the job succeeded.
The external host controls whether to schedule another turn.

Reusing the original request key with the same message and context retrieves
that request. Changed arguments conflict. A lost response never justifies a new
inference request. `assistant_cancel(request_key="...")` cooperatively cancels
work and waits for cancellation to settle. It does not undo committed changes.
Restart marks unfinished requests interrupted and does not replay them.

To continue a known owned conversation, pass its `conversation_id` and a new
request key to `assistant_submit`. Explicit document context applies to that
turn. Omitting it selects workspace context while preserving known conversation
history. `conversations_read(conversation_id="...", cursor="...", limit=5)`
returns bounded user and assistant messages. Follow `next_cursor`, including
pages that contain only hidden internal items. For a long message, use its
`item_id` and `offset` to retrieve the next 1,200 characters. Internal tool and
profile records are not returned as messages. There is no broad history search.

Starting a model turn requires current inference authority. Reading an owned
result or conversation and cancelling owned work uses the existing ownership
and source-access checks. These reads do not require an inference grant.
Current document/project access includes sources retrieved in
prior turns, skill catalog descriptions, and activated skill supporting files.
Cached execute results recheck these references too. An incomplete source
inventory requires a global read grant. Migration `043` marks older turns
incomplete because they did not record skill catalog sources. One request can run in a given
conversation at a time. New requests use existing chat admission and timeout
limits; retained request identities use the existing MCP receipt quota. Answers
expire after the existing seven-day result-retention window. Identities and
canonical conversation/artifact references remain for recovery.

### Assistant interaction inside the App

**Ask Sangam** uses typed `assistant_submit`, `assistant_get`, `assistant_cancel`,
and `assistant_messages` bridge actions over this same service. No additional
model tool or authorization mode is introduced. New messages need inference;
reading and cancelling existing owned requests use current source permissions.

Context is explicit. The active document and optional `context_documents` carry
exact saved revision IDs. A selected passage also carries `selection_text` and,
for PDFs, `pdf_page_number`. The server records every included document as an
access dependency before inference, even if the model never reads it. A narrowed
key cannot retrieve an answer or conversation that includes an unreadable source.
The App only accepts additional sources from its readable open tabs. Selected
Markdown must occur in the supplied revision, and selection mode requires a clean
document. Other modes use saved revisions while preserving unsaved edits.

The composer shows included references before Send. It retains the original
message and context while acceptance is uncertain. **Retry submission** first
looks up that owned request and only resubmits the same key and arguments if it
does not exist. Reopening the same document workspace restores the last accepted
request and conversation. Unsent messages remain local and can be lost on forced
reload. Ordinary navigation blocks until the message is sent or discarded.

Messages are bounded and paginated, with explicit controls for older messages
and long passages. The App reads the newest page first, using
`conversations.read(order="desc")`; the existing default remains `asc`.
Running work refreshes without another model response. A proposal reference
opens the shared revision review view. Other effect references show their current
status; effect approval remains in Sangam's existing chat workflow.

## Proposals and review

`proposals_list(document_id="...", limit=10, offset=0)` returns owned proposal
metadata. A known `conversation_id` is another optional filter. Follow
`next_offset`. Ownership and literal read-prefix filters run before SQL pagination;
the metadata query does not load proposal bodies or evidence.

```python
proposal = await proposals_get(proposal_id="...", length=1000)
{
    "wording": proposal["content"],
    "kind": proposal["content_kind"],
    "base_revision": proposal["expected_revision_id"],
    "status": proposal["status"],
}
```

The default `content_kind="proposed"` reads the original suggested wording.
`content_kind="applied"` reads the exact reviewed wording stored by the normal
apply service. It is available only after apply and names `applied_revision_id`.
The response also names the current document head and whether the target is in
Trash. A suggestion is not a saved revision.

Use `offset` and `length` for content passages. Set `include_evidence=True` to
retrieve authorized context, citations, and retrieved-source references.
`evidence_included` distinguishes omitted evidence from an empty set. Existing
source checks redact inaccessible quotations and mark them unavailable. A cached
execute result that contained private evidence rechecks those source grants.
For large evidence sets, let the Code Mode program select the required fields
and citations within its normal output budget.

`sangam://proposal/{proposal_id}` provides the same default bounded read through
native resources and the existing invalidation observer. Normal Sangam or REST
apply/dismiss actions update this resource. A read-only key can inspect its own
permitted proposals without an inference grant. Document access alone does not
grant access to another actor's proposal. REST proposal listing uses the same
target-document read filter.

`proposals_create` prepares an owned change against an exact revision without
changing the document or starting a conversation. It requires existing read and
update permissions, a summary, the full proposed content, and an `operation_key`.
Optional rationale and pinned citations use the same validation as chat proposals.
Creation never applies automatically, including when internal chat autonomy is
enabled. No inference grant or separate MCP approval grant is needed.

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

Use `proposals_apply(proposal_id="...", expected_revision_id="...",
content="exact reviewed wording", operation_key="retained-apply-key")` to commit
the reviewed content. Ownership and current target read/update permissions apply.
An older base conflicts instead of rebasing. The result names the committed
`applied_revision_id`; inspect that reference before reporting a saved change.
The existing apply reservation binds the wording and applying actor. Recovery
keeps its original operation key even if a later caller supplies a different key.
Use the original key and exact content for retries.

`proposals_dismiss(proposal_id="...", reason="...", operation_key="...")`
dismisses an owned pending or stale proposal under current read access. It creates
no document revision. Creation and dismissal use the existing actor-scoped
idempotency namespace. Changed arguments under an existing key conflict.
Execution failure evidence distinguishes proposal-record writes from document
commits. An interrupted apply can report its canonical committed revision before
proposal completion is recorded.

In the App, **Review proposals** opens the current document's owned proposals.
**New proposal** stores a suggestion; the saved document stays unchanged. Review
loads the complete proposal and exact base through bounded passages, then uses
the shared revision comparison and an editable reviewed-content field. Apply and
dismiss call the same service as Code Mode and REST. The App checks the original
key after a lost response. It permits correction only after server-confirmed
rejection, and retains exact arguments for committed or uncertain outcomes.
Both the App and server block apply while that workspace has a document draft.
Save or discard the draft first. A concurrent proposal change leaves local review
edits intact until the user reloads or discards them.

Review edits remain local until Create or Apply. Navigation and App teardown
require finishing or discarding local review edits. A forced browser reload can
lose those edits; the canonical proposal remains available. Saved document drafts
continue to use the existing checkpoint and retention rules.

Migration `044` adds explicit ownership to the existing proposal table, makes
conversation provenance optional, and preserves proposal IDs, evidence, and apply
reservations. Proposal changes participate in workspace invalidation and native
proposal-resource events. The ordinary Sangam review inbox also accepts external
proposals without a thread. App clicks retain the connected actor's authority.

## Recovery and persistence

### Resource changes

The native `2026-07-28` protocol supports `subscriptions/listen` for explicit
`sangam://workspace/{workspace_id}`, `sangam://document/{document_id}`, and
`sangam://execution/{execution_key}` references. The same authorized reader
serves resource reads and observes changes. Workspace reads include the draft
and saved revision separately. Document resources return metadata.

Each stream checks canonical state once per second, including changes made
through REST or the normal UI. Notifications contain only a changed URI.
They do not start model work or guarantee delivery of every intermediate state.
After reconnecting, subscribe again and fetch current state. Revocation, expiry,
or loss of access ends the stream. Each stream has an independent authority
check; another subscriber cannot cause private data to cross connections.

The initial bounds are 64 streams per server, 25 resource references per stream,
and 64 buffered notifications. These are conservative defaults. There is no
event replay store or second scheduler. The local host negotiates modern MCP
and forwards fresh workspace snapshots through the Apps bridge. Clean views
refresh automatically; drafts and explicit conflict resolution are preserved.
The App retains bounded polling for hosts without resource notifications.

### Execution recovery

Execution starts fresh in a separate Monty worker. There are no interpreter
variables across calls, filesystem callbacks, general network callbacks, shell,
or application objects. The launcher clears inherited environment secrets.

Duplicate delivery cannot start another program. Failure returns original write
keys and committed, rejected, or uncertain outcomes. Earlier writes remain saved.
Inspect `await executions_get(execution_key="original-key")` in a fresh execution.
Never replay the full mutating program or replace a write key after losing a
response. The authenticated `sangam://execution/{execution_key}` resource also
provides recovery without admitting new Python work, including at receipt quota.
The same resource works while execution admission is full.

Python can catch a callback exception and continue. An uncaught exception reports
the error that actually ended the program. Duplicate delivery of an in-flight
execution returns `status: "running"`, `output_available: false`, and
`reason: "in_progress"`. Its write list is a snapshot, not a final outcome.
Inspect the original key again rather than starting another program. A successful
MCP status lookup does not mean the original program has finished.

Detailed results expire after seven days by default. Compact identity and write
references remain. Cached output retains source access dependencies, including
dependencies inherited from earlier executions. Narrowing grants blocks retrieval.
Restart marks unfinished executions interrupted and never replays them.
Expired output has `reason: "result_expired"`. Cancellation retains write
references, including commits that finish after the client stopped waiting.
Trashing a source document does not erase permitted recovery evidence. Every
retrieval still authorizes the source's retained metadata under current grants.

App layouts store open documents and an active document under actor ownership.
Layout changes use their own optimistic version. Each document has a separate
checkpoint ID and draft version. Search results and tab metadata include only
currently readable documents. An unavailable tab's acknowledged draft stays
stored and becomes accessible again only with the required authority.

App checkpoints use actor ownership, workspace IDs, and optimistic versions.
They create no document revision. Save commits and clears only its own checkpoint;
replaying an old Save cannot erase a newer draft. Quota failure preserves the
last acknowledged copy. Drafts survive App closure and restart until Save or
Discard. Clean layouts expire after 30 inactive days; polling does not renew them.
A draft protects its complete layout from cleanup. Closing a clean tab frees
its checkpoint quota. Navigation checkpoints the outgoing draft and temporarily
disables editing while the active document changes. An unresolved Save must be
recovered or explicitly discarded before switching documents.

## Limits and current scope

The pool admits two executions without an unbounded queue. Each call has a
10-second wall deadline, 1-second interpreter budget, 32 MB allocation budget,
100-frame recursion limit, and 32 host callbacks. Workers have a 512 MiB Unix
address-space cap and 30-second CPU backstop and are replaced after each checkout.
These are conservative slice defaults, not measured production capacity. The
launcher requires Unix resource limits; other platforms are not verified.
Host callbacks that finish after cancellation continue to occupy admission
capacity until they settle.

See [Configuration](configuration.md#mcp) for source/output limits, quotas, and
retention settings. Existing document byte limits still govern writes and drafts.

The App uses tabs with one active Markdown editor or PDF reader and an optional
read-only comparison pane. Select a Markdown tab to edit its content.
View locations use their own optimistic version and require current read access.
Saving a location creates no document revision and does not change the draft version.
Two simultaneous editors, HTML/PDF source editing, binary upload, OAuth issuance, native Tasks,
other workspace operations remain outside this implementation. See the
[broader technical design](tasks/mcp-sota/02-tech-design-sangam-mcp.md).
Local bridge verification does not establish compatibility with every external host.

## Verification

`just verify-mcp-assistant 8899` exercises real configured inference through the
official MCP client on an isolated server. It verifies request completion after
execute ends, exact request replay without duplicate inference, known-conversation
continuation, current-source denial, and a reviewable proposal with no saved change.
It requires a configured provider and fails if inference is unavailable.
The check also creates a document through Code Mode and replays it through the
App action, submits saved selection and open-tab context, restores the accepted
request from its workspace, and applies the generated proposal through the
authorized App action. It checks the exact revision through MCP, REST, SQLite,
and the native resource.

```sh
just test
just verify-mcp
just test-e2e 'e2e/mcp-workspace.spec.ts'
```

`verify-mcp` starts a real isolated server and uses the official Python client
over HTTP. It verifies authentication, Monty search, App resources, checkpointing,
failure after commit, duplicate delivery, conflict preservation, revocation,
multi-document restoration, PDF page reads, annotation recovery and deduplication,
unchanged PDF bytes, recovery after trashing a dependency, and SQLite
integrity. It exercises both endpoint spellings with built frontend assets and
saves `mcp-slice.json` without credentials. CI runs it
after building the frontend.

Backend integration tests also cover interpreter exhaustion, nested cached-result
authority, concurrent duplicates, save replay with newer drafts, and application
restart. They also cover cancellation during an actual blocked document write,
layout quotas, and migration of existing drafts. They use real workers and
services. Browser tests use the real client
and bridge, check persisted content through REST, and cover desktop/narrow
Chromium, touch-mobile Chromium, and mobile WebKit. Screenshots and walkthrough
videos go to Playwright artifact directories rather than product baselines.
The creation and assistant cases cover lost responses, draft preservation,
accepted-request restoration, follow-up, proposal apply, exact persisted content,
minimum-width forms, and touch targets. The browser fixture replaces only the
model provider; the opt-in assistant check separately crosses the live provider
boundary. Migration `045` preserves old request hashes and execution write
evidence while adding App provenance and declared source dependencies.
