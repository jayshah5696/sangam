# Sangam: Vertical Implementation Phases

> Status: Phases 1–4 implemented and verified locally; Phases 5–7 remain proposed
>
> Related: [Product vision and technical decisions](./VISION.md)

## Purpose

Sangam will be built as seven vertical, deployable increments. Each phase must produce a capability that can be used and evaluated end to end through the real service layer. The phases are not backend, frontend, and infrastructure workstreams completed in isolation.

The sequence protects the architectural spine:

> The backend remains a document server. The browser, CLI, agents, renderers, importers, chat, and publishing system remain clients of its small API.

Later phases may refine earlier behavior, but they must not introduce alternate write paths, bypass revision attribution, or replace stable document identity with filesystem paths.

## Rules for every phase

Each phase is complete only when:

- Its primary workflow runs end to end through the HTTP API and shared service layer.
- Every accepted mutation is actor-attributed and recoverable.
- Concurrency behavior is explicit and tested.
- Restart and failure behavior is tested for newly introduced durable state.
- The increment runs in the normal Docker deployment rather than only in a development process.
- User-facing behavior, API behavior, and operational recovery are documented.
- Deferred features are left out rather than represented by speculative abstractions.

Implementation order inside a phase should begin with the narrowest walking skeleton, then harden it until the exit demonstration and tests pass.

---

## Phase 1 — One Markdown document, end to end

> Implementation: [Phase 1 implementation and verification](./PHASE_1.md)

### Outcome

A human can create, edit, inspect, and restore a Markdown document through Sangam. The same document is available through the HTTP API and CLI and exists as an ordinary file on disk.

This phase proves the storage, identity, revision, concurrency, and recovery model before broader workspace features depend on it.

### Vertical slice

The browser creates a document, receives its stable ID and first revision, edits it with an expected revision, and reads it back. Sangam commits the immutable revision to SQLite and atomically materializes the current content to the workspace. The CLI sees the same document through the API. History can restore the original content without changing the document ID.

### Included

#### Application skeleton

- FastAPI application and versioned HTTP API.
- React, TypeScript, and Vite browser application.
- SQLite initialization and schema migrations.
- Small Python CLI that calls the HTTP API.
- Docker image and Compose deployment.
- Host-mounted database, workspace, and backup directories.
- Loopback-bound container deployment that can sit behind the host's chosen private reverse proxy.

#### Document core

- Stable `document_id` independent of path.
- Markdown content type only.
- Materialized and unmaterialized documents.
- Create, read, update, materialize, move, delete, and list operations.
- Path validation confined to configured workspace roots.
- Current revision pointer and content hash.
- Tombstone-based document deletion so deletion is recoverable.

#### Revision and write protocol

- Immutable full-text revision snapshots.
- Actor, timestamp, parent revision, operation, and optional summary.
- Expected-revision requirement on updates.
- `409 Conflict` response containing the current head.
- Mutation idempotency keys.
- Pending materialization state.
- Sibling temporary-file write, flush, atomic rename, and hash verification.
- Startup completion of interrupted materializations.
- Restore implemented as a new revision, never by moving the head backward.

#### Minimal clients

- Browser document list.
- Basic CodeMirror Markdown editor.
- Debounced autosave with visible saving, saved, conflict, and failure states.
- Minimal history list and restore action.
- CLI commands for list, read, create, update, history, and restore.
- Bootstrap identities for `human:jay`, `system`, and the CLI client.

#### Reconciliation

- Detect missing known files, unexpected hashes, possible moves, unknown files, and pending materializations.
- Automatically repair only unambiguous pending or missing materializations from the database head.
- Report all other cases as conflicts.
- Explicit reindex/import path for unknown files.
- `system:reconcile` attribution for accepted disk content.

#### Verification

- Service and API tests for the document lifecycle.
- Revision immutability and restore tests.
- Stale-write and idempotent-retry tests.
- Path traversal and invalid path tests.
- Failure-injection tests around database commit and atomic rename.
- Startup recovery and reconciliation scenario tests.
- Docker smoke test using host-mounted state.

### Exit demonstration

1. Create an unmaterialized Markdown document in the browser.
2. Materialize it to `projects/first-document.md` without changing its ID.
3. Edit it in the browser and read the new content through the CLI.
4. Attempt an update using an old revision and receive a conflict without losing either version.
5. Restore an earlier revision and observe a new attributed revision.
6. Interrupt materialization at a tested failure point, restart Sangam, and observe automatic recovery.
7. Modify the file outside Sangam while it is stopped and observe a reconciliation conflict rather than silent ingestion.

