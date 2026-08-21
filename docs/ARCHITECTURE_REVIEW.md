# Sangam architecture review

Reviewed on 2026-08-20 at `release/v0.3.0` commit `7b537d3`.

This review focuses on model configuration, provider connections, chat, tools,
agent runtimes, UI state, and Python type boundaries. It is a static review of
the repository and its tests. It does not claim that a production provider,
Cloudflare path, or ChatKit domain registration was exercised.

## The short version

Sangam does not need a rewrite, LangGraph, or a wholesale switch to
CopilotKit. Its strongest architectural decision is still correct: the
document server owns authorization, revisions, attribution, and writes. Chat
and agents remain clients of that boundary.

The main flaw is narrower and more concrete. OpenRouter is modeled as the
runtime instead of as one provider connection. That assumption appears in
environment variables, SQLite, API schemas, catalog discovery, runtime
construction, status messages, and UI labels. A custom model slug still runs
through the same OpenRouter client. It is not custom-provider support.

The first move should be to introduce stable provider connections and
provider-neutral model references while keeping ChatKit and the OpenAI Agents
SDK in place. OpenRouter then becomes the first preset for a generic
OpenAI-compatible adapter. This change unlocks direct OpenAI, local servers,
and other compatible gateways without disturbing the document services or
the reviewed-edit path.

Three calls follow from that view:

- Keep ChatKit and the OpenAI Agents SDK for the current bounded chat loop.
- Use both Pydantic and dataclasses, but give each one a clear job.
- Add LangGraph or CopilotKit only when a named product requirement earns the
  migration cost.

## Current architecture

The current chat path is:

```text
React inspector
  -> ChatKit React and hosted frame
  -> /api/v1/chatkit
  -> SangamChatServer
  -> OpenAI Agents SDK Runner
  -> OpenAIProvider(use_responses=True)
  -> OpenRouter base URL

Runner
  -> ChatToolset
  -> WorkspaceAccessService
  -> canonical document, PDF, publication, and proposal services
```

The provider and model settings path is:

```text
SANGAM_OPENROUTER_* and SANGAM_CHAT_*
  -> Settings
  -> ChatServerConfig
  -> ChatModelSettingsRepository
  -> singleton chat_model_settings row
  -> ChatModelCatalog
  -> /api/v1/chat/models
  -> ChatModelSettings and the ChatKit model picker
```

This code already uses maintained chat and agent libraries. The repository is
not hand-rolling SSE parsing, conversation protocol, or the core function-tool
loop. [`docs/PHASE_7.md`](./PHASE_7.md) describes that division accurately.

## What is strong and should stay

### The document boundary is the right center

`WorkspaceAccessService` keeps authorization and activity recording in front
of document operations. Chat tools use that service instead of writing to the
database or filesystem directly. Existing-document edits are stored as
revision-pinned proposals and applied through the normal human-attributed
update path.

That boundary matters more than the choice of agent framework. Any future
runtime must call the same application services and must not gain a second
write path.

Evidence:

