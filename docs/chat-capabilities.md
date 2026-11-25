# Chat capabilities and durable effects

Sangam chat is a bounded interface to the document server. The model can invoke
only capabilities that deterministic application code has already authorized for
the current run. It cannot grant itself new tools, write SQLite or workspace
files directly. Sangam's policy determines whether a proposal waits for review
or proceeds to automatic apply.

See [architecture.md](architecture.md) for the core trust model,
[operations/integrations.md](operations/integrations.md) for provider setup,
[chat-evals.md](chat-evals.md) for the live evaluation suite, and the
[capability lifecycle diagram](assets/chat-capability-lifecycle.html) (or static
[reference image](assets/chat-capability-lifecycle.png)) for the full request
and effect flow.

## Runtime contract

`ChatCapability` in `src/sangam/chat_capabilities.py` is the source of truth for
every model-visible operation. Each capability descriptor declares:

- A stable capability ID and integer version.
- Strict input and result models that reject unknown fields.
- One effect class: `read`, `propose`, `write`, or `external`.
- An approval policy.
- Required actor capabilities and path-scope behavior.
- Allowed chat entry points and supported document content types.
- Result byte limits and execution timeouts.

Each capability's tool handler lives in `ChatToolset`
(`src/sangam/chat_tools.py`) and checks the run principal's current token grants
on every call. Durable `write` and `external` capabilities also register a
`DurableEffect` in `ChatEffectService.durable` (`src/sangam/chat_effects.py`)
defining preflight before approval, execution after approval, and how to detect
whether the operation key already committed. Tool telemetry records metadata
only.

Before every run, the registry resolves the allowed tool set from the
authenticated principal, `WorkspaceAccessService` policy, chat entry point,
attached document, content type, model compatibility, and capability version.
Compact document chat and full workspace chat use this same resolver.

| Effect class | Model behavior | Application behavior |
| --- | --- | --- |
| `read` | Requests bounded evidence. | Authorizes each read and returns revision-aware citations. |
| `propose` | Prepares an edit to an existing document. | Stores a revision-pinned proposal. Review mode waits for explicit apply. YOLO mode attempts to apply chat proposals under the requester's authority. |
| `write` | Requests a private workspace mutation. | Persists an exact effect and waits for a digest-bound decision. |
| `external` | Requests an externally visible action (e.g., publishing). | Persists and reviews every material target and policy value before execution. |

## Turn and retry contract

Immediately before sending a user message, the browser creates one bounded turn
context containing the entry point, active document and revision, selected text
and its SHA-256 digest, active PDF page and selected annotation (when present),
and creation time. When the turn starts, the server binds the selected model and
resolved capability versions.

Retries load that original user-item context and reuse its document, revision,
selection, PDF page, annotation, model, and capability versions intersected with
current authorization. If a referenced revision was removed, the retry fails
clearly rather than substituting a newer revision or different model.

Turn contexts never include provider credentials. Run evidence records actor,
thread, model, status, available token counts, tool outcomes, latency,
citations, safe error classes, and provider correlation IDs. Ordinary prompt,
document, selection, and tool-result text is not copied into run evidence.

## Durable effect contract

Document creation, workspace organization, publication creation and updates, PDF
annotations, project changes, and chat profile or memory updates all follow one
durable lifecycle:

1. Validate model arguments against the capability's strict input schema.
2. Normalize arguments and compute a stable approval digest.
3. Persist the effect with requester, run, tool call, capability version,
   preview, expiry, and stable operation key.
4. Present the stored effect ID and digest to the browser for review.
5. Accept approval only from an administrator and only for the matching digest
   (a principal who can see the effect may deny it with the matching digest).
6. Recheck expiry, current authorization, and current resource state.
7. Execute through `WorkspaceAccessService` with the reserved operation key
   under the requester's authority.
8. Record the resulting resource ID or a safe failure record.