### Explicitly deferred

Workspace search, tags, polished diffs, agents, HTML rendering, publishing, PDFs, Karakeep, Cloudflare exposure, and chat.

---

## Phase 2 — A useful Markdown workspace

> Implementation: [Phase 2 implementation and verification](./PHASE_2.md)
>
> Earlier base: [Workspace organization and theming enhancements](./WORKSPACE_BASE.md)

### Outcome

Sangam becomes useful as a daily personal Markdown workspace, independent of any agent functionality.

### Vertical slice

A human can navigate a real workspace, find a document by content or metadata, edit it comfortably, compare its history, restore it, and resolve reconciliation problems without leaving the browser.

### Included

#### Workspace experience

- Hierarchical workspace tree and document list.
- Create, rename, move, duplicate, and recoverable delete actions.
- Titles, paths, tags, modification time, and actor information.
- Recent documents and basic sorting/filtering.
- Internal document links based on stable IDs, with path-oriented display.
- Responsive left navigation, main editor, and revision panel.
- Keyboard navigation and core editor shortcuts.

#### Search and organization

- SQLite FTS5 indexing for Markdown title, path, content, tags, author, and revision summary.
- Search query API with filters and highlighted snippets.
- Index updates driven by committed revisions.
- Rebuildable index and an explicit reindex operation.
- Tag creation, assignment, removal, and filtering.

#### History and recovery

- Line-oriented revision diff.
- Revision detail with actor and operation metadata.
- Restore and copy-from-revision workflows.
- Reconciliation-conflict screen with import-disk, restore-database, recognize-move, and ignore choices where applicable.
- Nightly SQLite backup and workspace snapshot with retention.
- Documented restore verification.

#### Editor refinement

- Reliable debounced autosave.
- Clear dirty, pending, saved, conflicted, and offline/error states.
- Search and replace.
- Markdown syntax highlighting and selection tracking.
- Preview for sanitized rendered Markdown.

### Exit demonstration

1. Import or create a representative multi-folder Markdown workspace.
2. Find documents by text, title, path, tag, and actor.
3. Edit and move a linked document without breaking its stable-ID link.
4. Compare two revisions and restore selected older content.
5. Resolve an external disk edit through the reconciliation UI.
6. Restore the database and workspace from a tested backup set.

### Explicitly deferred

Agent tokens and writes, editable HTML, public publishing, PDF reading, Karakeep, and chat.

---

## Phase 3 — Agents as real collaborators

> Implementation: [Phase 3 implementation and verification](./PHASE_3.md)

### Outcome

An external agent can safely work with Sangam documents through the same API as the human, with scoped authority, optimistic concurrency, attribution, and reviewable history.

### Vertical slice

An external agent searches the workspace, reads source material, creates a report under `/agents/`, attempts a scoped update, handles a real revision conflict, and leaves a complete history the human reviews in the browser.

### Included

#### Identity and authorization

- Persistent actor records for humans, agents, integrations, and system operations.
- Sangam-issued API tokens stored as secure hashes.
- Capabilities for read, search, create, update, move, tag, restore, and delete.
- Publishing remains non-grantable until Phase 4 provides the operation.
- Optional path restrictions such as `/agents/**` and `/generated/**`.
- Expiration, revocation, last-used time, and token labels.
- Deny-by-default authorization tests at the service layer.

#### Agent-facing API

- Stable JSON schemas and error responses for core document operations.
- Pagination and bounded search/read responses.
- Expected-revision update and structured `409 Conflict` response.
- Idempotent create and update operations.
- Agent-readable history and diff endpoints within granted scope.
- Audit-friendly request operation IDs.

#### Human review

- Actor badges and filters in document history.
- Human/agent change comparison.
- Recent agent activity view.
- Token creation, scope inspection, revocation, and rotation UI.
- Clear display of denied and conflicted agent operations without recording secrets.

#### CLI

- Token-authenticated remote use.
- Search, create, update, move, tag, history, diff, and restore commands.
- Machine-readable JSON output for external automation.

### Exit demonstration

1. Issue an agent token with workspace read/search and `/agents/**` write access.
2. Have an external agent search and read relevant documents.
3. Create and revise `/agents/research-report.md`.
4. Deny an attempted write outside its allowed path.
5. Produce a simultaneous human/agent edit, return a conflict, and have the agent re-read and retry safely.
6. Review all accepted changes, actors, diffs, and operation IDs in the browser.
7. Revoke the token and verify that subsequent access fails.

