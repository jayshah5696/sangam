# API contract compatibility

`just verify-openapi` generates Sangam's OpenAPI document and compares its operations and schemas with [`docs/api/openapi-baseline.json`](api/openapi-baseline.json). The check prints changed operations and fields. It classifies common compatibility changes, but does not implement every OpenAPI rule. The existing fingerprint gate remains: every document change requires an intentional baseline update, including compatible additions and changes the classifier does not detect. Review the full JSON diff before accepting an update.

Keep existing `operationId` values stable. The frontend's Zod schemas in `frontend/src/api.ts` validate data at the network boundary and remain the source of truth for what the UI accepts. When a response changes, check those schemas and update them when needed. OpenAPI comparison cannot prove that runtime behavior matches the declared schema.

The checker uses this policy:

| Change | Classification |
| --- | --- |
| Remove an operation, parameter, request property, response, or response property | Breaking |
| Add a required request parameter, body, or property | Breaking |
| Change a schema type or operation ID | Breaking |
| Remove a request enum value | Breaking |
| Add a response enum value | Breaking, because clients may reject values they do not know |
| Add an optional request field or response field | Compatible |
| Add a request enum value or remove a response enum value | Compatible |
| Change a constraint the checker does not understand | Review required |

A compatibility check is a contract-level signal. It does not prove that a handler accepts every declared input or that it returns every declared output. New enum values in responses can break exhaustive clients even though the response type remains a string.

## Updating the reviewed baseline

First review the readable output from `just verify-openapi` and decide whether the contract change is intentional. Update frontend boundary validation and focused contract fixtures for any intended behavior changes. Then record the reason in the baseline with a PR or issue reference:

```sh
just update-openapi-baseline "#123: describe the reviewed API change"
```

This command regenerates `docs/api/openapi-baseline.json` and `frontend/src/generated/openapi.sha256`. The baseline records the acceptance date and reason. Include both generated changes in the same reviewed PR as the API change. Run `just verify-openapi` afterward; it should report a match. Do not update the baseline to silence an unexplained failure.

## Resource limits and revision history

`POST /api/v1/chatkit` checks declared and streamed bytes against `SANGAM_CHAT_MAX_REQUEST_BYTES`.
Invalid or oversized bodies return 422, and an oversized stream stops being consumed immediately.
Bodies must arrive within 30 seconds. Admission precedes body buffering and context preparation.
The server admits at most `SANGAM_CHAT_MAX_CONCURRENT_RUNS` requests and queues at most
`SANGAM_CHAT_MAX_WAITING_RUNS` requests. Waiting expires after
`SANGAM_CHAT_QUEUE_WAIT_TIMEOUT_SECONDS`. Queue overflow and waiting expiry return 503 with
`Retry-After: 1`. Retry after that delay. Rejected requests do not start inference or a persisted run.
Cancellation retains capacity until synchronous storage work finishes. Existing mutation
idempotency rules still apply.

PDF uploads stream to temporary disk files, allow two concurrent uploads, and must arrive within
60 seconds. Excess uploads return 503; oversized input returns 422. Temporary files close on every
exit path. Imports, retries, and recovered jobs share a SQLite queue drained by
`SANGAM_PDF_EXTRACTION_WORKERS`. Extraction runs in disposable processes with limits of 1,000
pages, 10 MB of extracted UTF-8 text, and 30 seconds of parser execution. Limits produce a durable
failed status without partial page writes. Shutdown terminates parsers and returns claimed work
to pending for restart. The imported immutable bytes remain available after extraction failure.

`GET /documents/{document_id}/revisions` returns `{items, next_cursor}` with metadata only.
The default page size is 20 and the maximum is 100. Pass `next_cursor` as `cursor` to continue.
Pages order by creation time and revision ID descending. Cursors belong to one document and
hold the older-page boundary stable when new revisions arrive. Exact content comes from
`GET /documents/{document_id}/revisions/{revision_id}`. Both routes use existing history
authorization, including permitted deleted-document access. Diff and restore retain their contracts.

The full-content `/history` route is deprecated but retains its response shape for older callers.
The browser and agent paths now fetch summaries or exact content. `sangam history` prints one
summary page; use `--limit`, `--cursor`, and `sangam revision DOCUMENT_ID REVISION_ID`.
Scripts needing the old CLI list can use `sangam history --legacy` during migration.
