---
type: research
status: complete
source: "Sangam repository and linked primary sources"
revision: "a14b27cc1df1a60092d6d48bdb36db8c0a092eb6"
branch: "t3/research-mcp-sota-options"
working_tree: "Initial code inspection was clean; current follow-up changes are untracked research/design documents under docs/tasks/"
research_date: "2026-11-12"
file_review_source: "Files draft 8a859b8f268926fe4beb84d78565e7cc6f9fa617; Apps spec 19256f52cad5517ba8272581ed2e11d6a81273d5"
file_review_coverage: "Files draft, affected Apps permission/authorization sections, and Sangam import/asset guards; no host/runtime conformance test"
---

# Research: Universal MCP for Sangam

For proposed behavior and current design decisions, use the
[MCP technical design](02-tech-design-sangam-mcp.md). This report preserves
research evidence and options; its earlier recommendations are not approvals.

## Scope and sources

This report investigates MCP as available on November 12, 2026. It covers the
released standard, optional extensions, reference implementations, Sangam's
existing boundaries, and implementation options. It does not predict the rest
of November. The user requires a universal design, without a preferred host,
and wants to learn the broader implementation patterns even when Sangam does
not need their full scale. Connection setup and centrally served skills are
part of the desired experience. Recommendations below are design judgments,
not implemented behavior.

Primary sources include the versioned MCP specification, official SDK and
extension documentation, official OpenAI documentation and examples, and the
Excalidraw, Grafana, T3 Code, and Cloudflare repositories. External repository
links generally name mutable `main` branches. They record sources inspected
today, not reproducible source snapshots or runtime certification.

## Findings

### Recommended direction

Study the complete connection and capability lifecycle, including advanced
patterns, before deciding which application workflows to expose. The small
size of Sangam's API is not a reason to exclude Code Mode, durable tasks, or
other patterns from the learning scope. Their product fit and implementation
cost remain separate judgments.

Expose document workflows through the existing Python service.
Use tools for actions, resources for exact document evidence, and optional MCP
Apps for reading and reviewing. Keep SQLite, document revisions, authorization,
and operation records authoritative. A host should be able to complete the
core workflow without rendering HTML or receiving notifications.

The useful initial workflow to align on is: find authorized material, read exact
evidence, and prepare a revision-aware change that a person can review. This
connects Sangam's existing strengths without requiring external agents to run
Sangam's internal chat model.

