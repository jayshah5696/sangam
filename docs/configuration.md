# Configuration

These server environment variables correspond to `Settings` in
`src/sangam/config.py`. Process environment variables take precedence over
values in a local `.env` file. The tables show application defaults and call
out Compose overrides. Compose fixes the four storage and frontend paths.
`SANGAM_IMAGE` selects the Compose image and is separate from server settings.

`just check-distribution` checks that `.env.example`, `compose.yaml`, and
`deploy/compose.prod.yaml` list the settings. See [Deployment](operations/deploy.md)
for required production values.

## Storage and lifecycle

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_DEPLOYMENT_MODE` | `development` | `development` or `production`. Production enables fail-closed security validation. |
| `SANGAM_DATABASE_PATH` | `data/database/sangam.sqlite3` | SQLite database file path (`/data/database/sangam.sqlite3` in containers). |
| `SANGAM_WORKSPACE_ROOT` | `data/workspace` | Materialized workspace directory (`/data/workspace` in containers). |
| `SANGAM_BACKUP_ROOT` | `data/backups` | Paired backup directory (`/data/backups` in containers). |
| `SANGAM_BACKUPS_ENABLED` | `true` | Enable periodic paired backups. |
| `SANGAM_BACKUP_RETENTION_COUNT` | `14` | Backup sets kept after rotation (2 to 365). |
| `SANGAM_BACKUP_CHECK_INTERVAL_SECONDS` | `3600` | Seconds between backup checks (minimum 60). |
| `SANGAM_BACKUP_READINESS_MAX_AGE_SECONDS` | `129600` | Maximum age in seconds of the newest backup manifest for readiness when backups are enabled (3600 to 604800). |
| `SANGAM_FRONTEND_DIST` | `frontend/dist` | Built frontend directory (`/app/frontend/dist` in containers). |

## Size and worker limits

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_MAX_DOCUMENT_BYTES` | `2000000` | Maximum text document size in bytes (1,024 to 50,000,000). |
| `SANGAM_MAX_PDF_BYTES` | `100000000` | Maximum uploaded PDF size in bytes (1,024 to 1,000,000,000). |
| `SANGAM_PDF_EXTRACTION_WORKERS` | `2` | Background workers draining the durable PDF extraction queue (1 to 8). |
| `SANGAM_PDF_EXTRACTION_SHUTDOWN_TIMEOUT_SECONDS` | `5.0` | Seconds to wait for active PDF parser processes during shutdown (0.1 to 60). |
| `SANGAM_MAX_PUBLICATION_ASSET_BYTES` | `10000000` | Maximum size in bytes for a published image or asset (1,024 to 100,000,000). |
| `SANGAM_MAX_KARAKEEP_SOURCE_BYTES` | `5000000` | Maximum size in bytes fetched from Karakeep per bookmark (1,024 to 50,000,000). |

