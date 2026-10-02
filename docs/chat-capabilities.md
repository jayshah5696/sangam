# Chat capabilities and durable effects

Sangam chat is a bounded interface to the document server. The model may choose from capabilities that deterministic application code has already authorized. It cannot grant itself a tool, write SQLite or the workspace, or turn a proposal into an applied revision. See [architecture.md](architecture.md) for the core trust model and [operations/integrations.md](operations/integrations.md) for provider configuration. To measure changes to this contract, run the eval suite in [chat-evals.md](chat-evals.md).

The [architecture diagram](assets/chat-capability-lifecycle.html) shows the complete request and effect path. A static [reference image](assets/chat-capability-lifecycle.png) is available for reviews and pull requests.

## Runtime contract

`ChatCapability` in `src/sangam/chat_capabilities.py` is the source of truth for model-visible operations. Every descriptor declares:

- a stable capability ID and integer version;
- strict input and result models with unknown fields rejected;
- one effect class: `read`, `propose`, `write`, or `external`;
- an approval policy;
- required Sangam actor capabilities and scope behavior;
- allowed entry points and document content types;
- result byte and execution-time limits.

The agent tool for each capability lives in `ChatToolset` (`src/sangam/chat_tools.py`), which runs every tool against the run principal's current token grants. Durable `write` and `external` capabilities also register one `DurableEffect` in `ChatEffectService.durable` (`src/sangam/chat_effects.py`): its preflight before approval, its execution after approval, and how to tell that its operation key already committed. Tool telemetry records metadata only.

The registry resolves the tool set for every run from the authenticated principal, `WorkspaceAccessService` policy, chat entry point, attached document, content type, model compatibility, and capability version. Compact document chat and full workspace chat use this same resolver.

| Effect | Model behavior | Application behavior |
| --- | --- | --- |
| `read` | May request bounded evidence. | Authorize each read and return revision-aware citations. |
| `propose` | May prepare an existing-document change. | Store a revision-pinned proposal. A human still applies the diff. |
| `write` | May request a private workspace mutation. | Persist an exact effect and wait for a digest-bound decision. |
| `external` | May request an externally visible action. | Persist and review every material target and policy value before execution. |

## Turn and retry contract

The browser creates one bounded turn context immediately before it sends a user message. The record includes the entry point, document and revision, selected text and its SHA-256 digest, the active PDF page and selected annotation when present, and creation time. The server attaches the selected model and resolved capability versions when the turn starts.

Retries look up the original user-item context. They reuse its document, revision, selection, PDF page, annotation, model, and capability versions, intersected with current authorization. A removed revision fails clearly. Sangam does not silently substitute the document, selection, or default model that happens to be current later.

The context record intentionally excludes provider credentials. Run evidence stores actor, thread, model, status, token counts when available, tool outcomes, latency, citations, safe error classes, and a provider correlation ID. Ordinary prompt, document, selection, and tool-result content is not copied into run evidence.

## Durable effect contract

Document creation, workspace organization, and publication follow this sequence:

1. Validate model arguments with the capability input schema.
2. Normalize the arguments and calculate a stable digest.
3. Persist the effect with the requester, run, tool call, capability version, preview, expiry, and stable operation key.
4. Ask the browser to review the stored effect ID and digest.
5. Accept a decision only from the requesting principal and only for the stored digest.
6. Recheck expiry, current authorization, and current resource state.
7. Execute through `WorkspaceAccessService` with the reserved operation key.
8. Store the resulting resource ID or a safe failure record.

The browser never performs the domain mutation. The model run stops at the first durable effect and resumes only after the browser returns its stored result. This keeps multi-effect requests sequential, prevents duplicate pending cards, and prevents the assistant from narrating a missing result while approval or YOLO execution is still resolving. Reloading the browser restores pending, completed, and failed effect state from SQLite. Repeating a completed approval returns the original result. If the domain mutation commits before the effect completion write, a retry uses the same operation key and converges on the same resource.

An effect left in `approved` or `executing` state after an interruption is also restored. The UI offers a resume action bound to the stored approval and operation key. Before retrying publication, the server checks whether that operation key already committed: a committed publication is recovered even if the document later changed, while an uncommitted request still has to match the approved revision.

