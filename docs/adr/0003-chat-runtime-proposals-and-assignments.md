# ADR 0003: Chat runtime authority refresh, proposal lifecycle, and assignment durability

## Status

Accepted

## Context

Chat runs, MCP tool executions, background assignments, and asynchronous assistant requests outlive the HTTP request that created them. Token grants can be narrowed or revoked mid-run, users can pause or steer background assignments during model inference, and callers can disconnect while a mutation or acceptance record is committing.

## Decision

1. **Live authority refresh across long-lived runs (`chat.py`, `chat_continuity.py`, `mcp_server.py`, `mcp_events.py`, `assistant_requests.py`)**
   - Every chat entry point, tool call, effect decision, and MCP execution after a wait refreshes the principal's current token grants rather than trusting the principal captured at request entry.
   - Continuity history queries re-check current document and project authority per row and exclude inaccessible excerpts when access narrowed after the conversation was created.
   - MCP event subscriptions close the stream immediately on token expiry, revocation, deletion, or access loss rather than sending stale state under the original grant.
   - In `assistant_requests.py`, an incomplete source inventory cannot prove a narrowed read grant is sufficient, so it requires full workspace read authority.

2. **Agents SDK stream draining (`chat.py`, `scripts/run_chat_evals.py`)**
   - After calling `result.cancel()` on an OpenAI Agents SDK streaming run, drain `result.stream_events()` so provider tasks settle cleanly before the HTTP request releases its admission slot.

3. **Capability boundaries, effects, and proposals (`chat_capabilities.py`, `chat_effects.py`, `chat_proposals.py`)**
   - Chat annotations support only types that require no highlight geometry (`comment`, `page_note`, `bookmark`, `citation_marker`).
   - Project operations remain administrator-only in chat to match UI authority; outside-web tools are exposed only when web research is enabled; each tool's `guidance` is appended to run instructions only when that tool is granted to the run.
   - Preflight opens referenced projects and documents before approval so missing targets fail immediately rather than after human review.
   - In workspace YOLO mode, the operator pre-approves authorized effects, while the requester's own token authority still bounds what runs.
   - Dismissing a `stale` proposal is always permitted because its prior apply attempt already terminated and its idempotency reservation is spent. Only a `pending` proposal with an active `apply_idempotency_key` blocks dismissal so an in-flight document update cannot be dismissed mid-apply.
   - Active proposal applies are tracked per proposal under a lock while the database payload binding survives interruption and canonical document idempotency recovers commits.
   - Proposal citation `quote_start`/`quote_end` offsets use UTF-16 code units (including surrogate pairs for emoji) to match browser and editor offsets.

4. **Background assignments and assistant request durability (`assignments.py`, `assistant_requests.py`)**
   - Assignment control actions (`pause`, `stop`, `steer`) and finalization are serialized under `_control_lock`; stable idempotency keys and persisted model outputs recover committed writes without re-running inference.
   - Finalization merges model results into the latest persisted assignment record so a `pause`, `stop`, or `steer` acknowledged during inference is never overwritten.
   - Any provider or worker exception is persisted onto the assignment record so an assignment cannot remain stuck in `running`.
   - `assistant_requests.py` shields committed acceptance tasks with `asyncio.shield` so a disconnected caller cannot abandon acceptance, retrieves task exceptions in the done callback, observes active tasks with `asyncio.wait` without transferring cancellation ownership, and cancels active slots during shutdown before waiting on queued acceptance calls.

5. **Backward-compatible migrations (`chat_models.py`, `provider_connections.py`, `projects.py`)**
   - Legacy model catalogs stored before multi-connection support recover curated OpenRouter compatibility metadata instead of downgrading to `"unknown"`.
   - Environment provider configuration migrates only an untouched preset (`version == 1` and `health_status == "unknown"`); once edited, SQLite is authoritative across restarts.
   - Chat thread title lookup reads both versioned (`schema_version == 1` `payload`) and legacy unversioned metadata rows.
   - Document write capabilities map `"duplicate"` to `Capability.READ` on the source path and `"trust"` to `None` (administrator-only).
   - Continuity note fields accept empty text to dismiss a field while preserving the superseded value in version history.

## Consequences

- Long-lived agent and MCP code must never cache authorization decisions across awaits or overwrite concurrent user control signals.
