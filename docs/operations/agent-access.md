# Agent access

Agents interact with Sangam through the same API as humans, using scoped bearer tokens instead of shared credentials. Agent edits are attributed, revision-checked, idempotent, and reviewable.

## Discovery endpoints

Every running Sangam instance exposes public, credential-free discovery resources:

- `GET /llms.txt` — small index pointing agents to interfaces and contracts.
- `GET /skills/sangam/SKILL.md` — portable agent skill instructions for safe search, read, create, update, conflict recovery, PDF research, and publishing workflows.
- `GET /api/v1/openapi.json` — machine-readable OpenAPI 3.1 contract with schemas, bearer security, and error examples.
- `GET /api/v1/docs` — interactive browser reference for exploring routes.

These public resources explain the interface and safe workflows but grant no access. Scoped bearer tokens remain the only identity and capability boundary.

## Issuing a token

Create tokens in **Settings → Operations & AI → Agents & tokens** (or via `POST /api/v1/agent-tokens`). A token specifies:

- **Actor ID** — becomes the actor (`agent:<name>`) in the activity ledger
- **Display name & label** — human-readable description of the agent's role
- **Capabilities** — `read`, `search`, `create`, `update`, `move`, `tag`, `restore`, `delete`, `publish`, `inference`; grant the minimum required set
- **Path boundary** — optional prefix restricting mutations (e.g., `research/` or `projects/agent-x/`)
- **Expiry** — optional absolute deadline after which the token is invalid

After issuance:

1. **Copy token** — copy the secret bearer token immediately and store it in your external agent's secret store as `SANGAM_TOKEN`. Sangam displays the secret once and never stores it in recoverable plaintext.
2. **Copy agent setup** — copy separate secret-free setup instructions containing the instance URL and discovery curls:

   ```sh
   export SANGAM_API_URL='https://sangam.example.com'
   curl --fail "$SANGAM_API_URL/skills/sangam/SKILL.md"
   curl --fail "$SANGAM_API_URL/api/v1/openapi.json"
   ```

   Provide these instructions to the agent and inject `SANGAM_TOKEN` via its secret manager. Never paste secret tokens into prompts, repositories, or discovery files.

## Calling the API

The REST API lives under `/api/v1`. The `sangam` CLI wraps it:

```sh
export SANGAM_API_URL=https://sangam.example.com
export SANGAM_TOKEN=sgm_agt_...

sangam search "write-ahead logs" --limit 20
sangam read <document_id>
sangam create --path research/notes.md --title "Notes" --file notes.md
sangam update <document_id> --expected-revision <rev_id> --file notes.md --summary "Pass 2"
sangam history <document_id>
sangam diff <document_id> --from <rev_1> --to <rev_2>
sangam restore <document_id> --revision <rev_id>
sangam publish <document_id> --access-policy unlisted --slug notes
```

Every mutating call must carry:

- **Expected revision** (`expected_revision_id`) — the server rejects with `409 revision_conflict` if the document was modified since you read it. On conflict: re-read, merge intent onto the new current revision, and retry with a fresh key.
- **Idempotency key** (`Idempotency-Key` header) — ensures retries after network timeouts never double-apply operations.

Path boundaries are enforced per request: an operation outside the token's allowed path prefix returns `403 authorization_denied` even if the capability is granted.

## Chat proposals

Agents driving the workspace chat produce **proposals**, not direct writes: a suggested revision pinned to the revision it was generated from. The human reviews the diff in the UI and applies or discards it. Proposals survive restarts and remain recoverable.

## Incident response

If a token is compromised:

1. **Revoke immediately** in Settings → Agents & tokens (or via `DELETE /api/v1/agent-tokens/<token_id>`). Revocation takes effect instantly.
2. **Review ledger** in **Agent activity** to audit all accepted, denied, conflicted, and failed operations under that actor ID.
3. **Restore damaged files** from revision history using `sangam restore` or the document history inspector.
4. **Rotate related tokens** if shared secret material was potentially exposed.