- [`src/sangam/access.py`](../src/sangam/access.py)
- [`src/sangam/chat_tools.py#L79-L207`](../src/sangam/chat_tools.py#L79-L207)
- [`src/sangam/chat_proposals.py`](../src/sangam/chat_proposals.py)
- [`tests/test_phase_seven_chat.py#L125-L204`](../tests/test_phase_seven_chat.py#L125-L204)

### The process has an explicit composition root

`build_application_services()` assembles the application without a dependency
injection framework. That is the right level of machinery for Sangam. Keep
plain constructor injection.

The one exception is chat. `SangamChatServer` currently constructs its own
store, proposal repository, proposal service, toolset, and provider. Move that
construction to the existing composition root when the provider work begins.
Do not add a container.

Evidence:

- [`src/sangam/application.py#L32-L53`](../src/sangam/application.py#L32-L53)
- [`src/sangam/application.py#L175-L208`](../src/sangam/application.py#L175-L208)
- [`src/sangam/chat.py#L75-L116`](../src/sangam/chat.py#L75-L116)

### The safety model is better than the settings model

The tool layer bounds results, routes reads through authorization, preserves
citations, and requires a reviewed diff for existing-document changes.
Publishing has a browser confirmation step. These are good product-level
constraints, not framework tricks.

One gap remains. `create_document` writes immediately and relies on prompt text
to mean "only when explicitly requested." Tool effects need a structural
policy so that safety does not depend on the model following an instruction.

## Priority findings

There is no release-blocking P0 in this static review. The P1 items are the
architectural work worth doing before expanding the agent feature set.

### P1. OpenRouter is hard-coded through the stack

The nominal `base_url` seam is not a provider abstraction. OpenRouter appears
in all of these contracts:

- `openrouter_*` startup fields in
  [`src/sangam/config.py#L50-L65`](../src/sangam/config.py#L50-L65)
- `openrouter_enabled` in
  [`src/sangam/migrations/013_chat_model_settings.sql`](../src/sangam/migrations/013_chat_model_settings.sql)
- fixed response literals and OpenRouter fields in
  [`src/sangam/schemas.py#L469-L499`](../src/sangam/schemas.py#L469-L499)
- OpenRouter-only catalog refresh in
  [`src/sangam/chat_models.py#L191-L293`](../src/sangam/chat_models.py#L191-L293)
- `OpenAIProvider(use_responses=True)` and OpenRouter headers in
  [`src/sangam/chat.py#L103-L127`](../src/sangam/chat.py#L103-L127)
- OpenRouter-specific settings and composer copy in
  [`frontend/src/components/ChatModelSettings.tsx#L145-L209`](../frontend/src/components/ChatModelSettings.tsx#L145-L209)
  and
  [`frontend/src/components/ChatPanel.tsx#L117-L150`](../frontend/src/components/ChatPanel.tsx#L117-L150)

`use_responses=True` also excludes many otherwise OpenAI-compatible servers
that implement Chat Completions but not the Responses API.

The fix is a small connection model, not a new agent framework:

```text
ProviderConnection
  id
  name
  protocol: openai_responses | openai_chat_completions
  base_url
  credential_ref
  enabled
  discovery_mode: models_endpoint | manual
  compatibility

ModelRef
  connection_id
  upstream_model_id
```

Use `(connection_id, upstream_model_id)` as model identity. Two servers can
expose the same model ID. Do not use an array index or a publisher prefix as
the connection identity.

### P1. Configuration has no single source of truth

The environment seeds the singleton database row only when the row is absent.
Later changes to `SANGAM_CHAT_DEFAULT_MODEL` or
`SANGAM_CHAT_AVAILABLE_MODELS` are still validated at startup but do not
replace the stored values. The operator can reasonably believe a restart
applied a configuration that the runtime ignores.

Evidence:

- one-time seed in
  [`src/sangam/chat_models.py#L50-L86`](../src/sangam/chat_models.py#L50-L86)
- startup validation in
  [`src/sangam/config.py#L91-L102`](../src/sangam/config.py#L91-L102)
- persisted update in
  [`src/sangam/chat_models.py#L88-L165`](../src/sangam/chat_models.py#L88-L165)

Define ownership by setting type:

| Setting | Authority | Reason |
| --- | --- | --- |
| Filesystem paths, auth mode, safety limits | process settings | Needed before the application is ready |
| Provider credentials | environment or secret manager | Keep secrets out of API responses and routine database exports |
| Provider metadata and enabled state | SQLite | Operator-owned workspace configuration |
| Enabled models and workspace default | SQLite | Shared workspace policy |
| Model selected for a turn or thread | chat client and durable thread state | User intent |
| Theme and panel layout | browser storage | Device preference |

If operators need browser-editable secrets later, decide the threat model
first. Encryption without separate key management does not protect a stolen
database and key on the same host. Start with credential references and honest
configured or missing status.

### P1. Model capability handling fails open

The UI can add any slug. Catalog discovery rejects a model only when the
provider returns `supported_parameters` and explicitly omits `tools`. Missing
metadata is accepted. Every run still sends tools, Responses-specific input,
and optional reasoning settings.

Evidence:

- custom IDs in
  [`src/sangam/chat_models.py#L88-L116`](../src/sangam/chat_models.py#L88-L116)
- discovery filter in
  [`src/sangam/chat_models.py#L252-L293`](../src/sangam/chat_models.py#L252-L293)
- unconditional runtime shape in
  [`src/sangam/chat.py#L176-L200`](../src/sangam/chat.py#L176-L200)
- custom slug UI in
  [`frontend/src/components/ChatModelSettings.tsx#L197-L249`](../frontend/src/components/ChatModelSettings.tsx#L197-L249)

Use explicit capability status:

```text
tools: supported | unsupported | unknown
responses_api: supported | unsupported | unknown
reasoning: supported | unsupported | unknown
structured_output: supported | unsupported | unknown
vision: supported | unsupported | unknown
```

An operator may override `unknown`, but the UI must label that choice. Do not
present an unverified model as compatible.

### P1. Provider endpoints can receive credentials without production checks

Production validation checks the OpenRouter referer but not the provider base
URL. The runtime then sends the bearer credential to that URL. The frozen
`ChatServerConfig` also stores the unwrapped secret in a normal dataclass field,
whose generated representation can reveal it if the object is logged.

Evidence:

- production checks in
  [`src/sangam/config.py#L104-L160`](../src/sangam/config.py#L104-L160)
- secret unwrapping in
  [`src/sangam/config.py#L162-L178`](../src/sangam/config.py#L162-L178)
- credential use in
  [`src/sangam/chat.py#L103-L116`](../src/sangam/chat.py#L103-L116)

Require HTTPS in production. Permit plain HTTP only for explicit loopback or
private-network development according to a documented policy. Reject embedded
credentials, queries, and fragments. Keep the secret wrapped until client
construction or exclude it from representations.

### P1. Tool effect policy is implicit

Publishing uses an explicit client confirmation. Existing-document updates use
a proposal. `create_document` writes immediately and depends on its description
and the system prompt to restrict use.

Evidence:

- tool registration in
  [`src/sangam/chat_tools.py#L33-L71`](../src/sangam/chat_tools.py#L33-L71)
- direct create in
  [`src/sangam/chat_tools.py#L176-L189`](../src/sangam/chat_tools.py#L176-L189)
- publication confirmation in
  [`src/sangam/chat_tools.py#L191-L207`](../src/sangam/chat_tools.py#L191-L207)

Define one effect vocabulary and enforce it outside prompt text:

```text
read       run without approval inside the actor's scope
propose    create reviewable state, but do not apply it
write      require a declared policy and show the result
external   require confirmation before the side effect
```

A tool definition should carry its schema, effect, authorization requirement,
approval policy, handler, and safe renderer metadata. Internal tools, future
MCP tools, and future OpenAPI-described tools should all pass through the same
policy.

### P1. Inference access has no separate capability or budget

The ChatKit endpoint accepts any authenticated principal. An external agent
token with a read-only workspace scope can therefore use the server's provider
credential and spend its model budget. Workspace authorization still protects
documents, but it does not protect inference quota.

Evidence:

- principal requirement in
  [`src/sangam/api_chat.py#L59-L68`](../src/sangam/api_chat.py#L59-L68)
- current capability vocabulary in
  [`src/sangam/capabilities.py`](../src/sangam/capabilities.py)

Make the policy explicit. The trusted human can use chat. External tokens need
an `inference` capability. Before granting it, add per-actor concurrency,
request, and spend limits. Record model, connection, latency, usage, outcome,
and a provider correlation ID without logging prompts or document content.

## P2 findings

### Runtime status is not honest enough for the UI

`configured` currently means that a provider object exists and the global
OpenRouter toggle is on. It does not mean the endpoint is reachable or the
credential works. When an operator deliberately turns chat off, the UI says to
set an API key.

Evidence:

- [`src/sangam/chat.py#L118-L146`](../src/sangam/chat.py#L118-L146)
- [`frontend/src/components/ChatPanel.tsx#L243-L250`](../frontend/src/components/ChatPanel.tsx#L243-L250)

Return separate state such as `enabled`, `credential_status`,
`connection_status`, and `last_checked_at`. Keep the external probe behind a
user-triggered **Test connection** action so provider downtime does not block
startup.

This is more than copy. The frontend mounts ChatKit and loads proposals only
when `configured` is true. Turning inference off or removing a key therefore
hides durable history and pending proposals, even though review, apply,
dismiss, rename, and delete do not need a model call. Keep history and proposal
review available. Disable only the composer and new inference runs.

### Retry does not preserve the original turn context

Sangam keeps one workspace thread while the current document and editor
selection come from a live React ref. Retrying an older user message after
switching documents can run it against the new document, revision, and
selection. The visible context-switch notice is not a durable thread item.

Evidence:

- workspace thread choice in
  [`frontend/src/components/ChatPanel.tsx#L20-L23`](../frontend/src/components/ChatPanel.tsx#L20-L23)
- live document header in
  [`frontend/src/components/ChatPanel.tsx#L90-L116`](../frontend/src/components/ChatPanel.tsx#L90-L116)
- live selection tool in
  [`frontend/src/components/ChatPanel.tsx#L153-L163`](../frontend/src/components/ChatPanel.tsx#L153-L163)

Persist a turn-context snapshot with the user message: document ID, revision
ID, selection snapshot or hash, connection ID, and model ID. Retry should use
that snapshot unless the user chooses **Retry with current context**.

### Global model settings can overwrite another session

The model settings row has `updated_at`, but the API does not return or check a
version. Two open settings pages can silently replace each other's changes.
Add a numeric version and require `expected_version` for updates. Record the
accepted or rejected admin change without recording a secret.

### API errors are not represented accurately in OpenAPI

Sangam already publishes FastAPI documentation at `/api/v1/openapi.json` and
`/api/v1/docs`. Success models are declared, but the common error response is
not. `ErrorBody` also does not match the actual `{"error": ...}` envelope, and
FastAPI request-validation errors keep a different 422 shape.

Evidence:

- API documentation routes in
  [`src/sangam/api.py#L136-L141`](../src/sangam/api.py#L136-L141)
- error model in
  [`src/sangam/schemas.py#L261-L265`](../src/sangam/schemas.py#L261-L265)
- actual error translation in
  [`src/sangam/api.py#L255-L281`](../src/sangam/api.py#L255-L281)

Define one `ErrorResponse` envelope, use it for request validation and domain
errors, and declare common error responses. This work improves generated
clients and future OpenAPI-described tool use.

Terminology matters here. A configurable model server is an
**OpenAI-compatible inference endpoint**. An **OpenAPI document** describes an
HTTP API and can later be used to generate tools. They are separate features.

### The model settings and proposal UI hide loading failures

The settings screen renders zero models while its first query is loading or
has failed. The proposal panel passes `data ?? []`, so a loading or failed query
becomes "No pending edits to review." ChatKit script loading also has no error,
timeout, or retry state.

Evidence:

- [`frontend/src/components/ChatModelSettings.tsx#L22-L42`](../frontend/src/components/ChatModelSettings.tsx#L22-L42)
- [`frontend/src/components/ChatModelSettings.tsx#L140-L180`](../frontend/src/components/ChatModelSettings.tsx#L140-L180)
- [`frontend/src/components/ChatPanel.tsx#L51-L64`](../frontend/src/components/ChatPanel.tsx#L51-L64)
- [`frontend/src/components/ChatPanel.tsx#L243-L277`](../frontend/src/components/ChatPanel.tsx#L243-L277)
- [`frontend/src/components/ChatPanel.tsx#L456-L472`](../frontend/src/components/ChatPanel.tsx#L456-L472)

Empty, loading, unavailable, disabled, and failed are different product states.
Render them differently and offer the next valid action.

### Tool traces lose useful evidence

ChatKit exposes tool work, but Sangam replaces the detail with `Complete` or a
short failure string. Preserve a bounded, sanitized record with the tool name,
safe input summary, outcome, elapsed time, effect class, and citations or
created resource. Keep raw data behind deliberate disclosure.

Evidence:

- [`src/sangam/chat_tools.py#L209-L242`](../src/sangam/chat_tools.py#L209-L242)

### Request and context limits do not control cost

The endpoint reads the whole ChatKit body before processing it. Model context
uses the last N items, not a byte or token budget. One item can still be large.
The run does not persist provider usage, latency, or request identity.

Evidence:

- request body in
  [`src/sangam/api_chat.py#L59-L68`](../src/sangam/api_chat.py#L59-L68)
- message-count context in
  [`src/sangam/chat.py#L153-L163`](../src/sangam/chat.py#L153-L163)
- run configuration in
  [`src/sangam/chat.py#L184-L200`](../src/sangam/chat.py#L184-L200)

Add a request-byte limit and build context to a token budget. Store bounded
usage metadata per run. Keep content out of ordinary logs.

### Proposal review can show the wrong base diff

The apply path correctly rejects a stale proposal, but the UI compares proposed
content with the currently loaded document content. After a concurrent edit,
that is not the diff the model proposed against. Load the pinned base revision
for the review, then show the current head as a separate conflict state.

Evidence:

- [`frontend/src/components/ChatPanel.tsx#L489-L542`](../frontend/src/components/ChatPanel.tsx#L489-L542)

### Frontend integration has grown into one large component

`ChatPanel.tsx` handles ChatKit setup, remote script loading, thread storage,
document context, selection tools, citations, publication approval, proposal
review, and related mutations. The behavior belongs together in the feature,
but not in one component.

Split by responsibility without introducing a new state framework:

- `useWorkspaceChat()` for ChatKit options and live request context
- `ChatRuntimeState` for loading, disabled, missing, and failed states
- `ChatEffectApproval` for side-effect requests
- `ChatProposalQueue` for proposal query and review state
- citation and selection components, which already have clear boundaries

The same navigation problem exists in `frontend/src/api.ts`, `src/sangam/api.py`,
`src/sangam/service.py`, `src/sangam/access.py`, `src/sangam/publication.py`, and
`src/sangam/pdf_research.py`. Split only at real feature or transaction
boundaries. In particular, do not split the document revision writer just to
make its file shorter.

### The frontend duplicates the OpenAPI contract by hand

FastAPI already publishes an OpenAPI document, while the frontend maintains a
940-line handwritten client and parallel Zod schemas. Generate TypeScript
types and request functions from a committed OpenAPI snapshot, or add a
deterministic drift check. Keep Zod at runtime boundaries where malformed data
must still be rejected.

Evidence:

- [`src/sangam/api.py#L136-L141`](../src/sangam/api.py#L136-L141)
- [`frontend/src/api.ts`](../frontend/src/api.ts)
- [`frontend/package.json`](../frontend/package.json)

### ChatKit payloads need a local persistence version

The database stores serialized ChatKit objects and validates them directly as
SDK models. An SDK upgrade can therefore become a data migration even when the
SQL schema does not change. Add a Sangam-owned payload version and fixtures
that load representative records from every supported version.

Evidence:

- [`src/sangam/migrations/011_workspace_chat.sql`](../src/sangam/migrations/011_workspace_chat.sql)
- [`src/sangam/chat_store.py`](../src/sangam/chat_store.py)

### Application construction also performs initialization

`build_application_services()` creates directories, migrates SQLite, seeds
actors, rebuilds search, and runs recovery work while it wires dependencies.
FastAPI then starts more lifecycle work. Separate object construction from one
explicit initialization phase with readiness state. This keeps dependency
tests and future command-line tools from triggering boot work by construction.

Evidence:

- [`src/sangam/application.py#L52-L166`](../src/sangam/application.py#L52-L166)
- [`src/sangam/api.py#L92-L135`](../src/sangam/api.py#L92-L135)

### Settings tabs miss their own interaction contract

The settings category buttons use tab roles but do not implement roving focus,
arrow keys, Home or End, `aria-controls`, or a tab panel. Sangam already has a
tab keyboard helper in
[`frontend/src/components/tabKeyboard.ts`](../frontend/src/components/tabKeyboard.ts).
Reuse it.

The chat tab also uses the 11px metadata token even though
[`docs/UI_SYSTEM.md`](./UI_SYSTEM.md) requires interactive text to use at least
the 13px control token.

## Pydantic and dataclasses

Use both. The current instinct is mostly right.

Use Pydantic for:

- HTTP request and response contracts
- environment and secret parsing
- untrusted provider JSON
- persisted JSON owned by an external library
- generated OpenAPI schemas

Use frozen dataclasses for:

- validated internal configuration
- principals, grants, plans, and normalized values
- provider-neutral commands and results
- values that need immutability but not runtime parsing

The Karakeep adapter already demonstrates the split. Private Pydantic models
validate upstream JSON, then frozen dataclasses carry trusted internal values.
Reconciliation uses small frozen dataclasses for pure planning.

Evidence:

- [`src/sangam/karakeep_gateway.py#L16-L107`](../src/sangam/karakeep_gateway.py#L16-L107)
- [`src/sangam/reconciliation.py#L17-L46`](../src/sangam/reconciliation.py#L17-L46)
- [`src/sangam/config.py#L14-L30`](../src/sangam/config.py#L14-L30)

The problem is not that Sangam uses Pydantic. The problem is that
`src/sangam/schemas.py` is also the shared domain and persistence model module.
Many services and repositories return API models directly. Split a type only
when the internal and external contracts differ. Do not create duplicate
models for symmetry.

A practical rule is:

```text
untrusted input
  -> Pydantic parsing
  -> application service
  -> frozen dataclass when the value owns an invariant or lifecycle
  -> repository or provider adapter
  -> Pydantic response projection at the HTTP boundary
```

As modules are touched, separate strict mutation requests from stable read
projections. Use `extra="forbid"` for Sangam-owned mutation requests so a
misspelled field does not disappear silently. Keep tolerant parsing for
third-party payloads where forward compatibility matters.

Do not create a large `domain/application/infrastructure` directory tree. Keep
feature-oriented modules and move only the boundary that the next change
needs.

## Open WebUI, Pi, CopilotKit, and LangGraph

### Copy Open WebUI's layering, not its size

Open WebUI treats OpenRouter as one OpenAI-compatible connection among many.
It separates connections, discovered upstream models, configured workspace
models, and chat selection. Providers without model discovery can use manual
IDs. This is the right reference for Sangam's settings model.

Sources:

- [OpenAI-compatible provider setup](https://docs.openwebui.com/getting-started/quick-start/connect-a-provider/starting-with-openai-compatible/)
- [Workspace model configuration](https://docs.openwebui.com/features/workspace/models/)
- [Tool taxonomy and access](https://docs.openwebui.com/features/extensibility/plugin/tools/)
- [OpenAI connection implementation](https://github.com/open-webui/open-webui/blob/main/backend/open_webui/routers/openai.py)

Do not copy Open WebUI's parallel URL and key arrays or configuration keyed by
array index. Use records with stable connection IDs. Do not add arbitrary
in-process Python tools. Open WebUI correctly warns that such tools have
server-level power.

### Copy Pi's small internal vocabulary

Pi keeps provider conversion at the edge. Its agent loop works with internal
messages and events, while provider adapters translate at the last moment.
Provider registration and tool registration are different concepts.

Sources:

- [Pi custom model and provider configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md)
- [Pi settings](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/settings.md)
- [Pi agent loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- [Pi extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)

This is a better fit for Sangam than a broad framework rewrite. Define a few
plain values, translate at the edge, and keep application policy in Sangam.

### CopilotKit solves a different problem

CopilotKit and AG-UI are strongest when the product needs native agent-to-UI
state, rich tool rendering, browser tools, generative UI, or multiple agent
frontends. They do not solve provider configuration.

Sangam should evaluate CopilotKit only if ChatKit's hosted frame blocks a named
UX requirement. A switch would replace conversation UI, transport, thread
integration, and parts of the current tool rendering. That is a product
migration, not an architecture cleanup.

Useful references:

- [AG-UI architecture](https://docs.copilotkit.ai/ag-ui/concepts/architecture)
- [CopilotKit hook selection](https://docs.copilotkit.ai/concepts/which-hook)
- [CopilotKit runtime architecture](https://github.com/CopilotKit/CopilotKit/blob/main/dev-docs/architecture/setup-runtime.md)

Sangam can borrow the event vocabulary first:

```text
run.started
message.started
text.delta
tool.started
tool.completed
approval.required
proposal.created
run.failed
run.completed
```

Keep this vocabulary internal until there is a second UI or runtime adapter.
Do not build a protocol spec in advance of a consumer.

### LangGraph is for durable workflow state

LangGraph describes itself as a low-level runtime for long-running, stateful
agents. Its value is checkpointing, branching, interruption, and resume. The
current chat loop is one bounded run with tools, retry, history, and human
proposal review. The OpenAI Agents SDK already handles that job.

Add LangGraph only when Sangam has a concrete workflow that must stop, survive
a process restart, wait for input, and resume from a saved step. Keep any such
runtime behind a small `AgentRuntime` constructor seam, and keep document
authorization in Sangam services.

Sources:

- [LangGraph overview](https://docs.langchain.com/oss/python/langgraph/overview)
- [LangGraph persistence](https://docs.langchain.com/oss/python/langgraph/persistence)
- [LangChain agent layer](https://docs.langchain.com/oss/python/langchain/agents)

## Target architecture

The target remains a modular monolith:

```text
                         browser
        +-------------------+-------------------+
        |                                       |
   settings UI                           ChatKit adapter
        |                                       |
        +------------- Sangam HTTP API ---------+
                              |
                    application services
              +---------------+---------------+
              |                               |
       ProviderService                  WorkspaceAccessService
              |                               |
      +-------+--------+             documents, PDFs, publish,
      |                |             proposals, activity
 connection repo   model catalog
      |                |
      +------ adapter factory ------+
                                     |
                OpenAI-compatible adapter
                   |              |
                Responses    Chat Completions
                   |
           OpenRouter is one preset

 AgentRuntime seam: OpenAI Agents SDK now
 Tool policy: Sangam-owned for every runtime
```

Six values are enough for the first pass:

```text
ProviderConnection
ModelDescriptor
AgentRuntime
ToolDefinition
RuntimeEvent
TurnContext
```

Do not add `AssistantProfile` yet. Add it when users need named combinations
of model, prompt, parameters, knowledge, and allowed tools. That is the point
where Open WebUI's workspace-model idea becomes useful.

## Work packages

Each package below has a visible exit condition. Pick one, finish it, and keep
the release branch stable between packages.

### Package 1. Make runtime state truthful

Scope:

- replace the overloaded `configured` boolean
- distinguish disabled, missing credential, ready, unreachable, and
  incompatible
- keep durable history and proposal review available when inference is off
- add loading, error, and retry states for model settings and proposals
- add ChatKit script load failure and retry handling
- correct operations documentation that still describes environment model
  changes as authoritative after the database row exists

Exit demonstration:

1. Turn chat off and see "disabled by workspace settings."
2. Remove the credential and see "credential missing."
3. In both states, open history and review an existing proposal.
4. Fail a catalog request and see a retry action without losing saved models.
5. Fail proposal loading and never see a false empty state.

This is the best first package. It is small, user-visible, and clarifies the
state model needed by provider connections.

### Package 2. Introduce provider connections

Scope:

- add stable `ProviderConnection` records and a migration
- move chat dependency construction into `build_application_services()`
- add an adapter factory that returns the Agents SDK `ModelProvider`
- migrate existing OpenRouter settings into one seeded connection
- keep credential values outside normal API responses and database exports
- validate endpoint safety
- add settings versioning and audit events

Exit demonstration:

1. The existing OpenRouter flow behaves exactly as before.
2. The API and UI call it a connection, not the runtime.
3. A stale settings save returns 409 instead of overwriting another session.
4. Logs, API responses, and object representations contain no credential.

### Package 3. Add generic OpenAI-compatible endpoints

Scope:

- support `openai_responses` and `openai_chat_completions`
- add **Test connection**
- discover models from `/models` when supported
- allow a bounded manual model list when discovery is absent
- namespace models by stable connection ID
- keep OpenRouter as a preset, not a special code path

Exit demonstration:

1. Configure OpenRouter and one local or test-compatible endpoint.
2. Discover or enter models for both connections.
3. Select a model in ChatKit and complete a tool-backed turn through each API
   protocol.
4. Disable one connection without affecting the other.

### Package 4. Make model compatibility explicit

Scope:

- store verified, unsupported, or unknown capability state
- make reasoning, tools, structured output, and input shape conditional
- show connection, publisher, protocol, and compatibility in the picker
- require an explicit operator override for unknown models
- record the selected connection and model on each run
- persist the document, revision, and selection context for each user turn
- make retry use the original turn context unless the user opts into current
  context

Exit demonstration:

1. An unsupported model cannot be enabled for tool-backed chat.
2. An unknown manual model is visibly marked and requires an override.
3. A model without reasoning support runs without reasoning parameters.
4. Retry after a document switch uses the original revision and model.

### Package 5. Add structural tool policy and better traces

Scope:

- add effect and approval metadata to tool definitions
- enforce policy outside prompts
- move `create_document` behind the chosen write policy
- preserve bounded tool input, outcome, duration, effect, and citations
- keep every handler behind `WorkspaceAccessService`
- require a separate inference capability for external agent tokens
- add request, context, concurrency, and usage budgets

Exit demonstration:

1. A read tool runs inside the actor's scope without approval.
2. An edit creates a proposal and cannot apply itself.
3. A write or external effect pauses according to policy.
4. The user can inspect what ran and what changed after the stream ends.
5. A read-only external token cannot spend the server's inference budget.

### Package 6. Clean type and API boundaries as they are touched

Scope:

- define one OpenAPI error envelope
- make Sangam mutation requests reject unknown fields
- move provider wire parsing into private Pydantic models
- return provider-neutral dataclasses from application services
- type SQLite mappers and validate persisted JSON
- add a permissive static type-checking baseline, then tighten changed modules
- generate the frontend API contract or add a deterministic OpenAPI drift check
- version durable ChatKit payloads and add backward-load fixtures

Exit demonstration:

1. Generated OpenAPI shows the common error response.
2. A misspelled mutation field returns a consistent 422.
3. Invalid persisted provider JSON fails with a named configuration error.
4. The changed provider and chat modules pass the type checker.
5. Backend schema drift fails before a handwritten frontend mirror ships.

### Package 7. Decide the chat UI from evidence

Do this only after Packages 1 through 5 establish stable provider, tool, and
event boundaries.

Run a focused spike if Sangam needs one of these capabilities:

- native tool cards that ChatKit cannot render well
- synchronized application and agent state
- custom human-in-the-loop interaction inside the transcript
- a fully self-hosted chat surface without OpenAI-hosted frame assets
- multiple agent backends exposed through one UI protocol

Compare three options against those exact needs:

| Option | Best fit | Main cost | Current call |
| --- | --- | --- | --- |
| Keep ChatKit | bounded chat, history, retry, model picker | hosted UI constraints | keep |
| Adopt CopilotKit or AG-UI | native React agent UI and shared state | UI and transport migration | evaluate later |
| Build a thin native UI | maximum control over a small event contract | Sangam owns more chat behavior | only if scope stays small |

### Package 8. Add LangGraph only for a durable workflow

Do not create this package until a workflow needs it. A qualifying example is a
research job that performs several steps, survives restart, waits for review,
and resumes from the saved checkpoint. Ordinary chat tool calls do not qualify.

## Recommended order

The sequence I would use is:

1. Package 1, truthful state and failure UX.
2. Package 2, provider connections and composition.
3. Package 3, generic OpenAI-compatible endpoints.
4. Package 4, capability-aware model selection.
5. Package 5, tool policy and traces.
6. Package 6, focused type and OpenAPI cleanup.
7. Package 7 only if ChatKit blocks a named UX requirement.
8. Package 8 only when a durable workflow exists.

This order keeps each change vertical. It avoids committing to a UI or agent
framework before Sangam owns a clean provider, tool, and event boundary.

## Decision record

| Question | Decision |
| --- | --- |
| Should OpenRouter remain the only provider? | No. Keep it as the first preset for an OpenAI-compatible connection. |
| Should the UI allow model selection? | Yes. It already does. Back it with stable connection-scoped model IDs and honest capabilities. |
| Should settings allow a custom base URL? | Yes, with endpoint validation, a server-managed credential reference, model discovery, and manual fallback. |
| Should Sangam expose OpenAPI? | It already does. Fix the error contract before treating it as a reliable client or tool contract. |
| Should OpenAPI documents become model providers? | No. They describe tools, not inference providers. |
| Should Sangam use dataclasses instead of Pydantic? | No. Use Pydantic at untrusted and public boundaries, and frozen dataclasses for internal values with invariants. |
| Should Sangam adopt CopilotKit now? | No. Evaluate it only for a named native agent-UI need. |
| Should Sangam adopt LangGraph now? | No. Add it only for durable, branching, resumable workflows. |
| Should Sangam build its own agent loop? | No. Keep the OpenAI Agents SDK behind a small construction seam. |
| Should Sangam copy Open WebUI? | Copy its connection and model layering. Do not copy its scale, index-keyed configuration, or arbitrary server-side tool execution. |

## Review method and limits

Six parallel read-only reviews covered provider settings, backend types,
chat and agents, frontend UX, whole-repository boundaries, and external
reference architectures. Findings were checked against the current release
branch before inclusion.

The external comparison used primary project documentation and source from
Open WebUI, Pi, CopilotKit, and LangGraph. Those projects change quickly. The
links describe the state reviewed on 2026-08-20, not a permanent compatibility
promise.