## Auth

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_AUTH_MODE` | `single_user` | `single_user`, `trusted_proxy`, or `cloudflare_access`. Production forbids `single_user`; `deploy/compose.prod.yaml` defaults to `cloudflare_access`. |
| `SANGAM_TRUSTED_IDENTITY_HEADER` | `X-Sangam-Trusted-Identity` | Request header injected by a trusted reverse proxy in `trusted_proxy` mode. |
| `SANGAM_TRUSTED_IDENTITY_VALUE` | `human:jay` | Expected value of the trusted identity header in `trusted_proxy` mode. |
| `SANGAM_TRUSTED_HUMAN_ACTOR_ID` | `human:jay` | Canonical actor ID for the workspace owner (must match `^human:[a-z0-9][a-z0-9._-]{1,63}$`). |
| `SANGAM_TRUSTED_HUMAN_DISPLAY_NAME` | `Jay` | Workspace owner's display name (1 to 120 characters). |
| `SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN` | None | HTTPS team origin required in `cloudflare_access` mode. |
| `SANGAM_CLOUDFLARE_ACCESS_AUDIENCE` | None | Cloudflare Access application AUD claim required in `cloudflare_access` mode. |
| `SANGAM_CLOUDFLARE_ACCESS_EMAIL` | None | Allowed administrator email required in `cloudflare_access` mode. |

## Publishing and trusted preview

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_PUBLICATION_BASE_URL` | `http://127.0.0.1:8000/p` | Public base URL for published pages. Must be HTTPS in production. |
| `SANGAM_TRUSTED_PREVIEW_BASE_URL` | `http://127.0.0.1:8000/trusted-preview` | Base URL for interactive HTML previews. Must be HTTPS in production. |
| `SANGAM_TRUSTED_PREVIEW_HOST` | None | Hostname pinned for preview URLs. Required in production; must match `SANGAM_TRUSTED_PREVIEW_BASE_URL` and differ from publication and parent origins. |
| `SANGAM_PREVIEW_HMAC_SECRET` | `development-only-preview-secret-change-me` | Secret signing trusted-preview tokens (minimum 32 characters). Must override the development default in production. |
| `SANGAM_PREVIEW_TOKEN_TTL_SECONDS` | `120` | Preview token lifetime in seconds (30 to 600). |
| `SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS` | `["http://127.0.0.1:5173","http://localhost:5173","http://127.0.0.1:8000"]` | JSON list of origins allowed to embed previews. Development Compose falls back to `http://127.0.0.1:8000` only. Production requires a nonempty list of HTTPS origins. |
| `SANGAM_TRUSTED_PREVIEW_CONNECT_SRC` | `[]` | JSON list of extra `connect-src` allowances (HTTPS or WSS only in production). |

## Chat and providers

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_OPENROUTER_API_KEY` | None | API key for OpenRouter or another OpenAI-compatible provider. |
| `SANGAM_OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible inference endpoint URL. |
| `SANGAM_OPENROUTER_HTTP_REFERER` | None | Public HTTPS origin sent to OpenRouter. Required by `deploy/compose.prod.yaml`. |
| `SANGAM_OPENROUTER_APP_TITLE` | `Sangam` | Application title header sent to OpenRouter. |
| `SANGAM_CHATKIT_DOMAIN_KEY` | `local-dev` | Registered ChatKit domain key for your origin. `local-dev` is for loopback. Development Compose falls back to an empty value. Production requires a registered key. |
| `SANGAM_CHAT_DEFAULT_MODEL` | `openai/gpt-5.6-luna` | Default model slug (1 to 160 characters). Must appear in `SANGAM_CHAT_AVAILABLE_MODELS`. |
| `SANGAM_CHAT_AVAILABLE_MODELS` | See list below | JSON list of selectable model slugs with no duplicates. |
| `SANGAM_CHAT_REASONING_EFFORT` | `medium` | Reasoning effort preset (`none`, `low`, `medium`, `high`, `xhigh`, `max`). Compose defaults to `low`. |
| `SANGAM_CHAT_TIMEOUT_SECONDS` | `120.0` | Per-run timeout in seconds (5 to 600). |
| `SANGAM_CHAT_MAX_TOOL_ROUNDS` | `24` | Tool-call round budget per run (1 to 48). `.env.example` and Compose default to `8`. |
| `SANGAM_CHAT_MAX_TOOL_RESULT_BYTES` | `40000` | Maximum byte size returned by a single chat tool call (1,024 to 500,000). |
| `SANGAM_CHAT_MAX_CONTEXT_MESSAGES` | `20` | Recent messages kept in active model context before compaction (2 to 100). |
| `SANGAM_CHAT_MAX_REQUEST_BYTES` | `1000000` | Maximum inbound ChatKit request body size in bytes (16,384 to 10,000,000). |
| `SANGAM_CHAT_MAX_OUTPUT_TOKENS` | `16384` | Maximum output tokens per model completion (128 to 32768). `.env.example` and Compose default to `4096`. |
| `SANGAM_CHAT_MAX_CONCURRENT_RUNS` | `4` | Maximum parallel chat runs admitted at once (1 to 32). |
| `SANGAM_CHAT_MAX_WAITING_RUNS` | `8` | Maximum queued chat requests waiting for a slot (0 to 256). Use `0` to reject excess work immediately. |
| `SANGAM_CHAT_QUEUE_WAIT_TIMEOUT_SECONDS` | `5.0` | Maximum seconds a queued chat request waits for admission (0.1 to 60). |

