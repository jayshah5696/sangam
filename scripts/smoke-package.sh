#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE=$(mktemp -d "${TMPDIR:-/tmp}/sangam-package-smoke.XXXXXX")

cleanup() {
  rm -rf "$STATE"
}
trap cleanup EXIT INT TERM

uv build --out-dir "$STATE/dist" "$ROOT"

for artifact in "$STATE"/dist/sangam-*.whl "$STATE"/dist/sangam-*.tar.gz; do
  kind=$(basename "$artifact")
  environment="$STATE/venv-${kind//[^A-Za-z0-9]/-}"
  uv venv --python "${UV_PYTHON:-3.13}" "$environment"
  uv pip install --python "$environment/bin/python" "$artifact"
  "$environment/bin/sangam" --help >/dev/null
  "$environment/bin/python" "$ROOT/scripts/smoke-installed-package.py"
done

echo "Wheel and sdist clean-install smoke passed."
