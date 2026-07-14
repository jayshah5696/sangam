---
title: Sangam
type: project-definition
status: vision-locked
stack-refreshed: 2026-07-13
tags: [project/sangam, self-hosted, documents, agents]
created: 2026-07-13
---

# Sangam

> Implementation direction: [Seven vertical phases](./IMPLEMENTATION_PHASES.md)

> A single-user, self-hosted **document server** where every document — regardless of type or storage — is created, edited, versioned, searched, annotated, and published through one small API that a human and identified AI agents share as equals.

*Sangam* (संगम) — a confluence. The point where your files, your notes, your web clips, your PDFs, and your agents meet in one place.

---

## 1. Vision

Build a lightweight, self-hosted workspace around ordinary files.

Sangam lets one human and a set of trusted AI agents create, edit, organize, search, review, annotate, and publish Markdown, HTML, PDF, image, and imported web content. The human runs it on their own home server and uses it themselves. Agents collaborate through the same interfaces the human uses — no privileged backdoors.

Sangam is **not** trying to become an IDE, a note-taking platform, an agent framework, a document-management suite, or a CMS. It is a document server with good clients.

### The one-line mental model

The **backend is a document server**. Editing, rendering, PDF interaction, chat, publishing, the CLI, and external agents are all **clients of its small, uniform API**. This is the architectural spine and it is protected above all else.

---

## 2. Load-bearing invariants

These six invariants are what keep Sangam coherent and small. Every future decision is checked against them.

1. **The document is the atom.** One uniform `Document` abstraction across all content types (Markdown, HTML, PDF, image) and all storage modes. Everything — editing, versioning, search, annotation, chat, publishing, agent access — operates on Documents.

2. **The API is the only writer of truth.** Every mutation — human, agent, or import — flows through the same service layer. There are no out-of-band writes and no backdoors. *This single decision removes the need for a live filesystem watcher and eliminates a large class of sync complexity.*

3. **Every change is attributed and recoverable.** Every accepted mutation records the actor and creates an immutable revision or versioned annotation event. This one mechanism *is* both the trust model for human+agent collaboration and the change-management story.

4. **Files stay files.** Materialized content is portable, inspectable, and backup-friendly on disk. SQLite is the canonical identity / revision / metadata layer; the workspace file is the durable materialized form of the current revision. SQLite is the sole content store only for documents not yet materialized to disk.

5. **Agents are first-class, identified collaborators — not privileged internals.** They use the same API as everything else, authenticate with scoped tokens, have attributed writes, and are held to optimistic-concurrency rules.

6. **Deliberately small complexity budget.** One application process, one SQLite database, one workspace directory, one home server. Every additional moving part must justify itself against this budget. No Redis, PostgreSQL, Elasticsearch, Kubernetes, or vector database.

---

## 3. Two reframes that shape everything

### Reframe A — There is no user-facing "virtual" document

A document always exists the moment it is created: it has a stable ID, content, and revisions. Whether it has been **materialized to a filesystem path** is an internal storage detail plus a user action ("save to disk").

- **Unmaterialized** documents live entirely in SQLite. Good for agent drafts, temporary plans, generated reports, imported content awaiting review, chat-generated artifacts, unsaved work.
- **Materialized** documents are also stored as normal files on disk under the workspace directory.

Converting unmaterialized → materialized is a non-event: the document's **stable ID never changes**, so revisions, annotations, chat citations, and published URLs all keep pointing at the same thing. The user just sees "documents"; they never reason about "physical vs virtual."

### Reframe B — Publishing is a projection, not a second system

A Document can have a **Publication**: a read-only rendered view at a stable URL with an access policy. It is a *lens* on an existing document, not a separate content pipeline. This keeps Sangam out of CMS / static-site-generator territory.

---

## 4. Identity model (foundational)

**Every document has a stable internal `document_id`. The filesystem `path` is an attribute of materialized documents, never the identity.**

Everything references the ID: revisions, annotations, chat citations, publications, agent operations. Because Sangam is the sole writer of the workspace (Invariant 2), the ID↔path mapping is always maintained by the app itself — external renames that would otherwise break the mapping simply do not happen during normal operation.

---

## 5. Supported content

- Markdown
- HTML
- PDF
- Images
- Web articles imported from Karakeep
- Agent plans, reports, and generated artifacts