Publication approval binds the document ID, exact revision, slug, and access policy. If the document revision changes, execution fails and requires a new effect. Unlisted publication tokens are returned once to the approving browser and are not stored in the chat effect result.

### Workspace organization

`inspect_workspace_organization` returns at most 100 authorized documents, folders, or tags per page. It includes stable IDs, current revision or metadata versions, exact paths, tags, categories, and folder descendant counts. It never returns document content.

`apply_workspace_organization_plan` accepts at most 100 exact operations. Plans can create folders, save unmaterialized drafts at workspace paths, move documents or folders, replace document or folder metadata, move documents to Trash, restore a document to an earlier revision or out of Trash, and duplicate a document. Deterministic code normalizes paths and tag sets, rejects duplicate state changes and no-ops, and calculates the approval digest. Before the first write, the service rechecks every source path, destination, revision, metadata version, descendant count, tag ID, collision, and actor capability. Each committed item has a stable child operation key, so interrupted retries converge on the recorded result.

The explorer, command palette, raw API, and chat all call this service through `WorkspaceAccessService`. A partial result is explicit and never displayed as complete.

### Parity with the app

Chat can do what the app can, through the same services and with the same authority.

| In the app | In chat |
| --- | --- |
| Search with tag, category, and type filters | `search_workspace` takes the same filters and cites the PDF page of a hit |
| Open a document with its tags, category, trust level, and links | `read_document` returns the same |
| Revision history and diff | `read_revision_history` lists revisions or diffs two of them |
| Edit, create, publish | `propose_update`, `create_document`, `publish_document` |
| Move, trash, restore, duplicate, tag, folders | `apply_workspace_organization_plan`; every operation calls `WorkspaceAccessService.write_document` or the folder services |
| Projects: list and open | `inspect_projects` |
| Projects: create, add or remove a document | `update_project`, one exact change per review |

Project tools are administrator-only in the app, so a capability with `requires_administrator` is offered only to an administrator. The run's instructions are the shared rules plus the `guidance` of exactly the capabilities the run has, so the assistant is never told about a tool it lacks.

Not available in chat by design: trust changes, agent tokens, provider connections, backups, reconciliation, Karakeep, and importing PDF bytes. These are administrator operations that hold credentials, operate on infrastructure, or need a binary upload. PDF annotations, unpublishing, and creating tags are not yet available in chat.

### Review and YOLO autonomy

The default permission mode is **Review every effect**. It pauses every durable effect for an exact decision. Operators can select **YOLO · run without approval** in AI settings. YOLO executes every effect immediately, including publication. The normal capability and path checks still run, so YOLO removes approval prompts without granting new authority.

The chat panel shows the active mode. Pending organization plans use a dedicated renderer that lists every operation and its before-and-after state. Completed effects collapse into one expandable summary. **Stop** persists run cancellation, cancels effects that have not started, and aborts the active browser stream. Starting another thread cancels the current run and clears its pending card.

The **Review changes** inbox lists pending and stale document proposals as an editorial review workspace. A proposal includes the proposed wording, an editable wording mode with a live diff, editorial rationale, and any explicit judgment needed. It presents supporting cited passages with direct source links, alongside bounded source documents retrieved during the turn. Reviewers can apply the proposal as drafted or with manual wording adjustments, request a revision, or dismiss it. Older proposals without recorded evidence indicate that no evidence was recorded. A deleted or unauthorized source document is redacted to prevent leaking passages or titles to reviewers who lack permission.

### Exact editorial review

The original agent wording stays in `content`. Sangam stores the exact reviewed wording
separately in `applied_content`, with its immutable `applied_revision_id`. Apply reserves
the wording's SHA-256 digest, the reviewing actor, and the first document operation key.
Only one apply for a proposal can execute at a time. An identical retry by the same actor
uses the reserved operation key, including after a lost response or interrupted completion.
A different payload or actor cannot replace an interrupted reservation.

Validation and current authorization checks run inside the reservation lifecycle.
An uncommitted validation, permission, deletion, or revision failure releases the
reservation. A revision conflict marks the proposal stale and leaves Dismiss available.
A committed operation keeps its reservation for recovery, even if the actor's token is
later revoked. A newly issued token for that actor can resume the exact operation when
the actor has access again. Recovery reads the committed revision from the operation
record, rather than using a newer human edit as the applied revision.

