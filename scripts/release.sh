#!/usr/bin/env bash
# Cut a new Sangam release: bump pyproject.toml, regenerate CHANGELOG.md, tag, push.
#
# Usage:
#   scripts/release.sh <new-version>         # e.g. 0.2.0
#   scripts/release.sh <new-version> --dry-run
#
# Requires: git, uv, git-cliff (installed on demand via `uvx git-cliff` if missing).

set -Eeuo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

VERSION=${1:-}
DRY_RUN=false
if [ "${2:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

if [ -z "$VERSION" ]; then
  echo "usage: scripts/release.sh <new-version> [--dry-run]" >&2
  exit 2
fi

if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "error: version must be SemVer (e.g. 0.2.0 or 1.0.0-rc.1); got '$VERSION'" >&2
  exit 2
fi

TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists" >&2
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "warning: releasing from branch '$CURRENT_BRANCH', not 'main'." >&2
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is dirty; commit or stash before releasing" >&2
  exit 1
fi

echo "==> bumping pyproject.toml to $VERSION"
python3 - "$VERSION" <<'PY'
import re, sys
from pathlib import Path

version = sys.argv[1]
path = Path("pyproject.toml")
text = path.read_text()
new_text, count = re.subn(
    r'^version = "[^"]+"',
    f'version = "{version}"',
    text,
    count=1,
    flags=re.MULTILINE,
)
if count != 1:
    raise SystemExit("error: could not locate a single version line in pyproject.toml")
path.write_text(new_text)
PY

echo "==> refreshing uv.lock"
uv lock

echo "==> regenerating CHANGELOG.md via git-cliff"
if command -v git-cliff >/dev/null 2>&1; then
  CLIFF=(git-cliff)
else
  CLIFF=(uvx --from git-cliff@2.4.0 git-cliff)
fi
"${CLIFF[@]}" --tag "$TAG" --output CHANGELOG.md

if $DRY_RUN; then
  echo "==> dry run: showing diff and stopping"
  git --no-pager diff
  exit 0
fi

echo "==> committing release"
git add pyproject.toml uv.lock CHANGELOG.md
git commit -m "chore(release): $TAG"

echo "==> tagging $TAG"
git tag -a "$TAG" -m "Release $TAG"

echo "==> pushing branch and tag"
git push origin "$CURRENT_BRANCH"
git push origin "$TAG"

echo "==> done. GitHub Actions will build and publish ghcr.io/${GITHUB_REPOSITORY:-jayshah5696/sangam}:$VERSION"