*(Video is out of scope for the initial product.)*

---

## 6. Document storage

### Materialized documents

Stored as normal files inside configured workspace directories:

```text
/workspace/research/
/workspace/projects/
/workspace/web-clips/
/workspace/published/
/agents/
/generated/
```

### Unmaterialized documents

Stored inside SQLite, exposed through the identical document interface. May be materialized to a path later without changing identity.

### Source of truth & write protocol

SQLite is authoritative for document identity, the current revision pointer, revision history, and materialization state. For a materialized document, the workspace file is a normal-file projection of the current revision. API reads resolve through the current SQLite revision; the file's recorded hash confirms whether its materialization is current.

A content update follows one recoverable protocol:

1. Validate the actor's capability and the client's expected current revision.
2. In one SQLite transaction, append an immutable revision, advance the document head, and mark materialization as pending.
3. Write materialized content to a sibling temporary file, flush it, and atomically rename it over the destination.
4. Record the resulting file hash and mark materialization clean.

If the process stops between the database commit and the atomic rename, the committed revision remains the source of truth and startup recovery completes the pending materialization. A failed materialization is visible state, not a silent partial success. Mutations carry an idempotency key so retrying after an interrupted response returns the original result instead of creating a duplicate revision.

Unmaterialized documents use the same protocol without the filesystem steps.

### Sole-writer model & reconciliation

Sangam **owns** the workspace directory. In normal operation, nothing writes to it except Sangam. Therefore:

- **No live filesystem watcher.** The app already knows every change because it made every change.
- **Reconcile scan on startup** detects anything that changed while the app was down.
- **Manual `reindex` command/endpoint** handles the rare intentional out-of-band change (restored backup, bulk file drop).

A live watcher remains an explicit *future* option if real-time external editing ever becomes a goal. It is deliberately excluded now.

Reconciliation is conservative and never silently rewrites history:

- **Database head present, file missing:** re-materialize the current revision. A missing file is not interpreted as a document deletion.
- **Known path, unexpected file hash:** create a reconciliation conflict. The user may import the disk content as a new revision attributed to `system:reconcile`, or overwrite it by re-materializing the database head.
- **Old path missing, unknown path with a unique matching head hash:** infer an out-of-band move and preserve the document ID. Ambiguous matches become conflicts.
- **Unknown file:** register it as a new document through an attributed import during explicit reindex. Startup scan may report it, but does not silently ingest it.
- **Pending materialization:** finish it from the committed revision and verify the resulting hash.

Reconciliation never silently deletes a document, advances its head, or guesses when identity is ambiguous. Out-of-band changes have an honest system attribution because their original actor is unknowable.

---

## 7. Version history

Every accepted content write records the actor and creates a new immutable revision. A revision is never amended in place.

A revision records:

- Document (by stable ID)
- Parent revision
- Timestamp
- Actor (human / agent / import / system)
- Content snapshot **for text documents** (Markdown, HTML, extracted text)
- Content hash + metadata **for binary documents** (PDF, image)
- Optional change summary
- Related operation

### Text vs binary versioning

- **Text (Markdown/HTML):** full-content snapshots. Full snapshots are used initially instead of compressed deltas.
- **Binary (PDF/image):** source bytes are immutable after import in the initial product. PDFs normally change through annotations, which are stored and versioned separately (§10). If source bytes genuinely need replacement, the replacement is imported as a new Document and may record a `supersedes` relationship to the old one. This keeps old binary content recoverable without maintaining a large-blob revision store.

### Save semantics — debounced autosave

The editor may debounce or coalesce local keystrokes before sending an update, so typing does not create a revision per character. Once the API accepts an update, however, it always creates exactly one immutable revision. The server never folds a later write into an existing revision. An explicit "snapshot now" action flushes pending editor state immediately.

### The user can

- Browse history
- Compare revisions (additions/removals)
- Restore an older revision
- Copy content from a revision
- See which actor made each change

---

## 8. Collaboration, concurrency & agents

Agents are identified collaborators, e.g.:

```text
human:jay
agent:researcher
agent:planner
agent:openclaw
integration:karakeep
```

### Capabilities

Read · Search · Create · Update · Tag · Publish · Restore · Delete.