Universal means shared contracts and useful fallback behavior. It does not mean
that all hosts implement every optional feature. The official
[extension matrix](https://modelcontextprotocol.io/extensions/client-matrix)
requires both sides to declare extension support and is community-maintained.
Its extracted table has insufficient detail to certify individual clients.

### Connected assistants and centralized skills

The proposed normal experience is to connect an assistant through MCP and
authorize that connection in Sangam. Manual token copying remains an optional
script or compatibility path. OAuth still uses tokens internally; the improvement
is that the client obtains and stores credentials through an authorization flow.
The [HTTP authorization contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
defines discovery and authorization roles. It does not define a universal
button that installs server configuration into every assistant.

A candidate connection experience would provide a public MCP URL, optional
client-specific setup helpers, a generic manual URL path, browser authorization,
and an authenticated connection check. The consent screen would show the
application, actual grants, and path boundary. Users would manage each connection
and revoke its grant independently. Client names alone are not verified identities.

Reachability belongs in setup. A local assistant can reach a local server;
a cloud-hosted assistant needs a network path to the instance. OAuth does not
create that path. Sangam should diagnose reachability, authorization, tool
discovery, and optional skill support as separate connection states.
T3's [outside-agent setup](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)
is a useful reference for this entire experience, beyond its token machinery.

The [Skills extension](https://modelcontextprotocol.io/extensions/skills/overview)
has `skills/list` and `skills/get` for discovery and metadata. Instructions and
supporting files are fetched through `resources/read`. A file manifest records
URIs, byte sizes, and digests. The host verifies content and controls activation.
Connecting the server does not itself mean a skill was loaded. Changed manifests
invalidate persisted approval for the old manifest. Central publication therefore
does not imply silent replacement of instructions in an active task.

The proposed Sangam catalog would have one canonical source for each workflow's
instructions. MCP, HTTP skill downloads, and any compatibility packaging would
derive from that source. Native Skills clients could discover entries on demand.
Other clients could read the same instructions through ordinary resources or a
small bounded guide tool. That fallback returns model context; it cannot claim
native skill installation or activation. A packaged skill can supply a short
bootstrap where a host requires one, without duplicating workflow instructions.

Keep reusable instructions separate from connection secrets, live document
evidence, and authority. Candidate skill content covers evidence research,
reviewed editing, organization, and publishing. Their final grouping is open.
Reading a publishing skill cannot grant publication access. A skill that describes
an absent optional tool must state the prerequisite or an available alternative.

Prefer a stable manifest per published skill release and record the identity
used during an external invocation. An active workflow should retain its loaded
instructions while later workflows can discover a newer release. The exact
version and retention model is a design question. Project documents should not
automatically become executable skills.

The current [Python SDK Skills guide](https://py.sdk.modelcontextprotocol.io/advanced/skills/)
documents an extension adapter, with the server supplying its own catalog and
resource handlers. It does not scan or hash a skill directory automatically.
Source inspection of Sangam's installed 2.3.0 package found no `server/skills.py`
or `skills/list` and `skills/get` implementation. The published guide is not
proof that this locked release has those helpers. A version comparison is needed
before choosing an upgrade or implementing the extension adapter locally.

Sangam's existing [agent documentation generator](../../../src/sangam/agent_docs.py)
already serves instance-aware instructions, but its connection section assumes
REST credentials and curl. Centralizing that text unchanged would teach the
wrong setup for an OAuth MCP connection. Share workflow rules and provide
transport-appropriate connection guidance from the same canonical sources.

### Released protocol baseline

The released baseline found is `2026-07-28`. Its core is stateless, with explicit
discovery and per-request protocol metadata. Older handshake-based clients
require compatibility handling. See the
[release announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/).

The changes that affect this design are specific. Connection-scoped application
state must become explicit handles. List and resource responses have caching
metadata. Subscription delivery differs from the 2025 protocol. Human input
can require another request round trip. Read the versioned specification when
implementing, rather than copying transport plumbing from older examples.
See the [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog).

### Capability coverage and Sangam fit

| Function | Standard mechanism and status | Recommended Sangam treatment |
| --- | --- | --- |
| Discovery | Core `server/discover`; version and capabilities accompany requests. | Let the SDK handle protocol details. Describe the service independently of a host. |
| Actions | Core `tools/list`, `tools/call`, input schemas, optional output schemas. | Expose bounded domain operations. Keep actor identity out of model-supplied arguments. |
| Results | Core text, structured results, images, audio, resource links, embedded resources. | Return useful text plus stable IDs, revision IDs, pagination, and bounded evidence. |
| Tool hints | Read-only, destructive, idempotency, and open-world annotations. | Declare actual behavior. Hints never grant permission or enforce review. |
| Evidence | Core resource reads, listings, and URI templates. | Provide exact revisions and PDF pages. Keep ordinary read tools for hosts that do not use resources well. |
| Prompt templates | Core prompts and argument completion. | Optional user-invoked workflows, such as reviewing a document. Do not encode policy here. |
| Reusable instructions | Current official Skills documentation marks SEP-2640 Final; SDK and host coverage remain incomplete. | Reuse Sangam's portable skill and optionally expose it through the extension. Keep its existing HTTP distribution. |
| Interactive views | MCP Apps is Stable. | Optional document reader, evidence viewer, and proposal review UI. |
| UI actions | Apps bridge supports tool calls and resource reads. | Use the same service operations and request authority as model calls. |
| File transfers | The Files extension announced November 10 is experimental, with no reference implementation in the announcement. | Keep bytes outside model code/context; negotiate optional support and retain ordinary Sangam upload as a fallback. |
| UI context | Apps supports context updates, messages, themes, and display modes. | Send bounded selection and revision context. Re-read server state before mutations. |
| Change notifications | Core `subscriptions/listen` with opted-in notifications. | Notify that mutable resources changed, then fetch current authorized state. |
| In-flight progress | Core request-scoped progress notifications. | Use for bounded work. Do not treat progress as persisted completion evidence. |
| Durable background work | Tasks is Beta, intended for Core. | Consider for PDF extraction or capture jobs only when SDK and client support is proven. |
| Resumable task events | SEP-2694 is a draft proposal. | Do not make reliable recovery depend on it. |
| Human input | Core form and URL elicitation using multi-round-trip requests. | Use for missing inputs when supported; preserve a normal tool-based path. |
| Authentication | HTTP authorization uses OAuth discovery and protected-resource metadata. | Map credentials into Sangam principals and check grants for every operation. |
| Machine authorization | OAuth client credentials and enterprise authorization extensions are Stable. | Optional integration choices, not required machinery for every self-hosted instance. |
| Server metadata | Server Cards is Beta. | Optional discovery convenience alongside existing discovery files. |
| Cancellation | Transport cancellation and optional task cancellation. | Stop pending work where possible. A disconnected caller does not prove a write was rolled back. |
| Observability | Trace context conventions; protocol logging is deprecated. | Preserve Sangam activity records and redact operational logs. |
| Roots and sampling | Deprecated in the July release. | Do not use roots as path authority or sampling as an inference dependency. |
| Distribution | Plugins, marketplaces, and bundles are host ecosystems. | Publish standard MCP access and a portable skill; add host packages as installation conveniences. |

The [tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
defines results and schemas. Tool lists may vary by request authorization but
must not depend on hidden connection state. Private data must not enter shared
caches. The [resources specification](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
defines URI-based evidence and optional resource update notifications.

[Prompts](https://modelcontextprotocol.io/specification/2026-07-28/server/prompts.md)
provide discoverable message templates. The separate
[Skills extension](https://modelcontextprotocol.io/extensions/skills/overview)
provides workflow instruction discovery, supporting files, and manifests.
These mechanisms serve different purposes. Neither changes application authority.

Extension maturity comes from the official
[extension overview](https://modelcontextprotocol.io/extensions/overview).
Deprecated roots, sampling, logging, and Dynamic Client Registration are listed
in the [deprecation registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated).
DCR remains a compatibility concern; new authorization design should account
for Client ID Metadata Documents rather than depend exclusively on DCR.

### Events, tasks, and recovery

There are four distinct needs here.

1. A tool can report progress while its request is active.
2. A client can subscribe to supported changes through `subscriptions/listen`.
3. A durable operation can expose its status through a task handle or ordinary
   application status tool.
4. Reliable event replay needs retained events and a recovery cursor.

The released [subscription definition](https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2026-07-28/basic/patterns/subscriptions.mdx)
supports opted-in resource and list changes. These are not general webhooks or
a durable application event bus. Losing a subscription should cause the client
to fetch current state and re-establish its subscription.

The [Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
uses durable handles, `tasks/get`, `tasks/update`, and cooperative cancellation.
The current design does not use the older blocking `tasks/result` workflow.
Both sides must opt in. A server must create the task durably before returning
its handle. Task expiration and cancellation need defined application behavior.

[SEP-2694](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2694)
proposes resumable sequenced task events. Its inspected PR is Draft and states
that no public reference implementation is available. Proposed task streaming,
partial results, and steering should not be described as universally shipped.

For Sangam, use notifications as invalidation hints. Revision reads and durable
operation status establish what happened. An activity ledger is useful evidence,
but its existence does not prove that it already supports a resumable event feed.
Webhooks and unattended scheduled agents are separate product decisions.

### MCP Apps and state ownership

The shared Apps contract links a tool through `_meta.ui.resourceUri` to a
`ui://` HTML resource with MIME type `text/html;profile=mcp-app`. The iframe
uses the Apps bridge. It can call server tools without another model response.
The UI handshake is separate from the core protocol's removed initialization
handshake. See the [Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx).

Keep the UI focused. A reader or review panel is more useful than embedding the
whole Sangam application. Paginate and refresh through bridge tool calls.
Support inline layout first, then request other display modes only if the host
offers them. Preserve useful text when no UI is available. The
[Apps overview](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/overview.md)
describes these interactions and capability checks.

Use app-only visibility to reduce model tool clutter. It is not proof of human
identity or approval. A server must not trust `approved: true` merely because a
caller invokes a tool labeled app-only. Approval needs an authenticated decision
bound to exact content and version. A universal fallback can link to Sangam's
own authenticated review page.

SQLite stores the saved document and immutable revisions. A proposal stores
the base revision and exact reviewed wording. The iframe stores only local,
unsaved draft state. If another actor saves, the review becomes stale until
the user reloads or resolves the conflict. Closing an iframe cannot imply a
successful save. UI context sent to the assistant is contextual evidence, not
canonical storage or authority.

OpenAI's current [UI guidance](https://developers.openai.com/plugins/build/chatgpt-ui)
also recommends separating data tools from render tools. Use the shared bridge
first and add host-specific APIs only behind checks. Its
[server guidance](https://developers.openai.com/plugins/build/mcp-server)
explicitly requires useful results without UI and explains that `_meta` is not
secure storage. Do not assume that `structuredContent` is hidden from models.

### Reference implementations

#### OpenAI examples

The [MCP App Basics example](https://github.com/openai/openai-apps-sdk-examples/blob/main/mcp_app_basics_node/README.md)
demonstrates tool-result delivery, direct UI tool calls, model context updates,
follow-up messages, display modes, theme handling, capability discovery, and
partial tool input. It is useful for learning the bridge and building compatibility
fixtures. It does not establish Sangam's authorization or persistence design.

#### Grafana

Grafana's [Apps implementation guide](https://github.com/grafana/mcp-grafana/blob/main/docs/mcp-apps.md)
keeps source query tools useful for analysis and provides an explicit
`render_grafana_app` tool. Rendering reuses existing query handlers. The viewer
refreshes through the host and can return a selected time window to the agent.
Its HTML is bundled, and credentials remain on the server.

This is the closest reference for Sangam readers and evidence views. Keep
reading independent of rendering, and reuse domain handlers. Grafana's source
guide also documents size limits and fallback behavior. The guide was inspected;
the Go rendering handlers were not traced in this research.

#### Excalidraw

Excalidraw's [server source](https://github.com/excalidraw/excalidraw-mcp/blob/main/src/server.ts)
registers a drawing tool with shared Apps metadata, one shared HTML resource,
and app-only checkpoint tools for user edits. Its
[checkpoint store](https://github.com/excalidraw/excalidraw-mcp/blob/main/src/checkpoint-store.ts)
has file, memory, and Redis implementations with retention or expiry behavior.

Borrow the interactive editing and restoration experience. Do not copy its
checkpoint store as Sangam's document history. Temporary scene checkpoints and
revision-controlled documents have different durability requirements. Its
example parsing and permissive element types also do not meet Sangam's strict
boundary validation requirements without adaptation.

#### T3 Code

T3's [orchestrator MCP documentation](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md)
places MCP and WebSocket operations behind `ThreadManagementService`. Its
[tool definitions](https://github.com/pingdotgg/t3code/blob/main/apps/server/src/mcp/toolkits/orchestrator/tools.ts)
use typed contracts and shared service dependencies. Tool names such as
`task_status` are application APIs, not proof that the standard Tasks extension
is implemented.

Its [authentication design](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md)
separates outside MCP clients from ordinary app sessions and enforces an access
ceiling. Its [outside-agent guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/outside-agents.md)
describes OAuth setup and revocation.

Borrow the shared service boundary, separate client authority, and explicit
durable handles. T3's orchestration tools and environment federation solve its
own product needs. They are not required parts of a Sangam document server.

#### Cloudflare

Cloudflare's [server](https://github.com/cloudflare/mcp) exposes its large API
through Code Mode and also offers a per-endpoint tool mode. Treat its published
token figures as project claims, not Sangam benchmark results.

The [execution source](https://github.com/cloudflare/mcp/blob/main/src/tools/execute.ts)
routes sandbox network access through a restricted outbound worker, injects
credentials outside generated code, and tracks whether repeating work is safe.
Its [entry point](https://github.com/cloudflare/mcp/blob/main/src/index.ts)
configures OAuth and protected resource metadata.

Recovery follow-up on November 12 found two separate retry policies. The
executor withholds an OAuth retry challenge after a possible write and tells
the caller to run only unfinished steps. The
[HTTP helper](https://github.com/cloudflare/mcp/blob/main/src/utils/fetch-retry.ts)
retries 429 responses and network exceptions without a method-specific write
guard. No durable execution receipt or cross-request rollback was found in
the inspected executor. The Sangam recovery proposal is in Decision 3 of the
[technical design](02-tech-design-sangam-mcp.md).

Study programmable composition as well as credential isolation and explicit
retry reasoning. Code Mode is an
implementation pattern, not a requirement of MCP. Sangam has a much smaller
domain and existing review semantics. Arbitrary execution would require a
sandbox and a defensible policy for every action inside a program. A bounded
organization plan already offers useful batching with inspectable intent.

### File transfer follow-up

The November 10 [maintainer announcement](https://blog.modelcontextprotocol.io/posts/exploring-file-uploads-and-downloads-in-mcp/)
describes an experimental Files extension. Its
[draft](https://github.com/modelcontextprotocol/experimental-ext-file-uploads/blob/main/specification/draft/file-uploads.md)
defines file-marked tool inputs and upload negotiation before a tool runs,
with bytes transferred outside JSON-RPC. It is not stable and the announcement
reports no reference implementation. Decision 10 in the
[technical design](02-tech-design-sangam-mcp.md) reviews opaque file references
and separate native-client/App transfer paths. Protocol support and host
behavior have not been verified in this research pass.

Permission follow-up inspected the Files draft at source commit
`8a859b8f268926fe4beb84d78565e7cc6f9fa617` and affected Apps specification
sections at `19256f52cad5517ba8272581ed2e11d6a81273d5`. This was a source
review, not a runtime or host compatibility test. Other sections of this
report were not reverified in this follow-up.

The draft's Open Questions explicitly leave generic executors unresolved.
An outer file argument is suggested as a possibility, not a settled mapping.
Destinations hidden in arbitrary code do not provide typed preflight intent.
The draft requires host file-send approval or operator policy, separately from
server permission to perform the operation. It supports same-server target
paths with existing MCP credentials and forbids forwarding those credentials
to other origins. Omit targets carry separate authorization and require careful
destination control. App iframe fetch does not inherit the host's MCP token.

The Apps specification defines sandbox capabilities and network CSP, with no
general host-attachment selection/upload bridge in the reviewed capability
set. Browser file inputs, direct network transfers, and host-mediated Files
transfers are distinct paths. CORS/CSP do not replace service authorization.
PDF creation and image attachment retain the current `create` and `update`
checks respectively in `WorkspaceAccessService`.

Current committed images use workspace-wide `attachments/` references.
`read_document_asset` checks the requesting document's read authority and
skips a separate path grant for that shared prefix. `DocumentAssetService.read`
does not check whether the document contains the requested reference. This
source observation needs live confirmation of intended cross-document sharing;
it is not a claim of per-image ownership or a demonstrated exploit. Existing
relative-image tests check separate path scopes; they do not by themselves
establish isolation for shared root attachments.

The Files draft requires confirmation of stored bytes before finalization and
protects against replacement after verification. It binds continuation state
to the request and principal, requires atomic consumption for unsafe tools,
and treats a lost final retry response as an unknown outcome. A consumed state
can return a protocol error even when work already ran. Target URLs, headers,
inline bytes, and continuation secrets require redaction. Failure can leave
staged bytes even if the tool never ran. Resumable uploads remain future work;
the draft labels its download shape as not yet reviewed by the working group.

### Pi Durable recovery follow-up

The official [Pi Durable package](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md#code-mode)
includes durable Code Mode in QuickJS. Its
[implementation](https://github.com/earendil-works/pi/blob/main/packages/durable/src/codemode/codemode.ts)
journals result delivery and reattaches nested calls by key during deterministic
reconstruction. It refuses replay on divergence, runtime changes, or deadline
expiry. Unsafe interrupted tools return an error; external effects still need
application idempotency. This differs from blind whole-program retry and from
returning a failure for a new model-directed execution.

Pi Durable owns the agent loop and is marked experimental. It is not a drop-in
Monty durability library. Decision 3 in the
[technical design](02-tech-design-sangam-mcp.md) compares its approach with the
selected fresh MCP recovery behavior. This follow-up inspected source and
documentation; it did not install Pi Durable or run its recovery tests.

### What Sangam already has

The inspected repository has no MCP server imports or registered MCP endpoint
under `src/`. It already declares `mcp>=2.3.0,<3` in
[pyproject.toml](../../../pyproject.toml), and the lockfile pins 2.3.0. A dependency
does not mean that an MCP server is implemented.

[WorkspaceAccessService](../../../src/sangam/access.py) is the public workspace
boundary. Its document write path checks current paths, capabilities, revisions,
conditional requests, and idempotency. It records activity and coordinates
mutations before storage commits. MCP should call this boundary.

[ChatToolset](../../../src/sangam/chat_tools.py) provides bounded search, document
and PDF reads, history, proposals, and durable mutations. It records evidence
against the current run and uses the Agents SDK tool wrapper. It is not a
transport-neutral MCP adapter.

[ChatCapabilityRegistry](../../../src/sangam/chat_capabilities.py) has strict
models, effect classifications, and authority checks. Its resolution also
depends on chat entry point, attached document, and model compatibility.
Reuse suitable schemas and service behavior, but do not export the full chat
registry blindly as an MCP catalog.

[ChatProposalService](../../../src/sangam/chat_proposals.py) and
[ChatEffectService](../../../src/sangam/chat_effects.py) require internal chat
ownership or run records. Their current APIs are not a drop-in review service
for an external assistant. This is the principal unresolved implementation
boundary. Choose an explicit external invocation context or extract a small
shared review service. Avoid manufacturing internal chat runs merely to satisfy
foreign keys.

[ApplicationServices](../../../src/sangam/application.py) assembles shared
services, while [create_app](../../../src/sangam/api.py) owns FastAPI lifetime
and storage ownership. An in-process MCP adapter can reuse these objects and
avoid an extra process opening the workspace.

Existing [agent access](../../operations/agent-access.md) supplies scoped bearer
tokens, path grants, expiry, revocation, idempotent writes, and portable discovery.
That is useful for clients that support configured credentials. It is not a
complete interoperable OAuth login flow. Cloudflare Access authentication for
the web application also does not by itself supply MCP OAuth discovery.

The [chat contract](../../chat-capabilities.md) intentionally excludes credential
and administrator operations. MCP should not accidentally expose token issuance,
trust changes, backups, provider secrets, or unrestricted HTTP and SQL tools.
Any deliberate difference should be documented as a separate authority decision.

### Implementation constraints found in Sangam

The implementation-oriented pass examined the current skill catalog, identity
resolution, review ownership, and existing background jobs. These observations
refine the earlier recommendation; they do not establish new runtime behavior.

#### Central skills already exist inside chat

[ChatSkillService](../../../src/sangam/chat_skills.py) registers Markdown
documents as skills. Registration is explicit, uses idempotency records, checks
frontmatter, and records a personal or project scope. Project registration
requires explicit document membership. Catalog summaries read current document
content, report diagnostics, and omit documents the caller cannot read.
The [chat API](../../../src/sangam/api_chat.py) already has list, get, register,
and unregister routes for these skills.

There are two different instruction sources to account for. The built-in
[agent guide](../../../src/sangam/agent_docs.py) teaches operation of Sangam.
Registered document-backed skills teach user-authored procedures. Neither is
currently an MCP Skills implementation. An external catalog can reuse these
sources without introducing a second user-authored skill database.

Current listing uses the requesting actor's identity for personal skills.
Project listing calls `authorize`, which requires administrator authority for a
non-system principal. A new agent identity therefore does not automatically see
the owner's personal skills or gain project skill access. A connection needs
an explicit relationship to the authorizing owner and the skills it may read.
Mapping every OAuth caller to a trusted administrator would bypass the existing
capability checks and is not a suitable shortcut.

The current service is not a standard skill bundle exporter. Its metadata model
retains `name`, `description`, and `scripts`, with other frontmatter ignored.
Activation returns procedure text and bounded snippets of linked Sangam documents.
It does not return the complete original frontmatter and a file manifest with
digests, sizes, and relative supporting-file paths. The
[MCP Skills contract](https://modelcontextprotocol.io/extensions/skills/overview)
requires that complete representation. Export needs an explicit bundle mapping,
including collision-safe identity, access checks for supporting files, and
stable bytes for each manifest.

Activation pins the skill and referenced document revisions through
`chat_skill_reads` when an internal turn context exists. That table has a foreign
key to `chat_turn_contexts` in the
[skills migration](../../../src/sangam/migrations/036_chat_skills.sql).
External retrieval needs a revision-bound export independent of that internal
context. Scripts are reported as unsupported by the current chat runtime.
Advertising instructions to an external host does not establish a Sangam script
execution service or grant the host permission to execute them.

#### MCP needs a distinct authentication entry point

[AuthenticationService.resolve](../../../src/sangam/security.py) accepts an
existing agent bearer credential first. Without one, it follows the configured
human authentication mode. In single-user mode it ultimately creates a trusted
human administrator principal. Calling this resolver unchanged from a newly
exposed MCP route would inherit that fallback.

The MCP boundary must require its own supported credentials for private actions.
Discovery and OAuth metadata can be public without treating the caller as a
workspace principal. Validating OAuth includes issuer and resource audience
checks, as required by the
[authorization security contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations.md).

Existing agent authentication checks expiry and revocation and loads current
capability/path grants. `IdentityService.reauthorize` refreshes grants for
in-flight work. OAuth grant and refresh lifecycles are additional behavior,
not features already supplied by the current agent-token implementation.
The current principal holds actor, token, operation, scope, and approval
provenance. It has no separate OAuth connection or delegating-owner field.
Consent ownership, caller attribution, skill visibility, and revocation need a
consistent mapping rather than a transport-only bearer-token wrapper.

#### Review is coupled to internal conversations

[ChatProposalService.create](../../../src/sangam/chat_proposals.py) requires an
owned internal thread even though its source context and run are optional.
[ChatEffectService.propose](../../../src/sangam/chat_effects.py) takes both an
internal run and thread. Effects and runs have mandatory chat foreign keys in
the [capability migration](../../../src/sangam/migrations/018_chat_capabilities_and_effects.sql).
Effect lookup also checks thread ownership or requesting actor identity.

External review therefore requires a deliberate application boundary change.
The reusable behavior includes exact previews, revision validation, digest-bound
decisions, idempotent execution, and current authorization. The internal chat
ownership model cannot simply be assumed for an OAuth client. An external
connection's write authority and a human review decision are separate facts.

#### Long-running work has an existing domain owner

[PdfResearchService](../../../src/sangam/pdf_research.py) already persists
extraction status, lists pending extractions, and recovers interrupted claims.
[CaptureService](../../../src/sangam/capture.py) fetches guarded URLs and calls
workspace import/create operations. A capture response and completed PDF text
extraction are different outcomes. A future Tasks adapter should reflect these
domain records and completion conditions; adding a second independent job
scheduler would introduce competing state ownership.

### Implementation options

| Option | Advantages | Costs and limits | Judgment |
| --- | --- | --- | --- |
| Python MCP mounted in Sangam | Calls shared services directly; uses existing SDK dependency; one authorization boundary and lifecycle. | Requires explicit external invocation and review semantics. | Recommended. |
| Separate MCP adapter over REST | Independent deployment; REST remains the authority; can use a different language. | Another process, credentials, network failures, error translation, and schema maintenance. | Reasonable if adapters must ship independently. |
| Generated tool for every REST endpoint | Fast coverage of an existing API. | Exposes infrastructure operations unless filtered; increases context and awkward parameter shapes; does not solve review. | Useful as a coverage inventory, unsuitable as the product contract. |
| Code Mode or generic execute tool | Compact discovery for very large APIs and programmable composition. | Sandbox, execution policy, retry, and exact approval complexity. | Poor fit for current Sangam workflows. |
| Skill and REST only | Existing functionality and smallest operating burden. | Host must have its own HTTP or CLI access; lacks standard MCP discovery and optional inline Apps. | Keep supported alongside MCP. |

The official [Python SDK v2 guide](https://py.sdk.modelcontextprotocol.io/whats-new/)
uses `MCPServer`, rather than the former bundled `FastMCP` import. It also states
that the redesigned Tasks extension is not yet implemented. Do not confuse
the official SDK's former FastMCP API with a separately distributed framework.

The SDK documents [ASGI mounting](https://py.sdk.modelcontextprotocol.io/run/asgi/),
[legacy client compatibility](https://py.sdk.modelcontextprotocol.io/run/legacy-clients/),
and a built-in [Apps extension](https://py.sdk.modelcontextprotocol.io/advanced/apps/).
These support an in-process design. Published documentation is not proof of
every API in Sangam's exact locked wheel. After installing locked dependencies
with `just setup`, source inspection confirmed `Apps`, its UI binding decorator,
and `client_supports_apps` in the installed 2.3.0 package. This was source
inspection, not an interoperability test. Remaining APIs need version checks.

### Candidate functionality and boundaries

The following are workflow candidates, not a commitment to expose every tool.

| User task | Candidate contract | Important boundary |
| --- | --- | --- |
| Find evidence | Search with filters and bounded passages. | Filter authorized data before pagination; return exact source locations. |
| Read evidence | Read document, exact revision, PDF page, and annotations. | Pin multi-part reads to a revision; no unbounded workspace dump. |
| Understand change | History summaries and revision diff. | Distinguish content revision from representation or metadata version. |
| Save new work | Create document. | Stable operation key, explicit path, content type, and returned saved revision. |
| Edit existing work | Prepare proposed wording and obtain proposal status. | Base revision, exact content digest, evidence, and authenticated review. |
| Organize material | Inspect organization and prepare a bounded plan. | Preflight source and destination grants; expose each material operation. |
| Work with projects | Inspect membership and request explicit membership changes. | Stable project identity; folder names do not establish project scope. |
| Discuss sources | Read or create comments and PDF notes. | Preserve document/page relationships and current access. |
| Publish | Separate publish/update/unpublish actions. | Explicit revision and exposure policy; credential issuance stays administrative. |
| Capture or import | Capture a URL or initiate an existing import flow. | Guard network access and report durable job state; binary upload is a distinct contract. |
| Observe work | Read operation status and optionally subscribe. | No claim of completion until durable state proves it. |

Resources can use a server-defined namespace for current documents, immutable
revisions, and PDF pages. Exact URI spelling is still a design choice. Recheck
authorization on resource reads, UI calls, status reads, and notifications.
An opaque ID is a reference, not a permission grant.

Keep private document resource caches private. Version UI resource URIs when
bundled UI changes. Use a narrow CSP and bridge calls so iframe code does not
need bearer tokens. Treat retrieved document content as untrusted evidence.

An MCP request ID is not an application idempotency key. If a response is lost,
the caller can send a new protocol request with the same operation key. A stale
revision requires a new deliberate edit after reading current content. Neither
a progress event nor a socket close establishes whether the original write
committed.

For authentication, support configured scoped tokens where clients allow them,
and interoperable OAuth for hosts that require browser authorization. Validate
the resource audience and issuer, use PKCE where applicable, and map consent
to actual Sangam grants. The
[authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
allows an external authorization server; Sangam need not implement a general
identity platform. Tool-call parameters cannot select a more privileged actor.

## Tests and verification

This is source and documentation research. No MCP server was built or executed.
No host, OAuth flow, UI bridge, subscription, or Tasks interoperability was
verified at runtime. No performance measurements were taken.

Read selected existing test names and fixtures in
[capability lifecycle tests](../../../tests/test_chat_capability_lifecycle.py)
and [audit provenance tests](../../../tests/test_audit_provenance.py).
They cover authority filtering, exact effect previews, digest-bound decisions,
duplicate delivery, denial, revoked tokens, and audit behavior. They were not
run as proof of this proposed MCP design.

The implementation-oriented pass also read registration, project scoping,
unsupported scripts, and revision-pinning cases in
[skill tests](../../../tests/test_chat_skills.py). Those cases use the trusted
human/internal chat path. They do not demonstrate external OAuth skill visibility
or MCP manifest conformance, and were not executed during this research pass.

Implementation verification must exercise real protocol requests against an
isolated instance. Include unauthorized reads, scoped pagination, stale writes,
lost responses after commit, duplicate operation keys, revocation, oversized
inputs, resource access, and error recovery. Test core workflows without Apps,
subscriptions, elicitation, or Tasks. Then test each advertised extension.
Use project `just` recipes and the existing behavior and browser skills.

`just setup` passed and installed locked dependencies. The first
`just test-docs` attempt passed local links but failed because frontend `jsdom`
was not installed. After setup, `just test-docs` passed all local links, parsed
one Mermaid diagram, and reported zero Markdown lint issues. `git diff --check`
also passed for tracked changes; the report remains an untracked addition.
Frontmatter scalar syntax was manually reviewed. Application build, unit tests,
`just verify-behavior`, and browser tests were not run for this research-only
change. No application behavior is claimed as newly verified.

## Navigation

Local source inspection is selective. It covers the public workspace boundary,
chat adapter, capability registry, proposal and effect persistence, application
composition, API registration, dependency lock, and representative test contracts.
It is not a review of every REST operation or security property.

The versioned standard is the source of protocol claims. Reference implementations
show useful patterns but may use older SDK imports and host-specific behavior.
They should not be copied as a single universal stack.

## Open questions

1. Which useful workflow defines the first MCP contract: evidence research,
   reviewed editing, or general document automation? Reviewed editing is the
   strongest candidate from this research.
2. Should existing-document MCP writes always produce proposals, or may a
   separately granted automation token write directly? Current REST agents can
   write directly; internal chat has a different proposal contract.
3. Should external proposals use a small shared review service or an explicit
   external invocation record? Current chat tables assume internal ownership.
4. Should OAuth be supplied by an existing identity provider, a narrow built-in
   authorization component, or both deployment options?
5. Which SDK release provides the documented Skills adapter, and should Sangam
   upgrade or supply its own implementation? Apps registration helpers were
   confirmed in 2.3.0; Skills helpers were not found there.
6. What bounds and retention should external operation and proposal records have?
   Notification recovery must not depend on unspecified event replay.
7. Which workflows justify inline UI? A reader and exact proposal review are
   stronger candidates than a full workspace dashboard.
8. How should canonical skills be grouped, released, and retained for active
   workflows? Which compatibility bootstrap is needed when a host cannot
   activate remotely served skills?
9. How should a connection select the owner's registered personal and project
   skills while retaining the connected caller's narrower authority? Current
   actor-based listing does not provide delegated owner access.
10. How should registered skill documents and their linked references map to
    stable bundle paths, complete frontmatter, and revision-bound manifests?

Host preference is resolved: the user wants a universal contract. Compatibility
tests should sample independent hosts without giving any host's private API
control over Sangam's core behavior.
The desired normal onboarding is also resolved: connect and authorize an
assistant, with centrally served instructions. The learning scope includes
advanced patterns even when their immediate product fit is limited.
