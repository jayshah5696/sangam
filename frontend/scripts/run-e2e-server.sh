#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
run_root="$(mktemp -d "${TMPDIR:-/tmp}/sangam-e2e.XXXXXX")"
port="${SANGAM_E2E_PORT:-8765}"

cleanup() {
  rm -rf "$run_root"
}
trap cleanup EXIT INT TERM

export SANGAM_DATABASE_PATH="$run_root/database/sangam.sqlite3"
export SANGAM_WORKSPACE_ROOT="$run_root/workspace"
export SANGAM_BACKUP_ROOT="$run_root/backups"
export SANGAM_BACKUPS_ENABLED=false
export SANGAM_FRONTEND_DIST="$repository_root/frontend/dist"
export SANGAM_TRUSTED_PREVIEW_BASE_URL="http://preview.localhost:$port/trusted-preview"
export SANGAM_TRUSTED_PREVIEW_HOST="preview.localhost"
export SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS="[\"http://127.0.0.1:$port\"]"

cd "$repository_root"
export SANGAM_CHATKIT_DOMAIN_KEY="editorial-e2e"
# Browser fixtures prove persistence and UI behavior without remote inference.
export SANGAM_OPENROUTER_API_KEY=""
export OPENROUTER_API_KEY=""
uv run uvicorn scripts.e2e_editorial:app --host 127.0.0.1 --port "$port" --no-access-log