Agents may write **directly** into trusted zones such as `/agents/` and `/generated/`. Writes to normal user documents are allowed but are reviewed **after the fact** through revision history and diffs — there is **no pre-commit proposal/approval queue** in the initial product. Full revision history *is* the change-management mechanism.

### Optimistic concurrency (the safety guard)

Every write includes the **expected current revision**. On mismatch the API returns **409 Conflict** with the current head; the client must rebase/merge and retry. This is what prevents an agent from silently overwriting newer human changes. It is the entire silent-overwrite safety story, and it gets its own tests.

---

## 9. Agent & client interfaces

The same core operations are exposed through:

- HTTP JSON API (the source of truth all clients use)
- Command-line client
- Internal AI chat tools
- Python client library (when useful)

Core operations:

```text
documents list
documents read
documents create
documents update
documents move
documents delete
documents search
documents history
documents diff
documents restore
documents publish
```

Sangam provides document capabilities. It does **not** implement a general-purpose agent framework.

---

## 10. PDF reading & annotations

Original PDF files remain unchanged. Reading activity changes highlights, notes, bookmarks, tags, and other annotations—not the PDF bytes. Annotations are stored **separately**, reference the document by stable ID, and retain actor-attributed version history when edited or removed.

Annotation types: text highlight · area highlight · comment · page note · bookmark · citation marker · tags.

Each annotation may store: PDF document, page number, selected text, coordinates, note, tags, color, actor, timestamp.

Markdown documents may link directly to a PDF page or annotation. Annotations should be exportable later as JSON, Markdown notes, or an annotated PDF (export formats are a later addition).

---

## 11. Search & organization

SQLite FTS5 indexes: paths · titles · Markdown content · extracted HTML text · extracted PDF text · notes · highlights · tags · authors · source URLs · revision summaries.

Filters: content type · tag · author · source · location · modification date · human/agent actor · published status.

Index maintenance runs off the revision write path; slow extraction (PDF/HTML text) is handled by the background worker so it never blocks interactive operations. Semantic search and embeddings are an explicit later addition — no vector database now.

---

## 12. Karakeep integration

Karakeep remains the web-archive of record. Sangam:

- Connects via the Karakeep API
- Imports selected bookmarks
- Preserves the original URL and Karakeep reference
- Retrieves page content and metadata
- Converts extracted content into editable Markdown
- Displays source and extraction together
- Allows manual or AI-assisted correction
- Records corrections as revisions
- Imports tags, highlights, and attachments where possible

The corrected Markdown becomes the editable working copy; Karakeep keeps the original archive.

---

## 13. AI chat

The right sidebar hosts a workspace-grounded chat supporting: streaming responses · conversation history · current-document context · selected-text context · workspace search · PDF page/annotation context · file citations · tool-call visibility · proposed document edits · diff review · stop/retry.

Model providers, web search, and complex workflows are supplied by **external agent infrastructure** through a small runtime interface. Sangam does not orchestrate agents itself.

```python
class AgentRuntime:
    async def stream(self, messages, context, available_tools):
        ...
```

Built-in chat tools:

```text
search_documents
read_document
read_pdf_page
list_annotations
create_document
propose_document_update
publish_document
web_search
```

Runtime events:

```text
token · tool_started · tool_result · citation · proposed_edit · completed · error
```

Transport is **Server-Sent Events** (simpler than WebSockets for one-directional token/tool streaming). Note: SSE streaming must be verified end-to-end through the Cloudflare Tunnel early, since proxy buffering can stall token delivery.

---

## 14. HTML rendering (full: safe + trusted-JS)

HTML supports source editing and rendered preview. All previews render inside an **isolated iframe**. Sangam ships the **full** two-policy model, including trusted JavaScript execution.

Preview must support: CSS · images · tables · local workspace assets · relative links · internal document links · responsive layouts · optional JS for trusted documents.

### Policy is driven by the document's `trusted` flag

**Untrusted / imported HTML (default):**

- Sanitized with DOMPurify
- Rendered in a sandboxed iframe with **scripts disabled**
- Relative workspace asset URLs rewritten
- Internal links intercepted

**Trusted HTML (created by the human or trusted agents):**