The browser never performs the domain mutation itself. The model run pauses at
the first durable effect. The browser returns the stored result to resume the
run. In YOLO mode Sangam records that result without waiting for a decision.
This keeps multi-effect turns sequential, avoids duplicate review cards,
and stops the model from claiming success before execution resolves.

Reloading the browser restores pending, completed, and failed effect state from
SQLite. Repeating a completed approval returns the original result. If a domain
mutation commits before the effect row updates, retrying with the reserved
operation key converges on the same resource. Interrupted effects left in
`approved` or `executing` state expose a resume action bound to the stored
approval and operation key. Before retrying a publication, the server checks
whether the operation key already committed so a committed publication recovers
even if the draft later moved ahead, while an uncommitted publication still
requires the exact approved revision.

Publication approval binds the document ID, exact revision ID, slug, and access
policy. If the document revision changes before commit, execution fails and
requires a new effect. Unlisted publication tokens are returned once to the
approving browser and are never stored in the chat effect record.

### Authority and audit

An approved effect always runs with the requester's authority, never the
approver's. Before execution, Sangam rebuilds the requester's principal from the
stored requester and token ID and rechecks current grants. If the requester was
removed or their token revoked, execution fails. Approving another actor's
effect cannot widen its permissions.

The activity ledger records both `via` (`chat-effect:<id>` or the proposal) and
`approved_by`. The Activity view includes a **Chat** filter (`via=chat`) for
chat-originated mutations. Projects and saved views enter through
`WorkspaceAccessService.audited`, so their denials and failures are ledgered
identically. A path-scoped token can create documents in chat only within its
own prefix (`preflight_create_document` rejects other paths and informs the
model of its allowed prefix).

### Workspace organization

- `inspect_workspace_organization` returns at most 100 authorized documents,
  folders, or tags per page with stable IDs, current revision or metadata
  versions, exact paths, tags, categories, and descendant counts. It never
  returns document bodies.
- `apply_workspace_organization_plan` accepts at most 100 exact operations:
  creating folders, creating tags (administrators only, checked in preflight),
  materializing pathless drafts, moving documents or folders, replacing
  metadata, trashing documents, restoring earlier revisions or trashed
  documents, and duplicating documents. A plan cannot apply a tag it creates
  because the new tag has no ID until committed; create the tag in one plan,
  inspect its ID, then apply it in a second plan.

Deterministic code normalizes paths and tag sets, rejects duplicate changes and
no-ops, and computes the approval digest. Before writing, the service rechecks
every source path, destination, revision, metadata version, descendant count,
tag ID, collision, and actor capability. Each item carries a stable child
operation key so interrupted retries converge cleanly. Explorer actions, the
command palette, REST calls, and chat all share this service through
`WorkspaceAccessService`. Partial results are always shown explicitly.

## Parity with the app

Chat exposes the same user-facing workspace actions through the same services
and authorization rules:

| In the app | In chat |
| --- | --- |
| Search with tag, category, and type filters | `search_workspace` takes the same filters and cites the PDF page of matches |
| Open a document with tags, category, trust level, and links | `read_document` returns the same metadata and content |
| Revision history and diff | `read_revision_history` lists revisions or diffs two revisions |
| Edit, create, publish | `propose_update`, `create_document`, `publish_document` |
| Change publication slug, policy, revision, or withdraw | `update_publication` (version comes from `read_document` for principals with publish authority) |
| PDF notes, comments, bookmarks, citation markers | `annotate_pdf` adds, edits, or deletes one annotation per review (highlights stay in the app because they need selection geometry) |
| Move, trash, restore, duplicate, tag, folders | `apply_workspace_organization_plan` through `WorkspaceAccessService` |
| List and open projects | `inspect_projects` |
| Create projects or attach and detach documents | `update_project`, one exact change per review |
| View and edit personal or project chat instructions | `inspect_chat_profile`, `update_chat_profile` |
| List, save, correct, accept, dismiss, and forget saved facts | `search_chat_memory`, `update_chat_memory` |
| Inspect and correct active task context | `inspect_task_state`, `correct_task_state` |
| Recall prior conversations | `search_chat_history`, `read_chat_history` |
| Research outside sources | `search_web`, `read_web_source` (only when web research is enabled) |

