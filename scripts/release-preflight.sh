#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=${1:-}

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "usage: scripts/release-preflight.sh <semver>" >&2
  exit 2
fi

cd "$ROOT"
if [ "$(git branch --show-current)" != "main" ]; then
  echo "error: releases must be prepared from main" >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: release preflight requires a clean worktree" >&2
  exit 1
fi
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "error: tag v$VERSION already exists" >&2
  exit 1
fi

uv run python scripts/verify-version.py --expected "$VERSION"
just check
just docker-smoke
./scripts/validate-compose.sh

echo "Automated release preflight passed for v$VERSION. Complete docs/operations/RELEASE_CHECKLIST.md before tagging."
