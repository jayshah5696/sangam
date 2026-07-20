#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE=$(mktemp -d "$ROOT/.sangam-smoke.XXXXXX")
NAME="sangam-phase7-smoke-$$"
KARAKEEP_NAME="sangam-karakeep-smoke-$$"
NETWORK="sangam-phase7-smoke-$$"
PORT=18080

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker rm -f "$KARAKEEP_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}
trap cleanup EXIT INT TERM

mkdir -p "$STATE/database" "$STATE/workspace" "$STATE/backups"
docker build -t sangam:phase7 "$ROOT"
docker network create "$NETWORK" >/dev/null
docker run -d \
  --name "$KARAKEEP_NAME" \
  --network "$NETWORK" \
  -v "$ROOT/scripts/fake-karakeep.py:/fake-karakeep.py:ro" \
  sangam:phase7 uv run --no-sync python /fake-karakeep.py >/dev/null
docker run -d \
  --name "$NAME" \
  --network "$NETWORK" \
  -p "127.0.0.1:$PORT:8000" \
  -v "$STATE/database:/data/database" \
  -v "$STATE/workspace:/data/workspace" \
  -v "$STATE/backups:/data/backups" \
  -e "SANGAM_KARAKEEP_BASE_URL=http://$KARAKEEP_NAME:8901/api/v1" \
  -e SANGAM_KARAKEEP_API_KEY=docker-smoke-key \
  sangam:phase7 >/dev/null

attempt=0
until curl --fail --silent "http://127.0.0.1:$PORT/api/v1/health" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$NAME"
    exit 1
  fi
  sleep 1
done

curl --fail --silent "http://127.0.0.1:$PORT/api/v1/chat/config" \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["provider"] == "openrouter_openai_agents" and data["transport"] == "chatkit" and not data["configured"]'
curl --fail --silent "http://127.0.0.1:$PORT/" \
  | grep -q 'https://cdn.platform.openai.com/deployments/chatkit/chatkit.js'
CHATKIT_STREAM=$(curl --fail --silent \
  -H 'Content-Type: application/json' \
  --data '{"type":"threads.create","params":{"input":{"content":[{"type":"input_text","text":"Docker ChatKit smoke"}],"attachments":[],"inference_options":{"model":"openai/gpt-5.4-nano"}}}}' \
  "http://127.0.0.1:$PORT/api/v1/chatkit")
CHATKIT_THREAD_ID=$(printf '%s' "$CHATKIT_STREAM" \
  | python3 -c 'import json,sys; events=[json.loads(line[6:]) for line in sys.stdin if line.startswith("data: ")]; assert [item["type"] for item in events] == ["thread.created", "thread.item.done", "stream_options", "error"]; assert events[-1]["code"] == "custom"; print(events[0]["thread"]["id"])')
echo "Verified ChatKit protocol, durable thread creation, and safe unconfigured runtime."

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

curl --fail --silent \
  "http://127.0.0.1:$PORT/api/v1/karakeep/health" \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["connected"]'
KARAKEEP_SEARCH=$(curl --fail --silent \
  "http://127.0.0.1:$PORT/api/v1/karakeep/bookmarks?q=container")
