# MCP document workspace

The experimental MCP slice finds a Markdown document through restricted Python,
opens it in an MCP App, checkpoints edits, and saves through Sangam's existing
revision-aware write service. The normal UI, REST API, and MCP share permissions.

## Local walkthrough

```sh
just setup
just mcp-demo
```

The command builds the frontend and self-contained App, starts port 8873 with
an isolated database/workspace, and seeds **Sangam MCP walkthrough**. It prints
the host URL and a mode-0600 disposable key file path, never the key itself.
Keep that terminal running. Use `just mcp-demo 8874` for another port.

1. Open `http://127.0.0.1:8873/mcp-host.html`.
2. Paste the key file's contents into **Sangam API key** and select **Connect**.
   The key can read, search, and update only `mcp-demo/`.
3. Search for `walkthrough` and open the result.
4. Edit a paragraph and wait for **Draft backed up**. The normal Sangam document
   still holds its previous saved revision.
5. Select **Reopen App**. The server restores the acknowledged draft without
   using the frame's local storage.
6. Select **Save**. **All changes saved** means the canonical service committed
   the revision. Open the document in normal Sangam to check it.
7. Expand **Connection and tool trace** to inspect the actual MCP calls.

To see a conflict, keep a checkpointed App draft, save a different revision in
normal Sangam, then refresh the App. The draft survives, the App shows the new
saved content for comparison, and a stale Save cannot overwrite it. Discard
requires confirmation. Unacknowledged edits can still be lost on abrupt teardown.

The local host uses the official TypeScript MCP client and AppBridge. Search
runs actual Python in Monty. App HTML comes from `resources/read` and runs in an
opaque-origin `allow-scripts` iframe with network access denied. The key stays
in host memory. The host permits only the exact built App script hash; normal
Sangam keeps its existing CSP. No model response or domain operation is simulated.

Press Ctrl+C in the demo terminal to stop and remove the disposable workspace
and key. Verification artifacts remain under `artifacts/verify-sangam/`.

## Connect another MCP client

Set `SANGAM_MCP_ENABLED=true` on an existing instance. Connect to `/mcp/` with
the same bearer key used for REST. Set `SANGAM_MCP_ALLOWED_HOSTS` for a public
request hostname and port. This creates no tunnel; remote clients cannot reach
your machine's localhost automatically. Even single-user mode requires a key.

The model tools are `search`, `execute`, and `present`. The typed interaction
tool `mcp_app` has App-only visibility. Hosts must honor visibility metadata;
it never substitutes for authorization. Every operation checks current grants.

The slice catalog contains `documents.search`, `documents.read`,
`documents.update`, and `executions.get`. Discovery returns their schemas and
retry rules. Calls use keyword arguments. For example:

```python
hits = await documents_search(query="walkthrough", limit=10)
hits["items"]
```

```python
document = await documents_read(document_id="document-id")
await documents_update(
    document_id=document["document_id"],
    expected_revision_id=document["current_revision_id"],
    content="# Revised content",
    operation_key="retain-this-key-for-this-exact-write",
)
```

Each execute requires a caller-retained `execution_key`. Its final expression
appears under the small `output` field. Search supports `offset` pagination;
read results include the revision and a `next_offset` for bounded passages.

## Recovery and persistence

Execution starts fresh in a separate Monty worker. There are no interpreter
variables across calls, filesystem mounts, general network callbacks, shell,
or application objects. The launcher clears inherited environment secrets.

Duplicate delivery cannot start another program. Failure returns original write
keys and committed, rejected, or uncertain outcomes. Earlier writes remain saved.
Inspect `await executions_get(execution_key="original-key")` in a fresh execution.
Never replay the full mutating program or replace a write key after losing a
response. The authenticated `sangam://execution/{execution_key}` resource also
provides recovery without admitting new Python work, including at receipt quota.

Detailed results expire after seven days by default. Compact identity and write
references remain. Cached output retains source access dependencies, including
dependencies inherited from earlier executions. Narrowing grants blocks retrieval.
Restart marks unfinished executions interrupted and never replays them.

App checkpoints use actor ownership, workspace IDs, and optimistic versions.
They create no document revision. Save commits and clears only its own checkpoint;
replaying an old Save cannot erase a newer draft. Quota failure preserves the
last acknowledged copy. Drafts survive App closure and restart until Save or
Discard. Clean layouts expire after 30 inactive days; polling does not renew them.

## Limits and current scope

The pool admits two executions without an unbounded queue. Each call has a
10-second wall deadline, 1-second interpreter budget, 32 MB allocation budget,
100-frame recursion limit, and 32 host callbacks. Workers have a 512 MiB Unix
address-space cap and 30-second CPU backstop and are replaced after each checkout.
These are conservative slice defaults, not measured production capacity. The
launcher requires Unix resource limits; other platforms are not verified.

See [Configuration](configuration.md#mcp) for source/output limits, quotas, and
retention settings. Existing document byte limits still govern writes and drafts.

This slice opens one Markdown document per App. OAuth issuance, PDFs, binary
upload, native Skills/Tasks, proposals, and assistant delegation remain outside
this slice. See the [broader technical design](tasks/mcp-sota/02-tech-design-sangam-mcp.md).
Local bridge verification does not establish compatibility with every external host.

## Verification

```sh
just test
just verify-mcp
just test-e2e 'e2e/mcp-workspace.spec.ts'
```

`verify-mcp` starts a real isolated server and uses the official Python client
over HTTP. It verifies authentication, Monty search, App resources, checkpointing,
failure after commit, duplicate delivery, conflict preservation, revocation,
and SQLite integrity. It saves `mcp-slice.json` without credentials. CI runs it
after building the frontend.

Backend integration tests also cover interpreter exhaustion, nested cached-result
authority, concurrent duplicates, save replay with newer drafts, and application
restart. They use real workers and services. Browser tests use the real client
and bridge, check persisted content through REST, and cover desktop/narrow
Chromium, touch-mobile Chromium, and mobile WebKit. Screenshots and walkthrough
videos go to Playwright artifact directories rather than product baselines.
