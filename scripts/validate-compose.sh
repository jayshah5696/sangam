#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
COMPOSE_IMAGE=docker:29.5.2-cli@sha256:9ba8e32bfc35a2c7ae2feb1e3241b2778ae21dee80f4dcd31d04e1cfdea86ea2

cd "$ROOT"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  docker run --rm --volume "$ROOT:/workspace:ro" --workdir /workspace \
    --env SANGAM_IMAGE \
    --env SANGAM_OPENROUTER_HTTP_REFERER \
    --env SANGAM_CHATKIT_DOMAIN_KEY \
    --env SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN \
    --env SANGAM_CLOUDFLARE_ACCESS_AUDIENCE \
    --env SANGAM_CLOUDFLARE_ACCESS_EMAIL \
    --env SANGAM_PREVIEW_HMAC_SECRET \
    --env SANGAM_PUBLICATION_BASE_URL \
    --env SANGAM_TRUSTED_PREVIEW_BASE_URL \
    --env SANGAM_TRUSTED_PREVIEW_HOST \
    --env SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS \
    "$COMPOSE_IMAGE" compose "$@"
}

compose -f compose.yaml config --quiet

SANGAM_IMAGE=ghcr.io/jayshah5696/sangam@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
SANGAM_OPENROUTER_HTTP_REFERER=https://sangam.example.com \
SANGAM_CHATKIT_DOMAIN_KEY=domain_pk_example \
SANGAM_CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://team.cloudflareaccess.com \
SANGAM_CLOUDFLARE_ACCESS_AUDIENCE=example-audience \
SANGAM_CLOUDFLARE_ACCESS_EMAIL=owner@example.com \
SANGAM_PREVIEW_HMAC_SECRET=example-only-preview-secret-000000000000000000 \
SANGAM_PUBLICATION_BASE_URL=https://docs.example.com/p \
SANGAM_TRUSTED_PREVIEW_BASE_URL=https://preview.example.com/trusted-preview \
SANGAM_TRUSTED_PREVIEW_HOST=preview.example.com \
SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS='["https://sangam.example.com"]' \
  compose -f deploy/compose.prod.yaml config --quiet

echo "Development and production Compose configuration passed."
