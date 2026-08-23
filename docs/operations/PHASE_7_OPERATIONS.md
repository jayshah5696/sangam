# Phase 7 operations

## Runtime configuration

Workspace chat uses connection records in SQLite and credentials from the
backend process environment. OpenRouter is the seeded preset:

```dotenv
SANGAM_OPENROUTER_API_KEY=replace-with-openrouter-api-key
SANGAM_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
SANGAM_OPENROUTER_APP_TITLE=Sangam
SANGAM_OPENROUTER_HTTP_REFERER=https://sangam.example.com
SANGAM_CHAT_DEFAULT_MODEL=openai/gpt-5.4-mini
SANGAM_CHAT_AVAILABLE_MODELS=["openai/gpt-5.4-mini","openai/gpt-5.4-nano","openai/gpt-5.6-terra"]
SANGAM_CHAT_REASONING_EFFORT=low
SANGAM_CHAT_MAX_REQUEST_BYTES=1000000
SANGAM_CHAT_MAX_OUTPUT_TOKENS=4096
SANGAM_CHAT_MAX_CONCURRENT_RUNS=4
SANGAM_CHATKIT_DOMAIN_KEY=replace-with-registered-domain-key
```

`SANGAM_OPENROUTER_API_KEY` stays in the backend process. The OpenRouter preset
stores `SANGAM_OPENROUTER_API_KEY` as a credential reference, not as a secret
value. API responses and object representations report only whether the
credential is available. This key powers inference. It does not register the
browser origin with ChatKit.

Open **Settings > Operations & AI** to manage the connection after first boot.
SQLite becomes authoritative after an operator edits the preset. The legacy
`SANGAM_CHAT_DEFAULT_MODEL` and `SANGAM_CHAT_AVAILABLE_MODELS` values seed a new
database only; changing them later does not replace saved workspace policy.

To add a connection:

1. Put the credential in the backend environment, if the endpoint requires one.
2. Add its HTTPS base URL, protocol, and credential environment-variable name.
3. Select **Test connection**.
4. Discover `/models`, or enter a bounded manual model ID when discovery is not
   available.
5. Review compatibility and explicitly override an unknown model only after
   proving that tool calls work.
6. Enable the connection, select its models, and save the versioned workspace
   settings.

Production connection URLs must use HTTPS. Development permits HTTP only for
loopback hosts. A model reference includes its stable connection ID, so two
connections may expose the same upstream model ID without colliding.

The runtime reports provider inference and ChatKit browser transport separately.
Provider inference has five states: disabled by workspace policy, missing a
credential, ready, unreachable, or incompatible. ChatKit transport is either
ready or misconfigured. A provider can be ready while the browser transport is
misconfigured. The Settings page shows both states. History and pending proposal
review remain available when inference is not ready.

## ChatKit domain registration

`local-dev` works only when the browser opens Sangam on localhost. Every other
hostname needs a ChatKit domain key, including private Tailscale hostnames.
OpenAI currently charges no separate fee for registration, but it requires an
OpenAI Platform account because OpenAI operates the allowlist and hosted ChatKit browser
component. An OpenAI API key or OpenAI model credits are not required when Sangam
uses OpenRouter for inference.

Register a deployment:

1. Give Sangam one stable HTTPS hostname. With Tailscale Serve, run
   `tailscale serve status` and use the exact `*.ts.net` name it reports.
