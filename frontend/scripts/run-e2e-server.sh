#!/usr/bin/env bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "$0")/../.." && pwd)"
run_root="$(mktemp -d "${TMPDIR:-/tmp}/sangam-e2e.XXXXXX")"

cleanup() {
  rm -rf "$run_root"
}
trap cleanup EXIT INT TERM

export SANGAM_DATABASE_PATH="$run_root/database/sangam.sqlite3"
export SANGAM_WORKSPACE_ROOT="$run_root/workspace"
export SANGAM_BACKUP_ROOT="$run_root/backups"
export SANGAM_BACKUPS_ENABLED=false
export SANGAM_FRONTEND_DIST="$repository_root/frontend/dist"
export SANGAM_TRUSTED_PREVIEW_BASE_URL="http://preview.localhost:8765/trusted-preview"
export SANGAM_TRUSTED_PREVIEW_HOST="preview.localhost"
export SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS='["http://127.0.0.1:8765"]'

cd "$repository_root"
uv run uvicorn sangam.main:app --host 127.0.0.1 --port 8765 --no-access-log
