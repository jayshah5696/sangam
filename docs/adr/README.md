# Architecture Decision Records

Sangam records non-obvious implementation decisions in this directory instead of scattering them in inline code comments. Every ADR states the context, the decision, and the consequences or invariants that future changes must preserve.

## Index

| ADR | Title | Primary modules |
| --- | --- | --- |
| [0001](0001-lock-ordering-and-mutation-admission.md) | Lock ordering, audit admission backpressure, and shutdown draining | `access.py`, `mutations.py`, `activity.py`, `api.py`, `storage_ownership.py`, `chat_runtime.py`, `chat_store.py`, `pdf_runtime.py`, `mcp_server.py` |
| [0002](0002-security-boundaries-and-redaction.md) | Security boundaries, secret redaction, CSP isolation, and SSRF controls | `access.py`, `security.py`, `api.py`, `api_chat.py`, `authorization.py`, `document_assets.py`, `chat_profiles.py`, `chat_effects.py`, `ssrf_client.py`, `monty_worker.py`, `SelectableHtmlText.tsx` |
| [0003](0003-chat-runtime-proposals-and-assignments.md) | Chat runtime authority refresh, proposal lifecycle, and assignment durability | `chat.py`, `chat_capabilities.py`, `chat_continuity.py`, `chat_effects.py`, `chat_models.py`, `chat_proposals.py`, `assignments.py`, `assistant_requests.py`, `provider_connections.py` |
| [0004](0004-search-passages-pdf-and-publishing.md) | Search passage extraction, PDF durability, and revision-pinned publishing | `service.py`, `search_passages.py`, `pdf_research.py`, `pdf_runtime.py`, `publication.py`, `conditions.py`, `schemas.py` |
| [0005](0005-mcp-workspace-bridge-and-app.md) | MCP workspace bridge, self-contained App bundle, and draft checkpointing | `mcp_state.py`, `mcp_pdf.py`, `mcp_proposals.py`, `mcp_assistant_app.py`, `mcp_skills.py`, `frontend/src/mcp/` |
| [0006](0006-frontend-workbench-editor-and-chatkit.md) | Frontend workbench architecture, editor stability, and ChatKit lifecycle | `ChatPanel.tsx`, `WorkbenchView.tsx`, `DocumentWorkspace.tsx`, `MarkdownPreview.tsx`, `PdfViewer.tsx`, `documentSessions.tsx`, `workspaceEvidenceState.ts`, `frontend/src/styles/` |
| [0007](0007-no-implementation-comments-and-ratchet.md) | Banning implementation comments with ratcheted lint rules | `scripts/check_python_standards.py`, `frontend/tools/oxlint/anti-slop/rules/no-comments.ts`, `frontend/scripts/check-ui-system.mjs`, `.agents/skills/delete-comment/SKILL.md` |

## Adding a new ADR

1. Pick the next 4-digit sequence number (`0008-...`).
2. State the context, decision, and invariants concisely.
3. Add a row to the index table above and verify with `just test-docs`.