Capabilities with `requires_administrator` (such as project tools) are offered
only to administrators. System instructions include only the guidance for tools
available to that run, so the model is never told about tools it cannot call.

### Unavailable in chat by design

Trust-level changes, agent tokens, provider connections, backups,
reconciliation, Karakeep imports, binary PDF uploads, publication token
rotation, and geometric PDF highlights are intentionally excluded from chat.
They manage credentials, operate on infrastructure, or require binary or
coordinate input from the browser.

## Web research

Web research is off by default. Set `SANGAM_WEB_RESEARCH_ENABLED=true` and
`SANGAM_BRAVE_SEARCH_API_KEY` to enable `search_web` and `read_web_source`. When
disabled, the assistant is told web access is unavailable and answers from the
workspace alone.

- **Read-only authority:** Both tools require standard `read` capability and run
  without approval prompts. Web research never grants permission to save or
  publish.
- **Query isolation (`search_web`):** Accepts a short public query and optional
  `published_after` / `published_before` dates. Returns a stable source ID, URL,
  provider publication date (when present), retrieval timestamp, and snippet.
  The search provider receives the query, result limit, and optional date filters. The model is instructed never to send
  private workspace text, and evals verify canary text stays out of queries.
- **Guarded fetching (`read_web_source`):** Reads only a source ID returned by
  `search_web` in the same run, preventing arbitrary URL fetches or invented
  citations. Fetches use the same SSRF-guarded HTTP client as URL capture
  (standard HTTP/HTTPS ports, resolved IP checks, pinned connections, redirect
  revalidation, and size/type caps). PDF web sources are not read yet. Page text
  is marked `untrusted_content` so it acts only as evidence, never as
  instructions.
- **Provenance and time:** Each run records retrieved sources in
  `chat_web_sources` with query, retrieval time, and content hash. The assistant
  receives the server clock in UTC to resolve relative dates. Sangam has no
  user timezone for this purpose.

## Context, instructions, task state, and saved facts

### Saved instructions

Open **Instructions** in workspace or document chat to edit personal
instructions and instructions for the explicitly selected project. Project scope
always uses the stable project ID from the conversation entry point, never
folder paths or titles. Project entries belong to the user who saved them and
check current document membership.

Each entry holds up to 4,000 characters and requires the current version to save
or clear; stale saves preserve your draft and prompt you to reload. **Next turn
only** adds an optional 2,000-character override. Each submitted turn pins the
applicable instruction sources and versions. Approval continuations retain
that snapshot and recheck access. **Applied to the latest turn** displays it.
Clearing the override leaves saved instructions intact. Profile writes use
one audited service in the API and chat. In Review mode, chat shows the full
proposed instructions before saving.

Precedence order is fixed:

1. Application policy and tool contracts (cannot be overridden).
2. Latest user request.
3. Next-turn override.
4. Project instructions.
5. Personal instructions.

Retrieved documents and web pages cannot alter these sources or their
precedence. Sangam never scans filesystem instruction files.

### Active task and conversation history

Open **Instructions -> Active task** to inspect or correct the thread's
compacted task summary and jump to its original messages. Compaction runs
automatically inside the current request (with no tools) once history exceeds
`SANGAM_CHAT_MAX_CONTEXT_MESSAGES`. It maintains up to 12 typed fields (each up
to 600 characters with up to 4 source IDs) across at most 4 batches of 12
bounded excerpts per request. When older history exceeds that budget, the UI
flags incomplete coverage and the model can use history tools to read older
turns. Compaction token usage is included in the run's totals.

Corrections are versioned and preserve drafts on conflicts. Submitting empty
text dismisses a field key (up to 12 dismissed keys per thread) so compaction
will not recreate it. Source edits or deletion invalidate the summary for
rebuilding on the next turn without deleting original transcripts.

