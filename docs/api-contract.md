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