The application and `.env.example` seed `openai/gpt-5.6-sol`,
`openai/gpt-5.6-luna`, `openai/gpt-5.4-mini`, `openai/gpt-5.4-nano`, and
`openai/gpt-5.6-terra`. Both Compose files omit `openai/gpt-5.6-sol` from their
fallback list. Optional settings shown as None default to unset in the
application. Compose passes empty strings for optional values it does not
require.

Chat admission runs before request-body buffering. Excess or timed-out waiting
requests receive HTTP `503` with `Retry-After: 1`. Request bodies must finish
uploading within 30 seconds and stay within `SANGAM_CHAT_MAX_REQUEST_BYTES`, or
the server returns HTTP `422`. Streaming responses hold their concurrency slot
until the stream completes or the client disconnects.

## Web research

Web research is disabled by default. Setting `SANGAM_WEB_RESEARCH_ENABLED=true`
without `SANGAM_BRAVE_SEARCH_API_KEY` fails startup validation.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_WEB_RESEARCH_ENABLED` | `false` | Offer `search_web` and `read_web_source` tools in chat. |
| `SANGAM_BRAVE_SEARCH_API_KEY` | None | Brave Search API key. Required when `SANGAM_WEB_RESEARCH_ENABLED=true`. |

## Karakeep bridge

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_KARAKEEP_BASE_URL` | None | Base URL of your Karakeep instance. |
| `SANGAM_KARAKEEP_API_KEY` | None | Karakeep API key. |
| `SANGAM_KARAKEEP_TIMEOUT_SECONDS` | `20.0` | Request timeout in seconds for Karakeep API calls (1 to 120). |

## MCP

MCP is experimental, disabled by default, and requires an explicit bearer token
even in `single_user` mode. See [mcp.md](mcp.md) for the walkthrough and
contract.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_MCP_ENABLED` | `false` | Mount `/mcp` and start Monty execution workers. |
| `SANGAM_MCP_ALLOWED_HOSTS` | `["127.0.0.1:*","localhost:*","testserver"]` | JSON list of allowed request hostnames and ports. Compose and `.env.example` omit `testserver`. |
| `SANGAM_MCP_MAX_SOURCE_BYTES` | `16000` | Maximum Python source size per `execute` call in bytes (1,024 to 100,000). |
| `SANGAM_MCP_MAX_RESULT_BYTES` | `64000` | Maximum serialized output size per `execute` call in bytes (4,096 to 1,000,000). |
| `SANGAM_MCP_MAX_WORKSPACES_PER_ACTOR` | `50` | Maximum retained MCP App workspaces per actor (1 to 1000). |
| `SANGAM_MCP_MAX_EXECUTIONS_PER_ACTOR` | `10000` | Compact execution receipt quota per actor (10 to 1000000). Existing recovery records remain readable at quota. |
| `SANGAM_MCP_DRAFT_QUOTA_BYTES` | `10000000` | Total acknowledged MCP App draft bytes per actor (minimum 1,024 bytes). |
| `SANGAM_MCP_RESULT_RETENTION_DAYS` | `7` | Days detailed execution outputs and superseded skill snapshots remain readable (1 to 365). |
| `SANGAM_MCP_WORKSPACE_RETENTION_DAYS` | `30` | Days inactive clean MCP App layouts remain before cleanup (1 to 365). Dirty drafts are protected. |
