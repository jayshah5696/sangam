---
name: sangam-agent-guide
description: Operate a deployed Sangam document server as an AI agent - discover the base URL, work within scoped token rules, create and update documents through the revision-aware API without corrupting history, run full-text searches, and stay out of the human's way.
compatibility: Any Sangam 0.8.x+ instance reachable over HTTP; a scoped bearer token issued by the administrator.
---

# Working with a deployed Sangam instance

Sangam is a single-user, self-hosted document workspace. You are a guest in it.
The human owns every file; your job is to read precisely, edit carefully, and
leave a reviewable trail. When in doubt, read instead of write, and ask before
you publish or delete.

## 1. Connect and discover

- Every instance provides public discovery resources:
  - `/llms.txt` — small index describing Sangam interfaces and documentation.
  - `/skills/sangam/SKILL.md` — hosted instance skill and safety instructions.
  - `/api/v1/openapi.json` — machine-readable HTTP operations and schemas.
- Authenticate with your bearer token: `Authorization: Bearer <token>`.
- Tokens are scoped. Yours has explicit capabilities (`read`, `search`,
  `create`, `update`, `move`, `tag`, `restore`, `delete`, `publish`,
  `inference`), optionally restricted by path prefix (for example `research/`
  only). Never ask for broader access than the task needs, and never attempt
  operations outside your scope. Denials are recorded in the human's activity
  ledger.

## 2. Read and search first

```sh
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/documents?limit=50"
curl -H "Authorization: Bearer $TOKEN" "$BASE/api/v1/documents/<id>"
```

The listing returns `current_revision_id`, `path`, tags, and materialization
state per document. Search endpoints are in the OpenAPI contract. Always read
before writing so you know what you are changing.

## 3. Mutate safely

Every mutation requires an `Idempotency-Key` header. Use one unique key per
logical operation and reuse that same key when retrying after a network error,
so the operation is never applied twice.

Create a document:

```sh
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: <unique-key>" \
  -d '{"title": "Notes", "path": "research/notes.md",
       "content": "# Notes", "content_type": "text/markdown"}' \
  "$BASE/api/v1/documents"
```

Update a document:

```sh
curl -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H "Idempotency-Key: <unique-key>" \
  -d '{"expected_revision_id": "<current_revision_id>",
       "content": "# Notes\n\nUpdated body."}' \
  "$BASE/api/v1/documents/<id>"
```

Rules that keep history trustworthy:

1. Optimistic concurrency. Send the `current_revision_id` you actually
   observed as `expected_revision_id`. A `409` means someone changed it since
   you read it: re-read, re-apply your intent on the new revision, retry with a
   fresh idempotency key. Never blindly overwrite.
2. Paths are stable identity. Prefer updating an existing document over
   creating near-duplicate paths like `notes-final.md`.
3. Respect trust zones. HTML content is sanitized on render; interactive
   JavaScript only executes in the trusted-preview zone under policies the
   human controls (`/api/v1/settings/html-javascript`). Do not try to smuggle
   scripts past sanitization.

## 4. Know what stays human-only

- Publishing changes who can see a page. Only do it when explicitly asked,
  with an explicit slug.
- Chat-grounded edits flow through proposals that the human reviews before
  they apply. If you are driving chat rather than raw API calls, produce clean
  proposals and let review happen.
- Deletion and restore are destructive-adjacent. Confirm scope before any
  delete; prefer restoring from revision history when fixing mistakes.

## 5. Leave a good trail

Every action lands in the activity ledger under your actor id (`agent:<name>`).
Aim for a ledger the human can scan in ten seconds: few operations, each
self-explanatory, no repeated denials, no speculative writes. When a task ends,
summarize which documents you touched and why.