KARAKEEP_BOOKMARK_ID=$(printf '%s' "$KARAKEEP_SEARCH" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["bookmarks"][0]["bookmark_id"])')
KARAKEEP_IMPORT=$(curl --fail --silent \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docker-smoke-karakeep-import' \
  --data "{\"bookmark_id\":\"$KARAKEEP_BOOKMARK_ID\"}" \
  "http://127.0.0.1:$PORT/api/v1/karakeep/imports")
KARAKEEP_DOCUMENT_ID=$(printf '%s' "$KARAKEEP_IMPORT" \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["status"] == "current" and len(data["assets"]) == 1; print(data["document_id"])')
curl --fail --silent \
  "http://127.0.0.1:$PORT/api/v1/documents/$KARAKEEP_DOCUMENT_ID/history" \
  | python3 -c 'import json,sys; assert json.load(sys.stdin)[0]["actor_id"] == "integration:karakeep"'
KARAKEEP_REPEATED_ID=$(curl --fail --silent \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docker-smoke-karakeep-repeat' \
  --data "{\"bookmark_id\":\"$KARAKEEP_BOOKMARK_ID\"}" \
  "http://127.0.0.1:$PORT/api/v1/karakeep/imports" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["document_id"])')
test "$KARAKEEP_REPEATED_ID" = "$KARAKEEP_DOCUMENT_ID"
echo "Verified Karakeep connection, selective import, attribution, attachment metadata, and repeat identity."

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

docker exec -i "$NAME" uv run --no-sync python - <<'PY'
from pathlib import Path
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

def write_pdf(path: str, text: str) -> None:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject({
        NameObject("/Type"): NameObject("/Font"),
        NameObject("/Subtype"): NameObject("/Type1"),
        NameObject("/BaseFont"): NameObject("/Helvetica"),
    })
    reference = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({NameObject("/F1"): reference})
    })
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 12 Tf 72 720 Td ({text}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(stream)
    with Path(path).open("wb") as output:
        writer.write(output)

write_pdf("/tmp/research.pdf", "Container PDF evidence phrase")
write_pdf("/tmp/research-replacement.pdf", "Replacement PDF evidence")
PY
docker cp "$NAME:/tmp/research.pdf" "$STATE/research.pdf"
docker cp "$NAME:/tmp/research-replacement.pdf" "$STATE/research-replacement.pdf"

PDF_CREATED=$(curl --fail --silent \
  -H 'Content-Type: application/pdf' \
  -H 'Idempotency-Key: docker-smoke-pdf' \
  --data-binary "@$STATE/research.pdf" \
  "http://127.0.0.1:$PORT/api/v1/pdfs?title=Research%20PDF&path=research%2Fresearch.pdf")
PDF_DOCUMENT_ID=$(printf '%s' "$PDF_CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["document_id"])')
PDF_HASH=$(printf '%s' "$PDF_CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["content_hash"])')

attempt=0
while :; do
  PDF_STATUS=$(curl --fail --silent \
    "http://127.0.0.1:$PORT/api/v1/documents/$PDF_DOCUMENT_ID" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["pdf_extraction_status"])')
  test "$PDF_STATUS" = "ready" && break
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "PDF extraction did not become ready." >&2
    exit 1
  fi
  sleep 1
done

curl --fail --silent \
  "http://127.0.0.1:$PORT/api/v1/pdfs/$PDF_DOCUMENT_ID/search?q=evidence%20phrase" \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data[0]["page_number"] == 1'
RANGE_STATUS=$(curl --silent \
  -H 'Range: bytes=0-7' \
  -o "$STATE/pdf-range.bin" \
  -w '%{http_code}' \
  "http://127.0.0.1:$PORT/api/v1/pdfs/$PDF_DOCUMENT_ID/content")
test "$RANGE_STATUS" = "206"
python3 -c 'import sys; source=open(sys.argv[1], "rb").read(); partial=open(sys.argv[2], "rb").read(); assert partial == source[:8]' \
  "$STATE/research.pdf" "$STATE/pdf-range.bin"

ANNOTATION=$(curl --fail --silent \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: docker-smoke-annotation' \
  --data '{"page_number":1,"annotation_type":"area_highlight","note":"Container note","geometry":[{"x":0.1,"y":0.1,"width":0.2,"height":0.05}],"tags":["smoke"],"color":"#f0c75e"}' \
  "http://127.0.0.1:$PORT/api/v1/pdfs/$PDF_DOCUMENT_ID/annotations")
ANNOTATION_ID=$(printf '%s' "$ANNOTATION" | python3 -c 'import json,sys; print(json.load(sys.stdin)["annotation_id"])')
curl --fail --silent \
  "http://127.0.0.1:$PORT/api/v1/annotations/$ANNOTATION_ID/history" \
  | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data[0]["operation"] == "create"'

PDF_REPLACEMENT=$(curl --fail --silent \
  -H 'Content-Type: application/pdf' \
  -H 'Idempotency-Key: docker-smoke-pdf-replacement' \
  --data-binary "@$STATE/research-replacement.pdf" \
  "http://127.0.0.1:$PORT/api/v1/pdfs?title=Replacement%20PDF&path=research%2Fresearch-replacement.pdf&supersedes_document_id=$PDF_DOCUMENT_ID")
printf '%s' "$PDF_REPLACEMENT" | python3 -c 'import json,sys; data=json.load(sys.stdin); assert data["supersedes_document_id"] == sys.argv[1] and data["document_id"] != sys.argv[1]' "$PDF_DOCUMENT_ID"
test "$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$STATE/workspace/research/research.pdf")" = "$PDF_HASH"
echo "Verified immutable PDF import, extraction, range serving, annotation history, and replacement relationship."

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

curl --fail --silent \
  -H 'Content-Type: application/json' \
  --data "{\"type\":\"threads.get_by_id\",\"params\":{\"thread_id\":\"$CHATKIT_THREAD_ID\"}}" \
  "http://127.0.0.1:$PORT/api/v1/chatkit" \
  | python3 -c 'import json,sys; thread=json.load(sys.stdin); assert thread["items"]["data"][0]["content"][0]["text"] == "Docker ChatKit smoke"'
echo "Verified ChatKit thread recovery after container restart."

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

echo "Docker smoke passed: text, HTML, PDF research, Karakeep import, scoped agents, search, backup, restart, and reconciliation."