2. Open OpenAI's
   [Domain Allowlist](https://platform.openai.com/settings/organization/security/domain-allowlist).
3. Add only the hostname, such as `sangam.example-tailnet.ts.net`. Do not include
   `https://`, a port, or a path.
4. Copy the generated domain key into the deployment environment:

   ```dotenv
   SANGAM_CHATKIT_DOMAIN_KEY=domain_pk_replace-with-generated-key
   ```

5. Recreate the container so Compose applies the changed environment:

   ```bash
   docker compose up -d --force-recreate sangam
   ```

6. Open Sangam through the registered HTTPS hostname and select **Check again**.
   Allowlist changes may take a few minutes to become effective.

The domain key is public browser configuration, not an authentication secret.
It proves that the page hostname is on the allowlist. Keep the OpenRouter API key
server-side as usual. Sangam reports transport as misconfigured and will not
mount ChatKit when a non-loopback request would receive `local-dev` or an empty
key. Production mode also rejects that configuration at startup.

This deployment is self-hosted at the application layer: Sangam owns the backend,
thread store, authentication, tools, and inference connection. The browser UI is
still an OpenAI dependency. Sangam downloads ChatKit's bootstrap from
`https://cdn.platform.openai.com/deployments/chatkit/chatkit.js`, renders an
OpenAI-hosted iframe, and the iframe contacts `https://api.openai.com` to verify
the domain key. Chat availability therefore depends on those OpenAI services even
when model inference runs through OpenRouter.

The CSP must continue to restrict `script-src` to Sangam and that exact CDN. Do
not broaden `frame-src` beyond HTTPS OpenAI hosts and the separately configured
trusted-preview origin.

## Provider credential rotation

1. Create a replacement credential with an appropriate spend limit.
2. Replace the value named by the connection's credential reference.
3. Restart Sangam and send one low-cost grounded read through the chat rail.
4. Revoke the old credential at the provider.
5. Review provider usage and Sangam logs for unexpected failures.

Chat history remains available while inference is unconfigured. Do not paste a
provider key into the browser, a conversation, a Document, or a support log.

## Streaming and buffering diagnostics

ChatKit uses `POST /api/v1/chatkit` for streaming and non-streaming protocol
operations. Streaming responses set `Content-Type: text/event-stream`,
`Cache-Control: no-cache, no-store`, and `X-Accel-Buffering: no`. Preserve these
headers in any reverse proxy.

Through the production application hostname:

1. Sign in through the configured access layer and open a document.
2. Select **Chat**, then **Ask about this document** to open the full-page chat route.
3. Ask for a grounded summary that requires `read_document`.
4. Confirm the user item appears immediately.
5. Confirm workflow progress appears before the final answer.
6. Stop a second response mid-stream and confirm the partial response remains
   visible and retry is offered.
7. Retry it and confirm only one completed retry appears in durable history.
8. Inspect the response in browser network tools. It must remain an open SSE
   response with event chunks arriving before completion.

To automate the send-and-receive check against a configured deployment, run:

```bash
cd frontend
SANGAM_DEPLOYED_CHAT_ORIGIN=https://sangam.example.test \
  npx playwright test e2e/chat-deployed-smoke.spec.ts --project=chromium-desktop
```

The origin must already be reachable from the test machine and registered with
ChatKit. The command does not embed a deployment address or credential in the
repository.

If all events arrive at once, check Cloudflare and any origin proxy for response
buffering, compression, or caching on `/api/v1/chatkit`. Do not add polling or a
second WebSocket transport as a workaround.

## Failure and recovery

- A missing key returns a structured retry-safe ChatKit error; existing history
  continues to load.
- A cancelled response is persisted using ChatKit's hidden cancellation context
  so the next turn does not continue the abandoned answer.
- A provider or network failure produces a ChatKit error item with retry enabled.
- Completed thread items are durable in SQLite and included in normal backups.
- A pending edit proposal remains unapplied across restart.
- If a Document revision commits before its proposal status is updated, retry
  the same proposal. Sangam reuses the proposal's reserved idempotency key and
  completes the status transition without creating a second revision.
- A proposal whose expected revision is no longer current becomes stale when
  application receives the normal Document conflict.

Restore chat state with the same SQLite restore procedure as other canonical
Sangam state. Do not restore only materialized workspace files and expect thread
or proposal history to reappear.

## Manual production release gate

Local automation does not own Cloudflare DNS, Access policy, ChatKit domain
registration, or production provider credentials. Before declaring Phase 7
deployed, record evidence for:

- Registered production ChatKit origin and domain key.
- Cloudflare Access allow and deny behavior on `/api/v1/chatkit`.
- Incremental workflow and token events through the real Tunnel.
- Stop and retry through Access without proxy buffering.
- A grounded Document citation and PDF page/annotation citation.
- Proposal review, concurrent conflict, and attributed application.
- No provider credential or selected document content in proxy/application logs.
- No direct WAN exposure of port 8000.
