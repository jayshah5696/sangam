# Configuration

All settings are environment variables prefixed with `SANGAM_`. Defaults suit
local development on loopback; `deploy/compose.prod.yaml` refuses to start in
production until the required subset below is explicit. `.env.example` mirrors
every variable.

## Storage and lifecycle

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_DEPLOYMENT_MODE` | `development` | `development` or `production`; production enables fail-closed validation |
| `SANGAM_DATABASE_PATH` | dev path | SQLite database file |
| `SANGAM_WORKSPACE_ROOT` | dev path | Materialized workspace directory |
| `SANGAM_BACKUP_ROOT` | dev path | Paired backup artifacts |
| `SANGAM_BACKUPS_ENABLED` | `true` | Periodic paired backups |
| `SANGAM_BACKUP_RETENTION_COUNT` | `14` | Backups kept before rotation |
| `SANGAM_BACKUP_CHECK_INTERVAL_SECONDS` | `3600` | Backup cycle interval |
| `SANGAM_BACKUP_READINESS_MAX_AGE_SECONDS` | `129600` | Max age of a verified backup for readiness |
| `SANGAM_FRONTEND_DIST` | auto | Built SPA directory (set in containers) |

## Limits

| Variable | Default |
| --- | --- |
| `SANGAM_MAX_DOCUMENT_BYTES` | `2000000` |
| `SANGAM_MAX_PDF_BYTES` | `100000000` |
| `SANGAM_PDF_EXTRACTION_SHUTDOWN_TIMEOUT_SECONDS` | `5.0` |
| `SANGAM_MAX_PUBLICATION_ASSET_BYTES` | `10000000` |
| `SANGAM_MAX_KARAKEEP_SOURCE_BYTES` | `5000000` |

## Auth

| Variable | Purpose |
| --- | --- |
| `SANGAM_AUTH_MODE` | `single_user`, `trusted_proxy`, or `cloudflare_access` |
| `SANGAM_TRUSTED_IDENTITY_HEADER` / `_VALUE` | Header injected by a trusted proxy |
| `SANGAM_TRUSTED_HUMAN_ACTOR_ID` / `_DISPLAY_NAME` | Human actor identity |
| `SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Required for `cloudflare_access` |
| `SANGAM_CLOUDFLARE_ACCESS_AUDIENCE` | Required for `cloudflare_access` |
| `SANGAM_CLOUDFLARE_ACCESS_EMAIL` | Allowed administrator email |

## Publishing and trusted preview

| Variable | Purpose |
| --- | --- |
| `SANGAM_PUBLICATION_BASE_URL` | Public URL where published pages are served (required in production) |
| `SANGAM_PREVIEW_HMAC_SECRET` | Trusted-preview signing secret; development default exists, override in production |
| `SANGAM_PREVIEW_TOKEN_TTL_SECONDS` | Preview token lifetime (30-600) |
| `SANGAM_TRUSTED_PREVIEW_BASE_URL` | Where trusted previews are served (required in production) |
| `SANGAM_TRUSTED_PREVIEW_HOST` | Hostname pinning for preview URLs |
| `SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS` | JSON list of origins allowed to embed previews (required in production) |
| `SANGAM_TRUSTED_PREVIEW_CONNECT_SRC` | JSON list of extra `connect-src` allowances |

## Chat and providers

| Variable | Purpose |
| --- | --- |
| `SANGAM_OPENROUTER_API_KEY` | Provider API key |
| `SANGAM_OPENROUTER_BASE_URL` | Any OpenAI-compatible endpoint (default OpenRouter) |
| `SANGAM_OPENROUTER_HTTP_REFERER` | Public origin sent to OpenRouter (required in production) |
| `SANGAM_OPENROUTER_APP_TITLE` | App title sent to OpenRouter (default "Sangam") |
| `SANGAM_CHATKIT_DOMAIN_KEY` | ChatKit key for your origin; `local-dev` only works on localhost |
| `SANGAM_CHAT_DEFAULT_MODEL` | Must appear in available models; defaults to `openai/gpt-5.6-sol` |
| `SANGAM_CHAT_AVAILABLE_MODELS` | JSON list of model slugs |
| `SANGAM_CHAT_REASONING_EFFORT` | Reasoning preset; defaults to `medium` |
| `SANGAM_CHAT_TIMEOUT_SECONDS` | Per-run timeout |
| `SANGAM_CHAT_MAX_TOOL_ROUNDS` | Tool-use budget (default 24) |
| `SANGAM_CHAT_MAX_TOOL_RESULT_BYTES` | Tool result byte cap |
| `SANGAM_CHAT_MAX_CONTEXT_MESSAGES` | Context window size in messages |
| `SANGAM_CHAT_MAX_REQUEST_BYTES` | Inbound chat request cap |
| `SANGAM_CHAT_MAX_OUTPUT_TOKENS` | Completion cap (default 16384) |
| `SANGAM_CHAT_MAX_CONCURRENT_RUNS` | Parallel chat runs |

## Karakeep bridge

| Variable | Purpose |
| --- | --- |
| `SANGAM_KARAKEEP_BASE_URL` | Karakeep instance URL |
| `SANGAM_KARAKEEP_API_KEY` | Karakeep API key |
| `SANGAM_KARAKEEP_TIMEOUT_SECONDS` | Request timeout |
