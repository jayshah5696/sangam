# Integrations

## Karakeep bridge

The Karakeep bridge imports archived Karakeep bookmarks as editable Markdown
while preserving provenance (original URL and capture timestamp).

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_KARAKEEP_BASE_URL` | None | Base URL of your Karakeep instance |
| `SANGAM_KARAKEEP_API_KEY` | None | Karakeep API key |
| `SANGAM_KARAKEEP_TIMEOUT_SECONDS` | `20.0` | Request timeout in seconds |
| `SANGAM_MAX_KARAKEEP_SOURCE_BYTES` | `5000000` | Maximum bookmark payload size in bytes |

### Workflow

1. Open **Karakeep imports** under **Settings → Operations**. You can also
   choose **Open Karakeep imports** in the Command Palette or **Import from
   Karakeep** in the **Capture** dialog.
2. Search Karakeep and import selected bookmarks to your chosen workspace path.
   Only bookmarks you choose become Sangam documents.
3. Use **Check for refresh** to re-fetch a bookmark. If you edited the imported document,
   Sangam shows a diff for review instead of overwriting your changes.
4. Retry failed imports safely. Imports are idempotent, so retries never create
   duplicate documents.

To rotate the Karakeep API key, update `SANGAM_KARAKEEP_API_KEY`, restart
Sangam, and run one import or health check. After restoring from a backup, open
Karakeep imports to verify existing provenance records survived.

## Chat runtime

Sangam pairs the ChatKit browser UI with the OpenAI Agents SDK on the backend.
Choose the OpenRouter preset or configure another OpenAI-compatible endpoint. See [chat-capabilities.md](../chat-capabilities.md)
for capability descriptors and durable effects, and
[architecture.md](../architecture.md) for the trust model.

### Chat configuration

| Variable | Default (`Settings`) | Purpose |
| --- | --- | --- |
| `SANGAM_OPENROUTER_API_KEY` | None | Provider API key |
| `SANGAM_OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible inference base URL |
| `SANGAM_CHATKIT_DOMAIN_KEY` | `local-dev` | Domain key registered for your origin |
| `SANGAM_CHAT_DEFAULT_MODEL` | `openai/gpt-5.6-luna` | Default model slug |
| `SANGAM_CHAT_AVAILABLE_MODELS` | 5 seeded OpenAI slugs | JSON list of selectable model slugs |
| `SANGAM_CHAT_REASONING_EFFORT` | `medium` (`low` in Compose) | Reasoning effort preset |
| `SANGAM_CHAT_TIMEOUT_SECONDS` | `120.0` | Per-run timeout in seconds |
| `SANGAM_CHAT_MAX_TOOL_ROUNDS` | `24` (`8` in Compose) | Tool-call round budget per run |
| `SANGAM_CHAT_MAX_CONCURRENT_RUNS` | `4` | Parallel chat runs admitted at once |

See [configuration.md](../configuration.md#chat-and-providers) for Compose overrides and the remaining chat settings.

Manage provider connections, model slugs, chat skills, and permission mode in
**Settings -> AI & models**. Permission mode is stored in SQLite beside model
selection:

- **Review every effect** (default): Pauses every durable effect for an exact
  approval decision.
- **YOLO · run without approval**: Runs effects without prompting and attempts
  to apply chat proposals, subject to the same grants and revision checks.

### ChatKit domain registration

`SANGAM_CHATKIT_DOMAIN_KEY=local-dev` works only on `localhost` or `127.0.0.1`.
Every non-loopback hostname requires a registered ChatKit domain key, including
private Tailscale `*.ts.net` hostnames.

1. Determine your stable HTTPS hostname. For Tailscale Serve, run
   `tailscale serve status` and copy the exact `*.ts.net` hostname.
2. Open OpenAI's
   [Domain Allowlist](https://platform.openai.com/settings/organization/security/domain-allowlist).
3. Add only the hostname (e.g., `sangam.example.ts.net`). Omit `https://`,
   ports, and trailing paths.
4. Set the generated key in your deployment environment:

   ```dotenv
   SANGAM_CHATKIT_DOMAIN_KEY=domain_pk_...
   ```

5. Recreate the container so it picks up the new environment:

   ```sh
   docker compose --env-file deploy/.env -f deploy/compose.prod.yaml up -d --force-recreate sangam
   ```

6. Open Sangam on the registered HTTPS hostname and select **Check again**.
   Allowlist updates can take a few minutes to propagate.

### Accounts and browser transport

Register the domain from your OpenAI Platform account. Configure an inference
credential for the provider you use, such as an OpenRouter API key.

- **Key security:** The domain key is public browser configuration, not an
  authentication secret. It tells ChatKit's CDN that the origin hostname is
  allowlisted.
- **Hosted UI:** Sangam manages threads, history, authorization, and tools.
  Model requests go to the configured provider. The browser loads ChatKit's
  bootstrap script
  from `https://cdn.platform.openai.com/deployments/chatkit/chatkit.js` and
  renders an OpenAI-hosted iframe that validates the domain key against
  `https://api.openai.com`.

### Production operational notes

- **Reverse proxies and Cloudflare:** Disable response buffering and client-side
  optimizations such as Rocket Loader on the application origin. Do not cache
  `/api/v1/chat` or `/api/v1/chatkit`.
- **Key rotation:** Update the saved provider connection in **AI & models**.
  For an environment-provided key, update the deployment environment and
  recreate the container. A restart can interrupt active runs.

## Web research (Brave Search)

Web research is off by default. To enable `search_web` and `read_web_source` in
workspace chat, set both variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_WEB_RESEARCH_ENABLED` | `false` | Expose read-only web research tools to chat |
| `SANGAM_BRAVE_SEARCH_API_KEY` | None | Brave Search API key (required when enabled) |

Sangam fails startup if `SANGAM_WEB_RESEARCH_ENABLED=true` is set without an API
key. See [chat-capabilities.md](../chat-capabilities.md#web-research) for
guardrails, SSRF protections, and source recording rules.