- May execute JavaScript
- Rendered under a **separate origin** with a restrictive Content Security Policy
- `sandbox="allow-scripts"` deliberately **without** `allow-same-origin` (scripts get an opaque origin)

### Separate-origin design (the hardest single piece)

Trusted JS must never run on the app's own origin. It runs on a dedicated preview origin:

```text
app.example.com       # SPA + API (behind Tailscale / Cloudflare Access)
preview.example.com   # dedicated preview origin
```

**Auth for the preview origin uses short-lived signed tokens, not Cloudflare Access cookies.** Putting the preview behind Access and loading it in a cross-origin iframe breaks under third-party-cookie restrictions. Instead:

- The app **mints an HMAC token** scoped to `document_id` + `revision` + expiry when rendering a preview.
- The preview origin **validates the token itself** (no cookies, no Access).
- Local assets and relative links resolve **through the preview origin under the same token scope**.

This commits the project to: a second hostname/route through Cloudflare, a signed-URL scheme, and treating the preview as a small standalone concern.

---

## 15. Publishing

Selected Markdown and HTML documents can be published as read-only Publications at stable URLs.

The stable publication URL resolves to the document's latest revision by default. A specific revision can be requested when required, for example:

```text
/p/project-report
/p/project-report?revision=<revision_id>
```

Revision selection uses the same publication access policy. Historical revisions are not enumerable, and a revision is available through a publication URL only after it has been explicitly exposed for that Publication; publishing a document must not accidentally expose its entire private history.

Access policies: private (authenticated) · public · unlisted (access token). Publications render Markdown or HTML with embedded workspace assets.

Because Cloudflare Access blocks unauthenticated requests before they reach the server, **public/unlisted publications cannot sit behind the same Access policy as the app.** They live on a separate public hostname; unlisted access is enforced by Sangam's own token check. Sangam is explicitly **not** a full static-site generator or CMS.

---

## 16. Authentication & access model

Three auth zones:

| Zone | Route / host | Auth mechanism |
| --- | --- | --- |
| App + admin | Tailscale (primary) · `app.` via Cloudflare Access | Cloudflare Access (Google / email OTP), Tailscale identity |
| Agent API | `app./api` | Sangam-issued scoped tokens (optionally + Access service token) |
| Publications (public/unlisted) | separate public host, e.g. `pub.` — **outside Access** | none (public) or Sangam publish token (unlisted) |
| HTML preview | `preview.` | Sangam-minted short-lived signed URL |

### Human browser access

Cloudflare Access sits in front of the exposed app: Google login, email OTP, access policies, session enforcement, blocking unauthenticated requests before they reach the server. Sangam keeps a lightweight local user record but implements no passwords.

### Agent access

Application-issued API tokens, each with: actor identity · allowed capabilities · optional path restrictions · expiration · revocation · last-used timestamp.

```text
agent:planner
  read: /**
  search: /**
  create: /agents/**
  update: /agents/**
  publish: false
  delete: false
```

---

## 17. Networking — Tailscale + Cloudflare

Both, for different jobs. Never expose the mini server's ports directly through the home router.

```text
Tailscale (private, own devices)      Cloudflare (browser access + published pages)
  full workspace                        authenticated workspace (Access)
  administration                        authenticated API if required
  API management                        public / unlisted publications
  backups                               HTML preview origin
  internal preview
```

- **Tailscale Serve** is the preferred private route for the user's own devices.
- **Cloudflare Tunnel + Access** handles browser access from devices without Tailscale, plus published pages and the preview origin.

---

## 18. Technology decisions

Stack pinned to **July 2026** current stable. Every choice below is either the modern default or an explicit deviation with reason.

### Frontend

