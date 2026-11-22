# ADR 0004: Search passage extraction, PDF durability, and revision-pinned publishing

## Status

Accepted

## Context

Sangam indexes Markdown, HTML, PDF pages, and annotations in SQLite FTS5, stores immutable PDFs on disk, and publishes pinned document revisions over HTTP. These subsystems balance latency on large corpora with strict consistency and idempotency guarantees.

## Decision

1. **Post-`LIMIT` passage location (`service.py`, `search_passages.py`, `chat_tools.py`, `schemas.py`)**
   - Running SQLite FTS `snippet()` inside the query executes on every matching document before `LIMIT`. Instead, FTS ranks and pages matching documents, and Sangam locates up to `MAX_MATCHES = 3` passages afterward for only the returned page (`search_matches` is populated on search results and `null` elsewhere).
   - Passage scanning caps hits at `MAX_HITS_PER_SOURCE = 200` so repetitive documents stop early while still finding the densest window.
   - PDF page queries prefilter using SQLite `instr(lower(text), prefix) > 0`; because SQLite `lower()` folds ASCII only, the SQL filter is purely a prefilter and the Python regex makes the exact match decision.
   - Snippets stay within paragraph boundaries (headings are reported separately in `heading`), escape literal `[[` and `]]` to `[ [` and `] ]` so clients do not misinterpret them as highlight markers, and use a stable sort to preserve source priority (`text`, then `pages`, then `annotations`) within equal scores.
   - Chat search results include `page_number` when a hit comes from a PDF so responses can cite the exact page.

2. **PDF import reconciliation and background extraction (`pdf_research.py`, `pdf_runtime.py`)**
   - If a PDF import was interrupted after the durable file rename on disk but before SQLite committed, retry adopts the existing file only when its SHA-256 matches the caller's exact bytes; a different file remains a validation conflict.
   - Background extraction atomically claims a pending PDF row in SQLite before spawning the parser subprocess so concurrent workers never double-parse the same document.
   - Parser subprocess stderr/stdout diagnostics are redirected to a temporary file (`parser.log`) rather than an in-memory pipe so noisy corrupt PDFs cannot exhaust memory.
   - Every parser failure (including plugin errors) is persisted in SQLite so the UI can surface status and offer retry.

3. **Revision-pinned publications, conditional headers, and metadata idempotency (`publication.py`, `conditions.py`, `service.py`, `schemas.py`, `activity.py`, `security.py`, `projects.py`)**
   - Publications pin an immutable `revision_id` that readers see until deliberately updated, while also returning `document_revision_id` (current head) so clients can detect draft drift. Creating a publication defaults `revision_id` to the current head; patching omits `revision_id` to keep the published revision unchanged.
   - Publication idempotency fingerprints include `revision_id` only when explicitly supplied so retries from clients that did not specify a revision continue to match.
   - Metadata-only document updates bind their idempotency key to the unchanged head revision (`revision_id` is `None` for non-document resource mutations in `idempotency.py`).
   - HTTP `If-Match` / `If-None-Match` parsing follows RFC list syntax: empty list members between commas are skipped, while a wholly empty header value is rejected.
   - Cross-surface changes (such as chat effects) record `via` (for example `"chat-effect:<id>"`) and `approved_by` on `Principal` and in `operation_events.detail_json`, allowing activity queries to filter by surface prefix (`LIKE '{via}-%'`).
   - Project creation clears any prior audit target set by an auto-created brief document in the same transaction so the outer project operation records the project ID as its target.
   - Choosing a project draft updates active tab selection while preserving saved sources and split groups.

## Consequences

- Search, PDF extraction, and publication changes must preserve bounded scan budgets, SHA-256 adoption checks, and revision-pinning semantics.
