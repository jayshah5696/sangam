#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE=$(mktemp -d "$ROOT/.sangam-smoke.XXXXXX")
NAME="sangam-phase2-smoke-$$"
PORT=18080

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}
trap cleanup EXIT INT TERM

mkdir -p "$STATE/database" "$STATE/workspace" "$STATE/backups"
docker build -t sangam:phase2 "$ROOT"
docker run -d \
  --name "$NAME" \
  -p "127.0.0.1:$PORT:8000" \
  -v "$STATE/database:/data/database" \
  -v "$STATE/workspace:/data/workspace" \
  -v "$STATE/backups:/data/backups" \
  sangam:phase2 >/dev/null

attempt=0
until curl --fail --silent "http://127.0.0.1:$PORT/api/v1/health" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$NAME"
    exit 1
  fi
  sleep 1
done

CREATED=$(curl --fail --silent \
  -H 'Content-Type: application/json' \
  -H 'X-Actor: human:jay' \
  -H 'Idempotency-Key: docker-smoke-create' \
  --data '{"title":"Docker smoke","content":"# Through the container\n","path":"projects/docker-smoke.md"}' \
  "http://127.0.0.1:$PORT/api/v1/documents")
DOCUMENT_ID=$(printf '%s' "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["document_id"])')

CLI_CONTENT=$(docker exec \
  -e SANGAM_API_URL=http://127.0.0.1:8000 \
  "$NAME" uv run --no-sync sangam read "$DOCUMENT_ID")
test "$CLI_CONTENT" = "# Through the container"
test "$(cat "$STATE/workspace/projects/docker-smoke.md")" = "# Through the container"

SEARCHED_ID=$(curl --fail --silent \
  "http://127.0.0.1:$PORT/api/v1/search?q=container" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["document_id"])')
test "$SEARCHED_ID" = "$DOCUMENT_ID"

BACKUP_ID=$(curl --fail --silent -X POST \
  "http://127.0.0.1:$PORT/api/v1/backups" \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["verified_at"]; print(data["backup_id"])')
curl --fail --silent -X POST \
  "http://127.0.0.1:$PORT/api/v1/backups/$BACKUP_ID/verify" \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["valid"] and data["database_integrity"] == "ok"'

docker restart "$NAME" >/dev/null
attempt=0
until curl --fail --silent "http://127.0.0.1:$PORT/api/v1/documents/$DOCUMENT_ID" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$NAME"
    exit 1
  fi
  sleep 1
done

docker stop "$NAME" >/dev/null
printf '%s\n' '# Changed outside Sangam' > "$STATE/workspace/projects/docker-smoke.md"
docker start "$NAME" >/dev/null
attempt=0
until curl --fail --silent "http://127.0.0.1:$PORT/api/v1/health" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$NAME"
    exit 1
  fi
  sleep 1
done
CONFLICT_TYPE=$(curl --fail --silent "http://127.0.0.1:$PORT/api/v1/reconciliation" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["conflicts"][0]["conflict_type"])')
test "$CONFLICT_TYPE" = "unexpected_hash"

echo "Docker smoke passed: API, CLI, search, verified backup, host file, restart, and reconciliation."
