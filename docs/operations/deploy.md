# Deployment

## Local development

Requirements: Python 3.13+, [uv](https://docs.astral.sh/uv/), Node (see `frontend/package.json` engines), and a running Docker daemon only if you want container parity.

```sh
uv sync --all-groups
npm --prefix frontend ci
just serve
```

- API on `http://127.0.0.1:8000`
- Vite dev server on `http://127.0.0.1:5173`

Verification gates:

```sh
just check      # lint, format, typecheck
just test       # pytest + vitest
just test-e2e   # playwright (builds frontend first)
```

Copy `.env.example` to `.env` for local settings. Development defaults are loopback-only with `single_user` auth and a development preview HMAC secret.

## Docker

Build and run locally:

```sh
docker build -t sangam:dev .
docker compose up   # uses compose.yaml, bind-mounts ./data/{database,workspace,backups}
```

The image is multi-stage (Node frontend build → python:3.14-slim runtime), runs as UID 10001, listens on :8000, and ships a readiness HEALTHCHECK.

## Production

Published images are at `ghcr.io/jayshah5696/sangam:{tag}` for linux/amd64 + arm64, Sigstore-signed with SBOM and provenance attestations. Verify before deploying:

```sh
cosign verify ghcr.io/jayshah5696/sangam@sha256:<digest> \
  --certificate-identity-regexp '^https://github.com/jayshah5696/sangam/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Production runs through `deploy/compose.prod.yaml`, which fails closed unless these are set explicitly:

| Required variable | Purpose |
| --- | --- |
| `SANGAM_IMAGE` | Digest-pinned image reference (`@sha256:...`) |
| `SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN` | Access team URL |
| `SANGAM_CLOUDFLARE_ACCESS_AUDIENCE` | Access application AUD claim |
| `SANGAM_CLOUDFLARE_ACCESS_EMAIL` | Allowed administrator email |
| `SANGAM_PREVIEW_HMAC_SECRET` | Trusted-preview signing secret (32+ chars) |
| `SANGAM_OPENROUTER_HTTP_REFERER` | Public origin sent to OpenRouter |
| `SANGAM_CHATKIT_DOMAIN_KEY` | ChatKit key registered for the production origin |
| `SANGAM_PUBLICATION_BASE_URL` | HTTPS URL where publications are served |
| `SANGAM_TRUSTED_PREVIEW_BASE_URL` | HTTPS URL of the trusted-preview zone |
| `SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS` | JSON list of origins allowed to embed previews |

Deploy:

```sh
cd deploy
SANGAM_IMAGE='ghcr.io/jayshah5696/sangam@sha256:<digest>' \
SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN='https://<team>.cloudflareaccess.com' \
  ... docker compose -f compose.prod.yaml up -d
```

Confirm readiness before declaring success:

```sh
curl -fsS http://127.0.0.1:8000/health
curl -fsS http://127.0.0.1:8000/readiness
```

`readiness` additionally checks that a verified backup exists within the configured max age.

### Cloudflare tunnel

`deploy/cloudflared/config.example.yml` shows the ingress shape. Point your hostname(s) at `http://127.0.0.1:8000`, protect the app origin with a Cloudflare Access application, and register the public origin for ChatKit in the OpenAI dashboard.

## Auth modes

Set with `SANGAM_AUTH_MODE`:

- **`single_user`** — no request auth; bind to loopback only.
- **`trusted_proxy`** — a proxy injects `SANGAM_TRUSTED_IDENTITY_HEADER` (default `X-Sangam-Trusted-Identity`) with `SANGAM_TRUSTED_IDENTITY_VALUE`. Only enable when the proxy strips these headers from clients.
- **`cloudflare_access`** — validates the Access JWT against `SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN`, `SANGAM_CLOUDFLARE_ACCESS_AUDIENCE`, and requires `SANGAM_CLOUDFLARE_ACCESS_EMAIL`. This is the production compose default.

## Release checklist

Before tagging a release, complete the [release checklist](release-checklist.md): `just release-check`, Trivy scan policy, backup/upgrade proof, then push the tag and confirm the signed image and attestations on the GitHub Release.
