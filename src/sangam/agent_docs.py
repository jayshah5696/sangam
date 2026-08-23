# ruff: noqa: E501

from __future__ import annotations

from textwrap import dedent


def llms_txt(base_url: str) -> str:
    """Return the small, public index agents use to discover Sangam's interfaces."""
    base = base_url.rstrip("/")
    return dedent(
        f"""\
        # Sangam

        > Sangam is a self-hosted, revision-aware document workspace where humans and scoped AI agents use the same HTTP API.

        Agents authenticate with a one-time bearer token issued by the workspace owner. Tokens can limit capabilities, paths, and lifetime. Every mutation requires optimistic concurrency and an idempotency key.

        ## Agent access

        - [Sangam agent skill]({base}/skills/sangam/SKILL.md): Installable instructions for safe search, read, create, update, conflict recovery, PDF research, and publishing workflows.
        - [OpenAPI 3.1 contract]({base}/api/v1/openapi.json): Machine-readable HTTP operations, schemas, bearer authentication, and errors.
        - [Interactive API reference]({base}/api/v1/docs): Browser-based API documentation.
        - [Agent access operations guide](https://github.com/jayshah5696/sangam/blob/main/docs/operations/agent-access.md): Token issuance, path scopes, rotation, revocation, and incident response.

        ## Core workflows

        - [Architecture and trust model](https://github.com/jayshah5696/sangam/blob/main/docs/architecture.md): Authorization, revision conflicts, idempotency, and reviewable activity.
        - [Configuration reference](https://github.com/jayshah5696/sangam/blob/main/docs/configuration.md): Environment variables, storage layout, and runtime limits.
        - [Deployment guide](https://github.com/jayshah5696/sangam/blob/main/docs/operations/deploy.md): Local evaluation, Docker deployment, and Cloudflare Access.
        - [CLI reference](https://github.com/jayshah5696/sangam#development): Use the Sangam CLI with SANGAM_API_URL and SANGAM_TOKEN.

        ## Service checks

        - [Health]({base}/api/v1/health): Process health and installed version.
        - [Readiness]({base}/api/v1/readiness): Database, workspace, backup, and startup readiness.
        """
    )


