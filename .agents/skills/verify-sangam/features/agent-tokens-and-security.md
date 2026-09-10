# Agent Tokens & Security

Sangam supports scoped agent bearer tokens with time-to-live (TTL) limits and granular role boundaries (`read_only`, `workspace`, `admin`). This prevents unauthorized agents or external callers from executing write operations or privilege escalation.

## Sub-features

- `token-create`: Issue a scoped token via CLI `sangam agent-tokens create` or REST API `POST /api/v1/agent-tokens`.
- `token-auth-read`: Access `/api/v1/documents` and `/api/v1/search` with the issued bearer token.
- `token-scope-boundary`: Enforce that a `read_only` token attempting a mutation (`POST /api/v1/documents`) is blocked with HTTP 403 Forbidden.

## How to get to it (user POV)

- CLI: `sangam agent-tokens create --name "verifier-bot" --role "read_only" --ttl 3600`
- API: `POST /api/v1/agent-tokens` with JSON payload `{"name": "...", "role": "read_only", "ttl_seconds": 3600}`
- Web UI: Navigating to Settings -> Agent Tokens to view and revoke active tokens.

## Driving it with control-sangam

Preconditions:
- Instance is healthy via `./scripts/control-sangam.sh doctor`.

### 1. Issue a Read-Only Token
```bash
./scripts/control-sangam.sh api POST /agent-tokens '{"name":"readonly-agent","role":"read_only","ttl_seconds":3600}'
```
Expected: HTTP 200/201 returning token details and secret `token`.

### 2. Verify Authorized Read Access
```bash
curl -s -H "Authorization: Bearer <TOKEN>" "http://127.0.0.1:8765/api/v1/documents"
```
Expected: HTTP 200 OK returning the document list.

### 3. Verify Unauthorized Mutation Blocked
```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "http://127.0.0.1:8765/api/v1/documents" \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"title":"Unauthorized Note","content":"Blocked"}'
```
Expected: HTTP 403 Forbidden.

## Gotchas

- Unauthenticated localhost calls default to human owner permissions when authentication is disabled in dev mode. To enforce bearer token checks, ensure the client explicitly attaches the `Authorization: Bearer` header.
- Token secrets are returned only once upon creation; they are hashed before persistence in SQLite.