### Explicitly deferred

Built-in AI chat and general agent orchestration. Sangam provides document capabilities only.

---

## Phase 4 — HTML rendering and publishing

> Implementation: [Phase 4 implementation and verification](./PHASE_4.md)

### Outcome

Markdown and HTML documents can be rendered and published at stable URLs. Safe imported HTML and explicitly trusted interactive HTML execute under distinct security policies.

### Vertical slice

A human edits HTML, previews the safe rendering, publishes it, updates the source, and observes the stable publication URL follow the latest revision. An explicitly exposed revision remains addressable. A trusted interactive document runs JavaScript only on the isolated preview origin.

### Included

#### Markdown and safe HTML rendering

- Editable HTML documents with CodeMirror syntax support.
- `markdown-it` rendering followed by DOMPurify sanitization.
- Untrusted HTML sanitization and script-disabled sandboxed iframe.
- Relative workspace assets and internal document links.
- Rendered revision previews.
- Content Security Policy appropriate to each rendering zone.

#### Publications

- Publication records separate from documents.
- Stable slugs and stable latest-revision URLs.
- Explicitly exposed revision URLs using `?revision=<revision_id>`.
- Non-enumerable historical revision access.
- Private, public, and unlisted access policies.
- Asset authorization scoped to the Publication and revision.
- Unpublish and token-revocation behavior.
- Cache policy that does not serve stale authorization state.

#### External access

- Cloudflare Tunnel routes for app, publication, and preview hosts.
- Cloudflare Access for the application hostname.
- Separate public hostname outside Access for public/unlisted Publications.
- Mapping verified Access identity to the local human actor.
- No direct home-router port exposure.

#### Trusted JavaScript sub-slice

Trusted JavaScript is completed inside this phase but remains an independently gated security boundary:

- Trust is an explicit document property and attributed mutation.
- Dedicated preview hostname separate from the app origin.
- Short-lived HMAC tokens scoped to document, revision, assets, and expiry.
- Sandboxed iframe with `allow-scripts` and without `allow-same-origin`.
- Restrictive CSP and explicit network policy.
- Token-safe logging and referrer policy.
- Imported HTML remains untrusted by default.
- Cross-origin and asset-token tests through the real Cloudflare route.

### Exit demonstration

1. Edit and safely preview an untrusted HTML document containing attempted scripts.
2. Publish Markdown and HTML at stable URLs.
3. Change the source and confirm that the stable URL follows the latest revision.
4. Explicitly expose one historical revision and open its versioned URL.
5. Confirm that an unexposed revision cannot be retrieved or enumerated.
6. Render trusted JavaScript on the preview origin and demonstrate that it cannot access the application origin or credentials.
7. Exercise private, public, and unlisted access from outside the tailnet.

### Explicitly deferred

Static-site generation, themes as a product system, arbitrary routing, server-side rendering, and CMS workflows.

---

## Phase 5 — PDF research workspace

### Outcome

Sangam supports reading and researching immutable PDFs alongside Markdown and HTML documents.

### Vertical slice

A human opens a PDF, searches extracted text, highlights a passage, adds a note, links to the annotation from Markdown, edits the note, and sees the full actor-attributed annotation history without modifying the PDF bytes.

### Included

#### PDF document handling

- PDF import as a materialized immutable binary Document.
- PDF.js rendering, page navigation, zoom, and in-document search.
- Range-friendly document serving.
- Content hash and binary metadata.
- Explicit `supersedes` relationship when a replacement PDF is imported.
- No replace-in-place binary mutation.

#### Text extraction and search

- Background PDF text extraction.
- Persistent extraction status and retry behavior.
- Extracted text indexed through FTS5.
- Page-aware search results and snippets.
- Extraction failure visible without making the PDF unreadable.

#### Annotations

- Text highlights, area highlights, comments, page notes, bookmarks, citation markers, tags, and colors.
- Stable annotation IDs tied to the PDF document ID and page coordinates.
- Actor-attributed annotation creation, edits, and tombstones.
- Annotation concurrency/version checks.
- Annotation list and page markers.
- Markdown links to PDF pages and annotation IDs.
- Search across annotation text, selected text, and tags.

### Exit demonstration

1. Import and read a representative text PDF.
2. Search for a phrase and navigate to the correct page.
3. Create text and area highlights with notes.
4. Link to a page and annotation from Markdown.
5. Edit and remove an annotation while preserving its version history.
6. Verify the original PDF hash remains unchanged.
7. Import a replacement as a new Document connected by `supersedes`.