def agent_skill(base_url: str) -> str:
    """Return the portable Agent Skills instructions for this Sangam instance."""
    base = base_url.rstrip("/")
    return dedent(
        f"""\
        ---
        name: sangam
        description: Search, read, create, revise, organize, research, and publish documents in a Sangam workspace through its revision-aware API or CLI. Use when a user asks to work with a Sangam document workspace, supplies a Sangam URL, or provides SANGAM_API_URL and SANGAM_TOKEN.
        license: Apache-2.0
        compatibility: Requires network access to a Sangam instance and curl or the sangam CLI. Mutations require a scoped Sangam agent token.
        metadata:
          author: Sangam
          version: "1"
        ---

        # Sangam

        Sangam is a revision-aware document workspace. Humans and agents use the same API. The workspace owner controls your capabilities, allowed path prefixes, and token lifetime.

        This skill describes the instance at `{base}`. Prefer the `SANGAM_API_URL` environment variable when it is set, because the owner may use another reachable origin.

        ## Connect

        1. Read `SANGAM_API_URL` from the environment. If it is absent, use `{base}`.
        2. Read `SANGAM_TOKEN` from the environment or the client's secret store. Never ask the user to paste it into a document or prompt if a secret-injection mechanism is available.
        3. Send the token only as `Authorization: Bearer $SANGAM_TOKEN` to the configured Sangam origin.
        4. Check `GET $SANGAM_API_URL/api/v1/health`, then make an authenticated request to `GET $SANGAM_API_URL/api/v1/documents?limit=1`.
        5. Read the current contract at `$SANGAM_API_URL/api/v1/openapi.json` when an operation is not covered here. Do not guess endpoints or fields.

        Never put a token in a URL, query string, document, generated plan, repository file, command argument, or log. A `401` means the token is missing, malformed, expired, or revoked. A `403` is an authority boundary, not a request to evade the path or capability restriction.

        ## General rules

        - Search before listing or reading the whole workspace.
        - Use stable `document_id` values for API calls. Paths are human-readable locations and can change.
        - Read a document immediately before changing it and preserve its `current_revision_id`.
        - Give each intended mutation a fresh, stable `Idempotency-Key`. Reuse that key only when retrying the exact same intended operation after a transport failure.
        - Treat `409 revision_conflict` as a request to reread, merge, and retry against the new current revision. Never fabricate or omit a revision ID.
        - Keep tool output bounded with `limit` and `offset`. Fetch raw or downloaded bytes when content belongs on disk instead of in model context.
        - Do not delete, restore, publish, expose a revision, rotate publication access, trust interactive HTML, or spend inference unless the user requested it and the token grants it.
        - Preserve ordinary Markdown or HTML files and existing document conventions. PDFs are immutable; importing a replacement creates a new document.

        ## Curl setup

        Use headers without echoing their values:

        ```sh
        : "${{SANGAM_API_URL:={base}}}"
        : "${{SANGAM_TOKEN:?SANGAM_TOKEN is required}}"
        auth_header="Authorization: Bearer $SANGAM_TOKEN"
        ```

        For every mutation, generate an idempotency key once and retain it until that exact request succeeds or returns a definitive application response:

        ```sh
        idempotency_key="$(python -c 'import uuid; print(uuid.uuid4())')"
        ```

        If Python is unavailable, use another cryptographically random UUID generator. Do not use a timestamp alone.

        ## Find and read documents

        Search titles, paths, content, tags, and categories:

        ```sh
        curl --fail-with-body --get \\
          --header "$auth_header" \\
          --data-urlencode 'q=revision safety' \\
          --data 'limit=20' \\
          "$SANGAM_API_URL/api/v1/search"
        ```

        List only when discovery without a query is needed:

        ```sh
        curl --fail-with-body --header "$auth_header" \\
          "$SANGAM_API_URL/api/v1/documents?limit=50&offset=0"
        ```

        Read current metadata and content:

        ```sh
        curl --fail-with-body --header "$auth_header" \\
          "$SANGAM_API_URL/api/v1/documents/$DOCUMENT_ID"
        ```

        For file-oriented work, save the exact stored bytes instead of putting them in context:

        ```sh
        curl --fail-with-body --header "$auth_header" \\
          --output document.bin \\
          "$SANGAM_API_URL/api/v1/documents/$DOCUMENT_ID/raw"
        ```

        ## Create a document

        A path-scoped create must include a materialized destination within the token's allowed prefix. Content types are `text/markdown` and `text/html`.

        ```sh
        idempotency_key="$(python -c 'import uuid; print(uuid.uuid4())')"
        curl --fail-with-body \\
          --request POST \\
          --header "$auth_header" \\
          --header "Idempotency-Key: $idempotency_key" \\
          --header 'Content-Type: application/json' \\
          --data '{{"title":"Research report","content":"# Research report\\n","path":"agents/research-report.md","content_type":"text/markdown"}}' \\
          "$SANGAM_API_URL/api/v1/documents"
        ```

        ## Update without overwriting another writer

        1. Read `GET /api/v1/documents/$DOCUMENT_ID`.
        2. Keep its `current_revision_id` as `expected_revision_id`.
        3. Produce the complete replacement content. `PATCH` does not accept a partial diff.
        4. Submit with a new idempotency key.

        ```sh
        idempotency_key="$(python -c 'import uuid; print(uuid.uuid4())')"
        curl --fail-with-body \\
          --request PATCH \\
          --header "$auth_header" \\
          --header "Idempotency-Key: $idempotency_key" \\
          --header 'Content-Type: application/json' \\
          --data '{{"expected_revision_id":"REVISION_ID","content":"# Complete replacement content\\n","summary":"Explain the change"}}' \\
          "$SANGAM_API_URL/api/v1/documents/$DOCUMENT_ID"
        ```

        On `409`:

        1. Record the response's `X-Operation-ID` and conflict details.
        2. Reread the document.
        3. Merge the intended change with the current content.
        4. Retry with the new `current_revision_id` and a new idempotency key.
        5. Report the conflict if a safe merge is ambiguous.

        History and diffs are available at:

        ```text
        GET /api/v1/documents/{{document_id}}/history
        GET /api/v1/documents/{{document_id}}/diff?from_revision_id=...&to_revision_id=...
        ```

        ## Move, organize, restore, and delete

        Moves require authority over both the current and destination paths:

        ```text
        POST /api/v1/documents/{{document_id}}/move
        {{"expected_revision_id":"...","path":"agents/new-path.md","summary":"..."}}
        ```

        Metadata updates require `expected_metadata_version` and replace the category and complete tag assignment:

        ```text
        PATCH /api/v1/documents/{{document_id}}/metadata
        {{"expected_metadata_version":1,"category":"research","tag_ids":["..."]}}
        ```

        Restoring creates a new current revision. Deleting moves a document to Sangam's trash. Use either only after explicit user intent:

        ```text
        POST   /api/v1/documents/{{document_id}}/restore
        DELETE /api/v1/documents/{{document_id}}
        ```

        ## PDF research

        PDFs are immutable. Use page text or page-aware search for reasoning, and use the content endpoint for bytes:

        ```text
        GET /api/v1/pdfs/{{document_id}}/pages
        GET /api/v1/pdfs/{{document_id}}/search?q=...
        GET /api/v1/pdfs/{{document_id}}/content
        GET /api/v1/pdfs/{{document_id}}/annotations
        ```

        Creating or changing an annotation requires an idempotency key. Annotation updates and deletes require `expected_version`. Consult OpenAPI for geometry and annotation schemas.

        ## Publishing

        Publishing exposes document content outside the authenticated workspace. Confirm the requested access policy before acting. Valid policies are `private`, `public`, and `unlisted`.

        ```text
        POST /api/v1/publications
        {{"document_id":"...","slug":"stable-slug","access_policy":"private"}}
        ```

        Unlisted publication tokens are disclosed once. Do not reveal them to another model or place them in Sangam content. Return them only through the user's approved secret or link handoff.

        ## CLI

        When the `sangam` command is installed, prefer it for file-oriented work. It reads the same environment variables and calls the same API:

        ```sh
        sangam search "revision safety" --limit 20
        sangam read "$DOCUMENT_ID"
        sangam create --title "Research report" --path agents/research-report.md --file report.md
        sangam update "$DOCUMENT_ID" --expected-revision "$REVISION_ID" --file report.md --summary "Research pass"
        ```

        Use `sangam --help` and command help for exact options. The API remains authoritative.

        ## Error handling

        - `401 authentication_required`: stop and ask the owner to provide, replace, or rotate the credential through their secret store.
        - `403 authorization_denied`: stop the forbidden operation. Explain the missing capability or allowed path from `error.details`.
        - `404 not_found`: refresh search or list results. The document may have moved to trash or the ID may be wrong.
        - `409 revision_conflict`: reread and merge as described above.
        - `409 idempotency_conflict`: do not reuse that key for different request content. Generate a new key only for a new intended mutation.
        - `422 validation_error`: correct the request using OpenAPI. Do not drop concurrency or safety fields.
        - `503 materialization_error`: preserve the intended operation and report that workspace reconciliation may be required.

        Every response includes `X-Operation-ID`. Include it when reporting denied, conflicted, or failed operations to the user.
        """
    )