`search_chat_history` returns at most 10 owner-scoped excerpts (up to 1,200
characters each), excluding the current thread unless
`include_current_thread=true`. `read_chat_history` paginates by thread/message
ID and character offset. Project filters use explicit project IDs or
`project_threads` membership and recheck current document and project access.

Task summaries are fallible context: they never save facts or standing
instructions, grant authority, approve effects, or start background work. Live
effect status always comes from durable effect records. Reloading a thread
restores its context without restarting an interrupted request. Source links
open the exact message in the conversation's context dialog.

### Saved facts

Open **Instructions -> Saved facts** to manage personal facts and facts for the
explicitly selected project. Standing preferences belong in Instructions, not
facts. Facts supply context rather than directives or permissions.

Chat queries relevant active facts via bounded SQLite FTS rather than injecting
every fact into every turn. Inferred facts are created as suggestions and stay
excluded from recall until explicitly accepted. Entries hold up to 2,000
characters, searches return at most 20 items, and **Applied to the latest turn**
lists the fact IDs and versions read. An empty search lists entries for
explicit memory management. Review mode binds the exact action, scope, fact,
source references, and observed version. A correction or forget operation
removes the obsolete version from the current view. Delivered responses retain
their original wording.

Forgetting or dismissing a fact clears its canonical text and source links,
removes it from search, and retains a content-free tombstone and hashed
source-message reference so stale saves cannot reactivate it. An explicit request can save a new fact. Original conversations, durable
effects, idempotency records, backups, and audit records can retain earlier
text. Deleting a conversation is a separate action. Task summaries and prior
messages cannot create or restore saved facts.

## Autonomy modes and editorial review

### Review mode and YOLO mode

The default permission mode in **Settings -> AI & models** is **Review every
effect**, which pauses every durable effect for explicit approval. Switching to
**YOLO · run without approval** runs authorized effects without an approval
prompt, including publication. It also attempts to apply chat proposals using
the same revision and authorization checks. A failed apply remains a reviewable
proposal. Standalone MCP proposals and stale-proposal refresh candidates still
require explicit apply.

The chat panel shows the active mode. Pending organization plans list every
operation's before-and-after state, and completed effects collapse into a single
expandable summary. **Stop** persists cancellation, cancels unstarted effects,
and aborts the active stream. Starting a new thread cancels the active run and
clears its pending card.

### Exact editorial review

**Review changes** lists pending and stale document proposals. Each card
displays the proposed wording, an editable reviewed-wording field with a live
diff, editorial rationale, explicit judgment notes, validated supporting
citations with direct links, and retrieved sources from the run. Reviewers can
apply the proposal as drafted or with manual edits, request a revision, or
dismiss it. Deleted or unauthorized sources are redacted.

- **Exact wording and reservation:** Original model wording stays in `content`,
  while applied reviewed wording is stored separately in `applied_content` with
  its immutable `applied_revision_id`. Applying reserves the wording's SHA-256
  digest, reviewing actor, and operation key so only one apply runs at a time
  and exact retries by the same actor reuse the reserved operation key. A
  different actor or payload cannot replace an interrupted reservation.
  Validation, authorization, or deletion failures release uncommitted
  reservations. Revision conflicts mark the proposal stale and leave dismissal
  available.
  Committed reservations survive token revocation for recovery once the actor
  regains access, and recovery reads the exact committed revision from the
  operation record.
- **Supporting citations and retrieved sources:** Up to 20 supporting citations
  are validated against exact authorized revisions (`quote_start` and
  `quote_end` use UTF-16 offsets to match browser selections; repeated passages
  require an explicit offset or longer unique quote). An omitted revision ID
  resolves to the authorized current revision at proposal creation. Sangam
  checks PDF page and annotation relationships. Use `model_opinion` for
  interpretations and external claims. The review keeps turn context separate
  from cited support. The run records up to 50 distinct document, revision, and
  page references, including reads after proposal creation. The review flags
  omitted references. Identical wording from different runs keeps distinct
  proposal IDs and evidence. Older proposals without evidence show that status.
