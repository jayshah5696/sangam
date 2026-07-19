# Phase 7 operations

## Runtime configuration

Workspace chat requires a server-side OpenRouter key:

```dotenv
SANGAM_OPENROUTER_API_KEY=replace-with-openrouter-api-key
SANGAM_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
SANGAM_OPENROUTER_APP_TITLE=Sangam
SANGAM_OPENROUTER_HTTP_REFERER=https://sangam.example.com
SANGAM_CHAT_DEFAULT_MODEL=openai/gpt-5.4-mini
SANGAM_CHAT_AVAILABLE_MODELS=["openai/gpt-5.4-mini","openai/gpt-5.4-nano","openai/gpt-5.6-terra"]
SANGAM_CHAT_REASONING_EFFORT=low
SANGAM_CHATKIT_DOMAIN_KEY=replace-with-registered-domain-key
```

`SANGAM_OPENROUTER_API_KEY` stays in the backend process. The config endpoint
returns only whether it is present, the provider name, ChatKit domain key, and
the model allowlist. After changing the allowlist, restart Sangam and confirm
the composer contains exactly the enabled models.

The default lower-cost choices are `openai/gpt-5.4-mini` and
`openai/gpt-5.4-nano`. Keep a model in the allowlist only after confirming that
OpenRouter reports tool support and accepts it through `/api/v1/responses`.
Sangam deliberately rejects arbitrary model IDs submitted by the browser.

## ChatKit domain registration

`local-dev` is only for localhost. Register every production application origin
in ChatKit, store the returned domain key in `SANGAM_CHATKIT_DOMAIN_KEY`, and
rebuild/restart the deployment. The application loads ChatKit's bootstrap from
`https://cdn.platform.openai.com/deployments/chatkit/chatkit.js`; the iframe UI
is hosted by OpenAI even though Sangam owns the backend, store, and inference
pipeline.

The CSP must continue to restrict `script-src` to Sangam and that exact CDN.
Do not broaden `frame-src` beyond HTTPS OpenAI hosts and the separately
configured trusted-preview origin.

## OpenRouter key rotation

1. Create a replacement key with an appropriate spend limit in OpenRouter.
2. Replace `SANGAM_OPENROUTER_API_KEY` in the process secret or `.env` file.
3. Restart Sangam and send one low-cost grounded read through the chat rail.
4. Revoke the old key in OpenRouter.
5. Review OpenRouter usage and Sangam logs for unexpected failures.

Chat history remains available while inference is unconfigured. Do not paste a
provider key into the browser, a conversation, a Document, or a support log.

## Streaming and buffering diagnostics

ChatKit uses `POST /api/v1/chatkit` for streaming and non-streaming protocol
operations. Streaming responses set `Content-Type: text/event-stream`,
`Cache-Control: no-cache, no-store`, and `X-Accel-Buffering: no`. Preserve these
headers in any reverse proxy.

Through the production application hostname:

1. Sign in through Cloudflare Access and open a Document's Chat tab.
2. Ask for a grounded summary that requires `read_document`.
3. Confirm the user item appears immediately.
4. Confirm workflow progress appears before the final answer.
5. Stop a second response mid-stream and confirm the partial response remains
   visible and retry is offered.
6. Retry it and confirm only one completed retry appears in durable history.
7. Inspect the response in browser network tools. It must remain an open SSE
   response with event chunks arriving before completion.

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
- A proposal whose expected revision is no longer current becomes stale when
  application receives the normal Document conflict.

Restore chat state with the same SQLite restore procedure as other canonical
Sangam state. Do not restore only materialized workspace files and expect thread
or proposal history to reappear.

## Manual production release gate

Local automation does not own Cloudflare DNS, Access policy, ChatKit domain
registration, or production OpenRouter credentials. Before declaring Phase 7
deployed, record evidence for:

- Registered production ChatKit origin and domain key.
- Cloudflare Access allow and deny behavior on `/api/v1/chatkit`.
- Incremental workflow and token events through the real Tunnel.
- Stop and retry through Access without proxy buffering.
- A grounded Document citation and PDF page/annotation citation.
- Proposal review, concurrent conflict, and attributed application.
- No provider key or selected document content in proxy/application logs.
- No direct WAN exposure of port 8000.
