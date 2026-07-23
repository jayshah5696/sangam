#!/usr/bin/env bash
set -Eeuo pipefail

REQUIREMENTS=$(mktemp "${TMPDIR:-/tmp}/sangam-runtime-requirements.XXXXXX")

cleanup() {
  rm -f "$REQUIREMENTS"
}
trap cleanup EXIT INT TERM

uv --quiet export --frozen --no-dev --no-emit-project \
  --output-file "$REQUIREMENTS"
uvx --from pip-audit==2.10.1 pip-audit --requirement "$REQUIREMENTS" \
  --require-hashes --disable-pip
npm --prefix frontend audit --audit-level=high

echo "Python runtime and npm dependency vulnerability policies passed."