- **TypeScript 6** for the Phase 1 supported toolchain. TypeScript 7 is published, but the current `typescript-eslint` release still declares support below TypeScript 6.1; Sangam will move once the lint toolchain supports it without peer-dependency overrides. Strict mode is enabled from day one.
- **React 19** (stable, 19.2.x). Actions, `useActionState`, `useOptimistic`, `useFormStatus`, React Compiler. `useOptimistic` is a near-perfect fit for the 409-conflict / rebase flow around optimistic concurrency (§8).
- **Vite 8** — client-side SPA only. No SSR: no value for an authenticated workspace. Phase 1 uses the current stable Vite release recorded in the frontend lockfile.
- **TanStack Router** — file-based, end-to-end type-safe routing (params, search params, loaders). Sangam has real route complexity (documents, tabs, splits, PDF pages, revisions, publications, previews) — plain React Router leaves type safety on the table. Not TanStack Start (that's a full-stack meta-framework; Sangam's backend is Python).
- **TanStack Query** — the standard data-fetching / cache / mutation layer. Handles revalidation, optimistic updates, and pairs cleanly with the optimistic-concurrency flow.
- **Tailwind CSS v4** — CSS-first config via `@theme`, OKLCH colors, 3.5–8× faster builds, no `tailwind.config.js`.
- **shadcn/ui** — copy-paste components you own (not a dependency), fully migrated to Tailwind v4 + React 19. Directly supplies the components Sangam needs — **Resizable** (replaces a standalone panel library), Sidebar, Tabs, Dialog, Command, ScrollArea, Sheet, Tooltip, Toast. No IDE window managers; no arbitrary nested layouts initially.
- **CodeMirror 6** for Markdown/HTML source editing. Modular, mobile-capable, tree-shakeable. Chosen over Monaco (IDE-heavy, no mobile) and Lexical (rich-text, wrong category). Source editing, search/replace, line numbers, syntax highlighting, keyboard shortcuts, selection tracking, agent edit markers. Separate diff component for revision comparison. No language server.
- **markdown-it** (+ tables, task lists, footnotes, anchors, syntax highlighting) → **DOMPurify** after rendering.
- **pdfjs-dist** used **directly** with a thin custom annotation layer (text-selection highlights, area highlights, notes, page nav, search, markers). Do **not** adopt `react-pdf-viewer` — it was archived March 2026, vindicating the "no abandoned wrappers" policy.
- **Zod** for runtime schema validation on the frontend (mirrors Pydantic on the backend).

### Backend

