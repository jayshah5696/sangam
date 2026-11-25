# API contract compatibility

## OpenAPI compatibility checks

`just verify-openapi` generates Sangam's OpenAPI 3.1 schema and compares its
operations and models against
[`docs/api/openapi-baseline.json`](api/openapi-baseline.json). It prints every
changed operation and field and classifies common compatibility changes. Every
OpenAPI diff requires an intentional baseline update, including compatible
additions and constraints the classifier does not inspect. Always review the
full JSON diff before accepting a baseline change.

Keep existing `operationId` values stable. Frontend Zod schemas in
`frontend/src/api.ts` validate data at the network boundary and remain the
source of truth for what the browser client accepts. When a response shape
changes, update those Zod schemas in the same change. Static OpenAPI comparison
cannot prove that runtime handlers match every declared schema.

### Classification policy

| Change | Classification |
| --- | --- |
| Remove an operation, parameter, request property, response, or response property | Breaking |
| Add a required request parameter, body, or property | Breaking |
| Change a schema type or `operationId` | Breaking |
| Remove a request enum value | Breaking |
| Add a response enum value | Breaking, because exhaustive clients may reject unknown values |
| Add an optional request field or response field | Compatible |
| Add a request enum value or remove a response enum value | Compatible |
| Change a constraint the checker does not model | Review required |

### Update the reviewed baseline

1. Inspect the output of `just verify-openapi` and confirm the contract change
   is intentional.
2. Update frontend Zod schemas and contract tests for the changed behavior.
3. Record the reviewed baseline with a PR or issue reference:

   ```sh
   just update-openapi-baseline "#123: describe the reviewed API change"
   ```

This regenerates `docs/api/openapi-baseline.json` and
`frontend/src/generated/openapi.sha256`. The JSON baseline records the
acceptance date and reason.
Commit both files in the same PR, then run `just verify-openapi` to confirm a
clean match. Never update the baseline to silence an unexplained failure.

## Runtime resource limits

### Chat admission (`POST /api/v1/chatkit`)

| Guard | Rule | Failure response |
| --- | --- | --- |
| Concurrency | At most `SANGAM_CHAT_MAX_CONCURRENT_RUNS` active runs | Queued up to waiting limit |
| Waiting queue | At most `SANGAM_CHAT_MAX_WAITING_RUNS` waiting requests | HTTP `503` with `Retry-After: 1` |
| Queue wait timeout | At most `SANGAM_CHAT_QUEUE_WAIT_TIMEOUT_SECONDS` | HTTP `503` with `Retry-After: 1` |
| Body size | Declared and streamed bytes capped at `SANGAM_CHAT_MAX_REQUEST_BYTES` | HTTP `422`. The server stops reading an oversized body. |
| Body upload deadline | Request body must finish arriving within 30 seconds | HTTP `422` |

Admission checks run before body buffering and context preparation. Rejected
requests do not start model inference or create a persisted run. Cancellation
holds capacity until synchronous storage work completes. Standard mutation
idempotency rules still apply.

### PDF upload and extraction (`POST /api/v1/pdfs`)

| Guard | Rule | Failure response |
| --- | --- | --- |
| Upload concurrency | At most 2 simultaneous PDF uploads | HTTP `503` |
| Upload size | Capped at `SANGAM_MAX_PDF_BYTES` | HTTP `422` |
| Upload deadline | Upload must finish within 60 seconds | HTTP `422` |
| Per-PDF parser bounds | Disposable subprocess limited to 1,000 pages, 10 MB UTF-8 text, and 30 seconds | Durable `failed` extraction status without partial page writes |

Uploads stream to temporary disk files that close on every exit path. Imports,
retries, and recovery share one durable SQLite queue drained by
`SANGAM_PDF_EXTRACTION_WORKERS`. During shutdown, active parser processes are
terminated and claimed jobs return to `pending` for restart recovery. Immutable PDF bytes remain readable even if text
extraction fails.

## Revision history pagination

`GET /api/v1/documents/{document_id}/revisions` returns `{items, next_cursor}`
with revision metadata only (no full document bodies).

- **Page size:** Default `20`, maximum `100`.
- **Ordering:** Creation time descending, then revision ID descending.
- **Cursor stability:** Pass `next_cursor` as `cursor` to read older pages.
  Cursors are scoped to one document and keep older page boundaries stable when
  new revisions arrive.
- **Full content:** Fetch a single revision's content from
  `GET /api/v1/documents/{document_id}/revisions/{revision_id}`.

Both routes enforce standard history authorization, including permitted access
to deleted documents. Diff and restore routes keep their existing contracts.

The full-content `/api/v1/documents/{document_id}/history` route is deprecated
and preserved for backward compatibility. Browser and agent workflows use the
paginated summary and exact-revision endpoints instead. In the CLI,
`sangam history` prints one summary page (with `--limit` and `--cursor`), and
`sangam revision DOCUMENT_ID REVISION_ID` fetches one revision body. Existing
scripts can use `sangam history DOCUMENT_ID --legacy` for the old output.
