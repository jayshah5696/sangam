# ADR 0005: MCP workspace bridge, self-contained App bundle, and draft checkpointing

## Status

Accepted

## Context

Sangam exposes a local MCP server and a self-contained single-file MCP App HTML resource (`mcp-app.html`) that hosts can render inside sandboxed or opaque iframes. The bridge manages open tabs, unsaved drafts, PDF viewing, and proposal reviews while keeping canonical document writes durable and idempotent.

## Decision

1. **Server-side workspace state and idempotency (`mcp_state.py`, `mcp_pdf.py`, `mcp_proposals.py`, `mcp_assistant_app.py`)**
   - A single Sangam process owns storage; `McpWorkspaceState` uses a process-local `threading.RLock` to serialize draft/save transitions and clean-draft checks, while canonical document writes continue to use `DocumentService` locking.
   - Workspace layout queries project metadata columns only (`workspace_id`, `document_id`, `has_draft`) rather than reading every saved document body on tab refresh.
   - Save evidence is recorded inside the same SQLite transaction as the canonical document commit so a lost response cannot trigger a second save.
   - When an idempotent replay returns before opening a new transaction, PDF and proposal MCP handlers still reconcile their execution-key reference inside a transaction.
   - Proposal mutation failure recovery ignores `SangamError` when inspecting post-error state because lost authority cannot establish whether the original mutation committed.
   - Assistant App recovery reuses the accepted request context regardless of subsequent tab or draft edits.
   - MCP PDF annotation listing paginates results even though individual fields are bounded by the canonical annotation API.

2. **Self-contained MCP App frontend (`frontend/src/mcp/`)**
   - `PdfPane.tsx` imports the bundled `pdfjs-dist/build/pdf.worker.mjs` handler directly so opaque MCP App hosts work without external worker or network CSP grants, and keys PDF loading on `(document_id, current_revision_id)` so page navigation never reloads immutable revision bytes.
   - `markdown-highlighter.ts` builds a fine-grained Markdown-only Shiki highlighter for the self-contained MCP bundle (reusing Pierre's shared themes) so `mcp-app.html` stays compact while the main web app keeps the complete Shiki bundle.
   - `appearance.ts` translates Sangam semantic CSS tokens into the standard MCP host-style CSS custom properties.
   - `app.tsx` applies its read-only navigation guard synchronously via `flushSync` before taking the final checkpoint (because the host may tear down the frame right after acknowledgement) and drains any queued keystrokes against the outgoing document before replacing the active view.
   - `ProposalReview.tsx` clears a retry attempt only after a server-confirmed rejection (`outcome === 'rejected'`); ambiguous transport outcomes retain exact arguments and idempotency keys for safe retry.

## Consequences

- The MCP App bundle must remain self-contained, small (< 6 MB verified by `scripts/verify_mcp.py`), and resilient to host frame teardown and ambiguous network outcomes.
