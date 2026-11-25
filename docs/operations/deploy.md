# Deployment

## Local development

Use Python 3.13 or newer, [uv](https://docs.astral.sh/uv/), and `just`.
Use Node 26 to match CI and the `pnpm` version pinned in
`frontend/package.json`. Container checks also need Docker.

```sh
just setup
just serve
```

- API server: `http://127.0.0.1:8000`
- Vite dev server: `http://127.0.0.1:5173`

Run the standard verification gates before opening a pull request:

```sh
just test       # Python lint, format, mypy, OpenAPI, pytest + frontend build, lint, vitest
just test-docs  # Markdown links, repo paths, just recipes, Mermaid, markdownlint
just test-e2e   # Playwright browser suite (builds frontend first)
just check      # full local gate: test, test-docs, compose, distribution, package smoke
```

Set only the values you need to override in `.env`. The example file uses
container paths under `/data` and `/app`. For native development, leave those
paths unset to use the application defaults. `just serve` binds to loopback.

## Docker

Build and run locally with Compose:

```sh
docker compose up --build
```

The image uses a multi-stage build (`node:26-alpine` frontend build into a
`python:3.14-slim` runtime), runs as unprivileged user `10001:10001`, listens on
port `8000`, and includes a readiness `HEALTHCHECK` against
`http://127.0.0.1:8000/api/v1/readiness`.
Make the mounted `data/database`, `data/workspace`, and `data/backups`
directories writable by the container user.

## Production

Run one Sangam process for each database, workspace, and backup set. Multiple
Uvicorn workers or multiple replicas sharing any of those storage roots are
unsupported. Sangam acquires exclusive OS locks on the database, workspace, and
backup paths before startup. A second process pointing at an overlapping storage
root exits with an ownership error. Locks release on clean shutdown and when the
process exits, so stale lock files do not need manual removal.

Published images are hosted at `ghcr.io/jayshah5696/sangam:{tag}` for
`linux/amd64` and `linux/arm64`. Images are signed with Sigstore and carry SBOM
and provenance attestations. Replace `DIGEST` with the selected image digest's hexadecimal value, then
verify the signature.

```sh
cosign verify 'ghcr.io/jayshah5696/sangam@sha256:DIGEST' \
  --certificate-identity-regexp '^https://github.com/jayshah5696/sangam/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Production deployments use `deploy/compose.prod.yaml`, which sets
`SANGAM_DEPLOYMENT_MODE=production` and fails closed unless all required
variables are set explicitly:

| Required variable | Purpose |
| --- | --- |
| `SANGAM_IMAGE` | Digest-pinned image reference (`@sha256:...`) |
| `SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Cloudflare Access HTTPS team origin |
| `SANGAM_CLOUDFLARE_ACCESS_AUDIENCE` | Cloudflare Access application AUD claim |
| `SANGAM_CLOUDFLARE_ACCESS_EMAIL` | Allowed administrator email |
| `SANGAM_PREVIEW_HMAC_SECRET` | Independent trusted-preview signing secret (32+ chars) |
| `SANGAM_OPENROUTER_HTTP_REFERER` | Public HTTPS origin sent to OpenRouter |
| `SANGAM_CHATKIT_DOMAIN_KEY` | ChatKit domain key registered for the production origin |
| `SANGAM_PUBLICATION_BASE_URL` | HTTPS base URL where published pages are served |
| `SANGAM_TRUSTED_PREVIEW_BASE_URL` | HTTPS base URL of the isolated trusted-preview zone |
| `SANGAM_TRUSTED_PREVIEW_HOST` | Hostname matching `SANGAM_TRUSTED_PREVIEW_BASE_URL`, isolated from publication and parent origins |
| `SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS` | JSON list of HTTPS origins allowed to embed previews |

Save the required values in `deploy/.env`.
Compose checks that `SANGAM_IMAGE` has a value. Verify the signature and use
the verified digest as that value before starting the stack.

```sh
docker compose --env-file deploy/.env -f deploy/compose.prod.yaml up -d
```

Confirm both liveness and readiness before finishing deployment:

```sh
curl -fsS http://127.0.0.1:8000/api/v1/health
curl -fsS http://127.0.0.1:8000/api/v1/readiness
```

`/api/v1/readiness` checks the database and audit worker, applied migrations,
writable storage, startup reconciliation, and pending materializations. When
backups are enabled, it also checks the age of the newest backup manifest.
Confirm chat separately in the browser if the deployment uses inference.

### Cloudflare Tunnel

`deploy/cloudflared/config.example.yml` shows the ingress layout. Point your
application, publication, and isolated trusted-preview hostnames at
`http://127.0.0.1:8000`, protect the application origin with a Cloudflare Access
policy, and register the public origin for ChatKit in the OpenAI dashboard.

## Auth modes

Select an authentication mode with `SANGAM_AUTH_MODE`:

- `single_user`: No request authentication. Loopback only; rejected in
  production mode.
- `trusted_proxy`: A reverse proxy injects `SANGAM_TRUSTED_IDENTITY_HEADER`
  (default `X-Sangam-Trusted-Identity`) set to `SANGAM_TRUSTED_IDENTITY_VALUE`.
  Enable this mode only when the proxy strips that header from untrusted
  clients.
- `cloudflare_access`: Validates the Cloudflare Access JWT against
  `SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `SANGAM_CLOUDFLARE_ACCESS_AUDIENCE`,
  and `SANGAM_CLOUDFLARE_ACCESS_EMAIL`. This is the default in
  `deploy/compose.prod.yaml`, which requires all three Cloudflare values even
  when `SANGAM_AUTH_MODE` is set to `trusted_proxy`. Application validation
  outside that Compose file requires those values only in Cloudflare mode.

## Release checklist

Before tagging a release, complete the [release checklist](release-checklist.md):
run `just release-check`, review container scan findings, prove backup and
upgrade recovery, push the tag, and confirm the signed image and attestations on
the GitHub Release.
