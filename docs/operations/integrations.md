# Integrations

## Karakeep bridge

Imports archived Karakeep bookmarks as editable Markdown while preserving provenance (original URL, capture time).

Configuration:

| Variable | Purpose |
| --- | --- |
| `SANGAM_KARAKEEP_BASE_URL` | Karakeep instance URL |
| `SANGAM_KARAKEEP_API_KEY` | Karakeep API key |
| `SANGAM_KARAKEEP_TIMEOUT_SECONDS` | Request timeout (default 20) |
| `SANGAM_MAX_KARAKEEP_SOURCE_BYTES` | Max source payload size |

Workflow:

1. **Karakeep imports** in the sidebar lists archived bookmarks available to import.
2. Import selectively; content lands under your chosen path with provenance metadata attached.
3. **Refresh** re-fetches the bookmark. If you edited the imported document, the refresh surfaces a diff for review instead of overwriting.
4. Failed imports are retryable; retries are idempotent, so re-running never duplicates documents.

Rotate the Karakeep API key like any other credential: update the env var, restart, trigger one import to confirm. After a restore-from-backup, verify imports still list correctly and provenance survived.

## Chat runtime

Sangam pairs the ChatKit browser UI with the OpenAI Agents SDK on the backend. Connections are provider-neutral: use the OpenRouter preset or point at any OpenAI-compatible endpoint.

Configuration:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SANGAM_OPENROUTER_API_KEY` | None | Provider API key |
| `SANGAM_OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenAI-compatible base URL |
| `SANGAM_CHATKIT_DOMAIN_KEY` | `local-dev` | Domain key registered for your origin |
| `SANGAM_CHAT_DEFAULT_MODEL` | `openai/gpt-4.1` | Default model slug |
| `SANGAM_CHAT_AVAILABLE_MODELS` | Seed list | JSON list of selectable model slugs |
| `SANGAM_CHAT_REASONING_EFFORT` | `medium` | Reasoning effort preset |
| `SANGAM_CHAT_TIMEOUT_SECONDS` | `90` | Per-run timeout |
| `SANGAM_CHAT_MAX_TOOL_ROUNDS` | `10` | Tool-use round budget |
| `SANGAM_CHAT_MAX_CONCURRENT_RUNS` | `2` | Concurrent chat runs |

Manage models directly from **Settings → Operations & AI → AI & models** (custom slugs and connections supported) or via environment variables.

### ChatKit domain registration

`local-dev` works only when opening Sangam on `localhost` or loopback `127.0.0.1`. Every non-loopback hostname requires a registered ChatKit domain key, including private Tailscale `*.ts.net` hostnames.

Registration steps:

1. Determine your stable HTTPS hostname. For Tailscale Serve, run `tailscale serve status` and use the exact `*.ts.net` name reported.
2. Open OpenAI's [Domain Allowlist](https://platform.openai.com/settings/organization/security/domain-allowlist).
3. Add only the hostname, such as `sangam.example.ts.net`. Do not include `https://`, a port, or a trailing path.
4. Copy the generated domain key into your deployment environment:

   ```dotenv
   SANGAM_CHATKIT_DOMAIN_KEY=domain_pk_...
   ```

5. Recreate the container to apply the new environment:

   ```sh
   docker compose up -d --force-recreate sangam
   ```

6. Open Sangam through the registered HTTPS hostname and select **Check again**. Allowlist changes take a few minutes to propagate.

### Account and architecture boundaries

- **Billing & accounts**: OpenAI charges no separate fee for ChatKit domain registration or the browser UI component. Model inference is billed by your configured provider (such as OpenRouter). An OpenAI Platform account is needed to manage the allowlist, but Sangam does not require an OpenAI API key or OpenAI model credits when using OpenRouter.
- **Key security**: The domain key is public browser configuration, not an authentication secret or API key. It proves to ChatKit's CDN that the origin hostname is allowlisted.
- **Architecture**: Sangam is self-hosted at the application layer (threads, history, tools, authentication, and inference). The browser UI loads ChatKit's bootstrap from `https://cdn.platform.openai.com/deployments/chatkit/chatkit.js` and renders an OpenAI-hosted iframe that validates the domain key against `https://api.openai.com`.

### Production operational notes

- **Reverse proxies & Cloudflare**: Disable buffering or optimization features like Rocket Loader for the application origin. Ensure no caching rule intercepts `/api/v1/chat`.
- **Key rotation**: Update environment variables and restart. In-flight runs complete on the existing connection while new turns use the updated key.