### Explicitly deferred

OCR, collaborative live cursors, annotation export, annotated-PDF generation, and in-place PDF editing.

---

## Phase 6 — Karakeep confluence

### Outcome

Selected archived web content flows from Karakeep into Sangam as editable, attributable documents without displacing Karakeep as the archive of record.

### Vertical slice

A human selects a Karakeep bookmark, imports it once, compares the archived source with extracted Markdown, corrects the working copy, re-runs the import safely, and retains source provenance plus revision history.

### Included

#### Connection and selection

- Karakeep API configuration and credential handling.
- Connection health and permission checks.
- Bookmark search/list and selective import.
- Import identity keyed by Karakeep reference to prevent accidental duplication.

#### Import pipeline

- Source URL, Karakeep ID, title, author, timestamps, tags, and available attachments.
- Retrieved page content and extraction metadata.
- HTML-to-Markdown conversion into an editable Sangam Document.
- Imported source and corrected working copy displayed together.
- `integration:karakeep` attribution for import revisions.
- Manual and agent-assisted corrections as ordinary attributed revisions.
- Persistent import status, retry, and failure details.

#### Repeat imports

- Explicit refresh instead of silent source replacement.
- Comparison between new extraction, prior extraction, and corrected working copy.
- No overwrite of human corrections without a reviewed merge or separate revision.
- Idempotent handling of tags and attachments.

### Exit demonstration

1. Select and import a bookmark containing text, metadata, tags, and an attachment.
2. Verify provenance back to Karakeep and the original URL.
3. Correct the generated Markdown and observe an attributed revision.
4. Run the same import again without creating a duplicate document.
5. Refresh changed source content without silently overwriting corrections.
6. Search the imported article alongside native Sangam documents.

### Explicitly deferred

Replacing Karakeep, continuously mirroring every bookmark, generic website crawling, and a universal bidirectional synchronization framework.

---

## Phase 7 — Workspace-grounded AI chat

### Outcome

Sangam provides a workspace-grounded chat client that uses the mature document API while leaving model execution and agent orchestration to external infrastructure.

### Vertical slice

A human asks a question about the current document and related workspace material. The runtime searches and reads documents, cites exact sources, reads a referenced PDF annotation, proposes an edit, and streams a visible tool trace. The human reviews the diff before choosing whether to apply the normal attributed document update.

### Included

#### Runtime boundary

- Minimal `AgentRuntime` streaming interface.
- One external runtime integration only.
- Provider/model configuration outside the document service.
- No general workflow builder or agent scheduler.

#### Context and tools

- Current-document context.
- Selected-text context.
- Workspace search and bounded document reads.
- PDF page and annotation reads.
- File and revision citations.
- Tools for search, read, create, propose update, and publish according to actor capability.
- Proposed edits represented as diffs against an expected revision.
- Accepted edits applied through the normal document API.

#### Chat experience

- Right-side chat panel.
- Streaming tokens and structured runtime events.
- Visible tool start, result, citation, proposed edit, completion, and error states.
- Conversation and message history.
- Stop, retry, and recoverable stream interruption.
- Diff review before applying proposed edits.
- Clear actor identity for chat-originated mutations.

#### Transport and operations

- Server-Sent Events from runtime to browser.
- End-to-end streaming test through Cloudflare Tunnel and Access.
- Proxy-buffering detection and operational diagnostics.
- Bounded tool results and context sizes.
- Secrets and token redaction from stored events and logs.

### Exit demonstration

1. Ask a question using current-document and selected-text context.
2. Search and cite multiple Sangam documents.
3. Read and cite a PDF page or annotation.
4. Display each tool call and result while streaming.
5. Produce a proposed edit based on the current revision.
6. Create a concurrent edit, detect the conflict, and require regeneration or rebase before application.
7. Apply the approved edit through the normal API with complete attribution and revision history.
8. Stop and retry a stream through the production Cloudflare route.

### Explicitly deferred

General-purpose agent orchestration, autonomous background agents, multi-agent workflow design, model hosting, and hidden privileged tools.

---

## Completion of the seven phases

After Phase 7, Sangam satisfies the product capabilities in the vision: ordinary-file documents, stable identity, versioned human and agent collaboration, workspace search, safe and trusted rendering, PDF research, Karakeep import, publishing, and grounded chat through one document API.

This document defines direction and phase boundaries. Phases 1 and 2 now have concrete implementation documents linked from their sections. Phases 3–7 remain directional until evidence from the running system makes their detailed planning timely.