Supporting citations are limited to 20. Each citation must quote a passage from an
authorized document revision. Missing revision IDs resolve to the authorized current
revision at proposal creation. Sangam checks document, revision, PDF page, and annotation
relationships and calculates the passage location. `quote_start` and `quote_end` use
UTF-16 offsets so browser selection and Unicode passages agree.
Repeated passages require an explicit `quote_start` or a longer unique quote.
Model interpretations and external claims belong in `model_opinion`. Recorded turn context is displayed
separately and does not count as cited support.

Retrieved sources come from the proposal's run record, including reads after the
proposal was created. Each run stores at most 50 distinct document, revision, and page
references. The review shows when additional references were omitted. Identical wording
in different runs keeps separate proposal identities and evidence. Review responses
recheck current access before returning source titles and passages.

**Prepare revision request in chat** opens the proposal's thread and fills ChatPanel's
composer with feedback, the exact reviewed wording, and the proposal, document, thread,
and reviewed revision IDs. The reviewer chooses **Send** to deliver it. The original
proposal remains available. A stale proposal can request a revision against the current
document while its old reviewed revision remains explicit in the feedback.

## Add a capability

Complete these steps in order:

1. State one user intent. Split mixed read-and-write behavior into separate capabilities.
2. Choose an existing application-service operation. Add missing domain behavior to the service layer before adding chat code.
3. Classify the effect. Use `propose` for existing-document edits, `write` for private mutations, and `external` for externally visible changes.
4. Define strict, bounded input and result models. Reject extra fields. Set string, collection, result-byte, and time limits.
5. Declare actor capabilities, path-scope behavior, entry points, supported content types, and model requirements.
6. Choose the approval policy and how the review card renders it. Every material effect argument must be visible.
7. Register the descriptor in `CAPABILITIES`, add its tool to `ChatToolset`, and, for a durable effect, add its `DurableEffect` entry that calls an existing application service.
8. Add schema, authority, lifecycle, duplicate-delivery, stale-context, and abuse tests.
9. Add entry-point copy or starter prompts only after the capability works through both compact and full chat.

Do not use prompt wording as a security boundary. Do not add generic HTTP, URL, filesystem, shell, SQL, or credential tools. Do not write the database or workspace from a tool handler. Do not return unbounded content. Do not hide material arguments from approval. Do not create a retry path with a fresh operation key.

## Verification

Capability changes must run the backend and frontend gates plus the browser-verification matrix. Tests must prove policy and lifecycle outcomes, not model prose. Maintain adversarial cases in `tests/fixtures/chat_adversarial_cases.json` without live secrets or customer data.

Required browser coverage includes compact and full chat, exact approval parameters, deny and reload behavior, completed results, keyboard interaction, fine-pointer narrow desktop, and true touch mobile. Report Mobile Safari or physical-device coverage as unverified unless it was actually run.

## Design references

These sources informed the vocabulary and controls. Sangam does not implement their wire protocols merely because it uses compatible ideas.

- The [OpenAI Agents SDK human-in-the-loop guide](https://openai.github.io/openai-agents-python/human_in_the_loop/) documents per-call approval, serializable paused state, and resume behavior. Sangam persists a smaller domain-specific effect record because `WorkspaceAccessService` owns execution.
- The [OpenAI Agents SDK usage guide](https://openai.github.io/openai-agents-python/usage/) defines provider-reported request and token accounting. Sangam records the available aggregate counts without prompt content.
- The [OWASP AI Agent Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html) recommends least-privilege tools, exact action previews, parameter-bound approval, replay protection, independent policy checks, structured audit metadata, and version-controlled adversarial cases.
- [OWASP LLM06: Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/) separates excessive functionality, permission, and autonomy. Sangam limits all three in the registry and effect service.
- The [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/) uses explicit capability discovery and handles for state that must cross calls. Sangam keeps its internal registry and SQLite IDs; it does not expose its application services through MCP.
- [AG-UI](https://github.com/ag-ui-protocol/ag-ui) describes typed frontend tools, interrupts, and an observable agent/UI boundary. Sangam keeps ChatKit and a narrow `review_chat_effect` client tool.
- The [OpenTelemetry GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) warn that tool arguments and results may contain sensitive data and define conversation, operation, model, correlation, and token vocabulary. Sangam stores metadata by default and requires no external telemetry service.
