#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE=$(mktemp -d "$ROOT/.sangam-smoke.XXXXXX")
NAME="sangam-phase4-smoke-$$"
PORT=18080

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}
trap cleanup EXIT INT TERM

mkdir -p "$STATE/database" "$STATE/workspace" "$STATE/backups"
docker build -t sangam:phase4 "$ROOT"
docker run -d \
  --name "$NAME" \
  -p "127.0.0.1:$PORT:8000" \
  -v "$STATE/database:/data/database" \
  -v "$STATE/workspace:/data/workspace" \
  -v "$STATE/backups:/data/backups" \
  sangam:phase4 >/dev/null

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

HTML_CREATED=$(curl --fail --silent \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docker-smoke-html' \
  --data '{"title":"Interactive smoke","content":"<script>window.smoke=true</script><h1>Interactive</h1>","content_type":"text/html","path":"published/interactive.html"}' \
  "http://127.0.0.1:$PORT/api/v1/documents")
HTML_DOCUMENT_ID=$(printf '%s' "$HTML_CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["document_id"])')
HTML_REVISION_ID=$(printf '%s' "$HTML_CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["current_revision_id"])')
test -f "$STATE/workspace/published/interactive.html"

PUBLICATION=$(curl --fail --silent \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docker-smoke-publish' \
  --data "{\"document_id\":\"$HTML_DOCUMENT_ID\",\"slug\":\"docker-interactive\",\"access_policy\":\"public\"}" \
  "http://127.0.0.1:$PORT/api/v1/publications")
PUBLICATION_ID=$(printf '%s' "$PUBLICATION" | python3 -c 'import json,sys; print(json.load(sys.stdin)["publication_id"])')
curl --fail --silent \
  "http://127.0.0.1:$PORT/api/v1/publications/docker-interactive/content" \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["content_type"] == "text/html" and data["is_latest"]'

TRUSTED=$(curl --fail --silent -X PATCH \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docker-smoke-trust' \
  --data '{"expected_trust_version":0,"trust_level":"trusted_interactive"}' \
  "http://127.0.0.1:$PORT/api/v1/documents/$HTML_DOCUMENT_ID/trust")
printf '%s' "$TRUSTED" | python3 -c 'import json,sys; assert json.load(sys.stdin)["trust_level"] == "trusted_interactive"'
PREVIEW_GRANT=$(curl --fail --silent -X POST \
  "http://127.0.0.1:$PORT/api/v1/documents/$HTML_DOCUMENT_ID/trusted-preview?revision_id=$HTML_REVISION_ID")
PREVIEW_TOKEN=$(printf '%s' "$PREVIEW_GRANT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
curl --fail --silent \
  -H "Authorization: Sangam-Preview $PREVIEW_TOKEN" \
  "http://127.0.0.1:$PORT/api/v1/trusted-previews/content" \
  | grep -q 'window.smoke=true'
echo "Verified HTML materialization, stable publication, and isolated trusted preview."

ISSUED_TOKEN=$(curl --fail --silent \
  -H 'Content-Type: application/json' \
  --data '{"actor_id":"agent:docker-smoke","display_name":"Docker Smoke Agent","label":"Docker verification","scopes":[{"capability":"read","path_prefix":null},{"capability":"search","path_prefix":null},{"capability":"create","path_prefix":"agents"}]}' \
  "http://127.0.0.1:$PORT/api/v1/agent-tokens")
AGENT_TOKEN=$(printf '%s' "$ISSUED_TOKEN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])')
TOKEN_ID=$(printf '%s' "$ISSUED_TOKEN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token_id"])')
echo "Issued scoped agent token."

AGENT_DOCUMENT_ID=$(curl --fail --silent \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docker-smoke-agent-create' \
  --data '{"title":"Agent smoke","content":"# Scoped agent write\n","path":"agents/docker-smoke.md"}' \
  "http://127.0.0.1:$PORT/api/v1/documents" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["document_id"])')
test -n "$AGENT_DOCUMENT_ID"
echo "Verified in-scope agent write."

DENIED_STATUS=$(curl --silent \
  -o "$STATE/denied.json" \
  -w '%{http_code}' \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docker-smoke-agent-denied' \
  --data '{"title":"Denied agent write","content":"# Must not exist\n","path":"projects/denied-agent-write.md"}' \
  "http://127.0.0.1:$PORT/api/v1/documents")
if [ "$DENIED_STATUS" != "403" ]; then
  echo "Expected out-of-scope write to return 403; received $DENIED_STATUS." >&2
  exit 1
fi
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["error"]["code"] == "forbidden"' "$STATE/denied.json"
echo "Verified out-of-scope agent denial."

curl --fail --silent \
  "http://127.0.0.1:$PORT/api/v1/activity?actor_id=agent%3Adocker-smoke" \
  | python3 -c 'import json,sys; events=json.load(sys.stdin); outcomes={event["outcome"] for event in events}; assert {"accepted", "denied"} <= outcomes'
echo "Verified accepted and denied activity events."

curl --fail --silent -X DELETE \
  "http://127.0.0.1:$PORT/api/v1/agent-tokens/$TOKEN_ID" >/dev/null
REVOKED_STATUS=$(curl --silent \
  -o "$STATE/revoked.json" \
  -w '%{http_code}' \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  "http://127.0.0.1:$PORT/api/v1/documents")
if [ "$REVOKED_STATUS" != "401" ]; then
  echo "Expected revoked token to return 401; received $REVOKED_STATUS." >&2
  exit 1
fi
python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["error"]["code"] == "authentication_required"' "$STATE/revoked.json"
echo "Verified token revocation."

BACKUP_ID=$(curl --fail --silent -X POST \
  -H 'Idempotency-Key: docker-smoke-backup' \
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

echo "Docker smoke passed: API, scoped agent auth, activity, revocation, CLI, search, verified backup, host file, restart, and reconciliation."