- **Python 3.13+** (3.14 optional; free-threaded stable in 3.14 but Sangam is I/O-bound so not needed for v1).
- **uv** — the de facto Python toolchain in 2026 (single Rust binary from Astral, replaces pip/pipenv/poetry/pyenv/virtualenv/pipx, 10–100× faster). Project managed via `pyproject.toml` + `uv.lock`.
- **Ruff** — lint + format (Astral). `ty` (Astral's Rust type-checker) optional while still alpha; mypy/pyright acceptable interim.
- **FastAPI + Pydantic v2.** Rationale: agent/extraction workflows already Python-oriented; typed request models give a clean API contract; async + streaming supported; document-processing libraries richer in Python; one service layer serves HTTP routes, CLI, imports, and chat tools. **Litestar** is technically better in 2026 (msgspec default, batteries-included), but its ecosystem edge collapses under real DB workloads — flagged as the alternative if aggressive performance is ever needed; not the default.
- **uvicorn** as the ASGI server. **Granian** (Rust-based, drop-in, ~1.5–2× throughput) is a cheap upgrade option if profiling ever asks for it.

```text
FastAPI
  document service
  revision service
  search service
  annotation service
  Karakeep importer
  publish service
  agent runtime adapter
```

Start with one process. Add the background worker only when imports/extraction begin blocking interactive operations (PDF/HTML text extraction for the index is the first candidate).

### Database — SQLite

Plain SQLite with WAL mode · foreign keys · FTS5 · JSON columns where appropriate.

Deliberately **not** libSQL / Turso / Turso Database (edge/distributed use cases don't apply to a single-user home server; Turso's row-read pricing is a documented cost trap; the new Turso Database Rust rewrite is still beta). Also not Convex, PocketBase, Supabase, or PostgreSQL — same reasoning as before.

Data-access layer: **thin custom SQL** or **SQLAlchemy 2** (async, typed). For Sangam's small schema, thin custom SQL is likely cleaner than an ORM.

Likely tables:

```text
documents              -- id, kind(materialized/unmaterialized), content_type,
                       --   path(nullable), title, current_revision_id,
                       --   content_hash, size, trusted, published_*, actor, timestamps
revisions              -- text snapshots; binary = hash + metadata
actors
actor_tokens
tags
document_tags
annotations
imports
publications
chat_threads
chat_messages
search_index
```

Notes:

- Head content of an unmaterialized document = its latest revision; a separate `virtual_document_content` table is intentionally avoided as redundant.
- A standalone `operations` audit table is folded into revisions' actor/operation fields unless a separate audit trail proves necessary.

### Backup — Litestream

**Litestream** for continuous SQLite replication to S3-compatible storage. This is the modern SQLite-in-production pattern and complements (does not replace) the nightly snapshot + workspace-directory backup described in §20.

### CLI

Small Python CLI (**Typer** or `argparse`), managed and run through `uv`, calling the HTTP API by default (a direct local mode may come later):

```bash
sangam ls research/
sangam read research/paper.md
sangam search "agent memory"
sangam write agents/plan.md --file plan.md
sangam history research/paper.md
sangam diff research/paper.md --revision 17
sangam publish projects/report.html
```

### AI runtime

Minimal application-facing interface (§13). Integrate **one** external agent infrastructure first; do not build orchestration.

---

## 19. Deployment

Docker Compose, application as a single container initially:

```text
sangam-app
cloudflared
karakeep
```

Host-mounted state (SQLite + raw files live on the host, not in the image):

```text
/data/workspace/
/data/database/sangam.sqlite3
/data/backups/
```

Tailscale runs directly on the host (not in Docker) to keep routing/administration simple.

---

## 20. Backups

The backup unit:

```text
SQLite database + workspace directory + application config + secret config
```

- Nightly SQLite backup
- Nightly workspace snapshot
- Retention rotation
- Optional encrypted copy to an inexpensive object store or another personal machine

**Revision history is not a backup.** Deletion, disk failure, corruption, and application bugs can affect current documents and revisions alike.

---

## 21. Target capabilities (not an implementation plan)

These define the intended product shape. They do not yet establish build order, milestones, or the scope of a first implementation.

1. Open, edit, preview, and version Markdown and HTML files.
2. Render complete HTML documents safely (including the trusted-JS separate-origin path).
3. Search files and extracted document text.
4. Read PDFs and save highlights and notes.
5. Import and correct content from Karakeep.
6. Let an external agent create and update documents through the API.
7. Review agent edits through history and diffs.
8. Publish selected documents through stable URLs.
9. Access the system privately via Tailscale and externally via Cloudflare authentication.

---

## 22. Explicitly out of scope (initial)

Video · semantic search / embeddings / vector DB · annotation export formats · pre-commit proposal/approval queue · live filesystem watcher · Python client library · arbitrary nested window layouts · full static-site-generator / CMS features · IDE-grade language tooling.

---

## 23. Consolidated stack (July 2026)

```text
Frontend
  TypeScript 6           (strict; current ESLint-supported baseline)
  React 19               (Actions, useOptimistic, Compiler)
  Vite 8                 (client-side SPA, no SSR)
  TanStack Router        (type-safe file-based routing)
  TanStack Query         (data fetching / cache / mutations)
  Tailwind CSS v4        (CSS-first @theme, OKLCH)
  shadcn/ui              (owned components — Resizable, Sidebar, Tabs,
                          Dialog, Command, ScrollArea, Sheet, ...)
  CodeMirror 6           (source editing)
  markdown-it + DOMPurify
  pdfjs-dist             (direct — NO wrappers)
  Zod                    (runtime schema validation)

Backend
  Python 3.13+           (3.14 optional)
  uv                     (packaging / envs / Python versions)
  Ruff                   (lint + format)
  FastAPI + Pydantic v2
  uvicorn                (Granian as perf upgrade path)
  SQLite + FTS5
  Litestream             (continuous S3-backed replication)
  SSE streaming
  reconcile scan         (no live watcher — sole-writer model, §6)
  Optional background worker (extraction, imports)

Integration
  Karakeep API
  External agent runtime (single adapter)
  HTTP agent API
  Python CLI (via uv)

Access
  Tailscale Serve
  Cloudflare Tunnel
  Cloudflare Access                 (app + admin only)
  Scoped app-issued API tokens      (agents)
  Signed short-lived preview URLs   (HTML preview origin)

Deployment
  Docker Compose
  one app container
  host-mounted files + SQLite
  Tailscale on host (not in Docker)
```

**The decision to preserve above all:** the backend remains a document server; editing, rendering, PDF interaction, chat, publishing, and external agents remain clients of its small API.
