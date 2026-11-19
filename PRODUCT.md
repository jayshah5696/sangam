# Sangam Product Context

Sangam is a single-user, self-hosted document workspace where a human author
and identified AI agents work with ordinary files through one small,
revision-aware API. Every write carries an actor identity, an expected revision,
and an idempotency key so concurrent edits recover cleanly, agent actions stay
auditable, and AI edits arrive as explicit proposals instead of silent writes.

## Target User

- One owner operating a personal or solo-research workspace (locally via Docker
  or behind Cloudflare Access).
- Works across long-form Markdown notes, safe HTML artifacts, imported PDF
  sources, and structured research projects.
- Collaborates with AI assistants inside the workspace and external agents over
  scoped bearer tokens or the MCP workspace host.

## Core Workflows

1. **Document workbench (`/documents/:id`):** Edit, Split, and Preview modes
   for Markdown (with Mermaid rendering and wikilinks) and safe HTML, backed by
   immutable revisions, visual diff/restore history, comments, backlinks, and
   equal-width multi-group workspace tabs.
2. **Projects and ongoing work (`/` and `/projects`):** Organize an active
   draft, purpose brief, saved sources, categorized references, and persistent
   review items in one calm home view with saved layouts.
3. **PDF research and evidence:** Import immutable PDFs, search page text,
   highlight and annotate passages, attach page-pinned citations to drafts, and
   compare claims against sources.
4. **Review proposals (`/review`):** Inspect pending and stale AI edit
   proposals with contextual diffs, recorded turn context, and validated
   supporting citations before applying or dismissing changes.
5. **Publishing (`/publications` and `/p/:slug`):** Publish a pinned revision
   at a stable custom slug as private, unlisted, or public, with optional
   supporting evidence drawer and explicit drift detection when the draft moves
   ahead of the published version.
6. **Workspace chat and MCP host (`/chat`, `/mcp-host.html`):** Run
   workspace-grounded conversations that cite exact revisions and propose edits
   safely, with explicit turn-status feedback, cancellation, and review handoff.
7. **Scoped agent access and ops (`/settings`, `/activity`, `/reconciliation`,
   `/backups`):** Issue path- and capability-scoped bearer tokens with expiry
   and rotation, inspect immutable audit operations, reconcile canonical DB
   state against materialized files, and manage verified paired backups.

## Product and UX Principles

- **Explicit provenance over magic:** Always distinguish human edits from agent
  proposals, retrieved context from validated citations, and saved drafts from
  published revisions.
- **No silent data loss:** Optimistic concurrency (`expected_revision_id`),
  visible conflict recovery, and dirty-draft preservation take priority over
  convenience shortcuts.
- **Calm defaults:** Healthy, idle states stay quiet. Attention badges and
  status banners appear only when action or recovery is needed.
- **Mobile and keyboard parity:** Core reading, editing, review, settings, and
  MCP workflows must remain usable via keyboard and on narrow touch viewports
  without horizontal page scroll or clipped controls.

## Non-Goals

- Multi-tenant team collaboration, real-time CRDT cursors, or SaaS billing.
- Marketing landing pages, decorative dashboards, or speculative animations
  that compete with reading and writing.
- Silent autonomous writes that bypass expected-revision checks or human review.

## Related Documentation

- [README.md](README.md): quickstart, deployment, and documentation map.
- [DESIGN.md](DESIGN.md) and [docs/ui-system.md](docs/ui-system.md): visual
  grammar, tokens, motion, and verification gates.
- [docs/architecture.md](docs/architecture.md): trust model and data flow.
- [docs/chat-capabilities.md](docs/chat-capabilities.md): chat turn context,
  effects, and citation evidence contract.