- **Revision requests:** **Prepare revision request in chat** opens the source
  thread. The composer includes your feedback, the exact reviewed wording,
  and the proposal, document, thread, and reviewed revision IDs. Choose **Send** to
  deliver the request. For stale proposals, the request can target the current
  revision while retaining the old reviewed revision in the feedback. The
  original proposal remains available.

## Relationship to experimental MCP

The optional, experimental [MCP workspace](mcp.md) uses the same document read
and write services, and MCP assistant requests run through the same ChatKit
pipeline with the connection's own inference and document grants, preserving
proposal and effect review behavior. The bridge provides request handles for
bounded waiting and recovery. It exposes neither broad history search nor
chat profiles. MCP workspace IDs and draft checkpoints are
external-host UI recovery state and are intentionally not controlled by internal
chat. Proposal review opens the shared apply/dismiss workflow, while other
durable effect approvals remain in internal chat. See
[mcp.md#sangam-assistant-requests](mcp.md#sangam-assistant-requests).

## Add a new capability

Follow these steps in order:

1. Define one user intent. Split mixed read-and-write behavior into separate
   capabilities.
2. Target an existing application-service operation. Add missing domain behavior
   to the service layer before adding chat code.
3. Choose the effect class: `propose` for existing-document edits, `write` for
   private mutations, `external` for externally visible actions.
4. Define strict, bounded Pydantic input and result models (reject extra fields;
   set string, collection, byte, and timeout bounds).
5. Declare actor capabilities, path-scope rules, entry points, content types,
   and model compatibility.
6. Choose the approval policy and ensure the review card shows every material
   argument.
7. Register the descriptor in `CAPABILITIES`, add the tool to `ChatToolset`, and
   for durable effects register a `DurableEffect` calling the application
   service.
8. Add tests for schema validation, authority, lifecycle, duplicate delivery,
   stale context, and abuse cases.
9. Add starter prompts or UI entry points only after the capability works in
   both compact and full chat.

Never use prompt text as a security boundary. Never add generic HTTP,
URL, filesystem, shell, SQL, or credential tools. Never write SQLite or workspace
files directly from a tool handler, return unbounded output, hide material
arguments from approval, or retry a durable effect with a fresh operation key.

## Verification

Capability changes must pass `just test` and the browser verification matrix in
`just test-e2e`. Tests must prove policy and lifecycle outcomes rather than
model prose. Keep adversarial test cases in
`tests/fixtures/chat_adversarial_cases.json` free of live secrets or private
data.

Browser coverage must verify compact and full chat, exact approval parameters,
deny and reload behavior, completed results, keyboard interaction, narrow
desktop (`390px`), and true touch mobile. Report Mobile Safari or physical
device checks as unverified unless actually executed.

## Design references

These references informed Sangam's vocabulary and safety boundaries:

- [OpenAI Agents SDK human-in-the-loop guide](https://openai.github.io/openai-agents-python/human_in_the_loop/):
  Per-call approval, serializable paused state, and resume behavior. Sangam
  persists a smaller domain-specific effect record owned by
  `WorkspaceAccessService`.
- [OpenAI Agents SDK usage guide](https://openai.github.io/openai-agents-python/usage/):
  Aggregate request and token accounting without copying prompt text.
- [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html):
  Least-privilege tools, exact previews, parameter-bound approvals, replay
  protection, independent policy checks, audit metadata, and adversarial cases.
- [OWASP LLM06: Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/):
  Constraining functionality, permissions, and autonomy in the registry and
  effect service.
- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/):
  Explicit capability discovery and handles for cross-call state. Internal chat
  keeps its own registry and SQLite IDs while the optional experimental MCP
  bridge is documented separately in [mcp.md](mcp.md).
- [AG-UI](https://github.com/ag-ui-protocol/ag-ui): Typed frontend tools,
  interrupts, and an observable agent/UI boundary. Sangam uses ChatKit with a
  narrow `review_chat_effect` client tool.
- [OpenTelemetry GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/):
  Metadata-first telemetry vocabulary without requiring an external collector.
