#!/usr/bin/env bash
set -Eeuo pipefail

# control-sangam: Verification harness for Sangam (UI, CLI, API, Performance)
# Follows the create-verification-skill protocol: launch, doctor, drive, evidence, cleanup.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_FILE="${TMPDIR:-/tmp}/.sangam-active-verification"
ARTIFACTS_DIR="$ROOT_DIR/artifacts/verify-sangam"

usage() {
  cat <<'EOF'
Usage: ./scripts/control-sangam.sh <command> [arguments...]

Commands:
  launch [PORT]               Launch an isolated Sangam instance on [PORT] (default: 8765)
  doctor                      Run read-only verification check against the instance
  status                      Show running verification instance status
  seed                        Seed rich verification dataset (docs, revisions, publications, tokens)
  cli <args...>               Run sangam CLI command against active verification instance
  api <METHOD> <PATH> [JSON]  Run API request against active verification instance
  benchmark [COUNT]           Run verifiable performance/latency test suite (default: 30)
  eval [MODEL] [LIMIT]        Run chat agent policy verification and live evaluations
  cleanup                     Tear down the instance, remove temp state, retain evidence
  help                        Show this message
EOF
}

get_active_env() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "Error: No active verification instance found. Run './scripts/control-sangam.sh launch' first." >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  source "$STATE_FILE"
}

cmd_launch() {
  local port="${1:-8765}"
  if [[ -f "$STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
    if kill -0 "$SANGAM_VERIFY_PID" 2>/dev/null; then
      echo "Active verification instance already running at $SANGAM_API_URL (PID: $SANGAM_VERIFY_PID)."
      echo "Use './scripts/control-sangam.sh doctor' or './scripts/control-sangam.sh cleanup' first."
      return 0
    else
      rm -f "$STATE_FILE"
    fi
  fi

  local run_id
  run_id="$(date +%Y%m%d%H%M%S)_$RANDOM"
  local tmp_root="${TMPDIR:-/tmp}"
  tmp_root="${tmp_root%/}"
  local run_dir="$tmp_root/sangam-verify-$run_id"
  mkdir -p "$run_dir/database" "$run_dir/workspace" "$run_dir/backups" "$ARTIFACTS_DIR/$run_id"
  touch "$run_dir/sangam.log"

  export SANGAM_DATABASE_PATH="$run_dir/database/sangam.sqlite3"
  export SANGAM_WORKSPACE_ROOT="$run_dir/workspace"
  export SANGAM_BACKUP_ROOT="$run_dir/backups"
  export SANGAM_BACKUPS_ENABLED=false
  export SANGAM_FRONTEND_DIST="$ROOT_DIR/frontend/dist"
  export SANGAM_API_URL="http://127.0.0.1:$port"
  export SANGAM_TRUSTED_PREVIEW_BASE_URL="http://preview.localhost:$port/trusted-preview"
  export SANGAM_TRUSTED_PREVIEW_HOST="preview.localhost"
  export SANGAM_TRUSTED_PREVIEW_PARENT_ORIGINS="[\"http://127.0.0.1:$port\"]"

  echo "==> Launching isolated Sangam on port $port (Run ID: $run_id)..."
  cd "$ROOT_DIR"
  nohup uv run uvicorn sangam.main:app --host 127.0.0.1 --port "$port" --no-access-log > "$run_dir/sangam.log" 2>&1 &
  local server_pid=$!
  disown "$server_pid" 2>/dev/null || true

  # Record state
  cat > "$STATE_FILE" <<EOF
export SANGAM_VERIFY_RUN_ID="$run_id"
export SANGAM_VERIFY_PID="$server_pid"
export SANGAM_VERIFY_PORT="$port"
export SANGAM_VERIFY_RUN_DIR="$run_dir"
export SANGAM_API_URL="http://127.0.0.1:$port"
export SANGAM_DATABASE_PATH="$run_dir/database/sangam.sqlite3"
export SANGAM_WORKSPACE_ROOT="$run_dir/workspace"
export SANGAM_ARTIFACTS_DIR="$ARTIFACTS_DIR/$run_id"
EOF

  # Wait for readiness
  local attempt=0
  local ready=0
  while [[ $attempt -lt 40 ]]; do
    if ! kill -0 "$server_pid" 2>/dev/null; then
      echo "Error: Server process exited prematurely. Logs:" >&2
      cat "$run_dir/sangam.log" >&2
      rm -f "$STATE_FILE"
      exit 1
    fi

    if curl -s -f "http://127.0.0.1:$port/api/v1/readiness" >/dev/null 2>&1; then
      ready=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done

  if [[ $ready -ne 1 ]]; then
    echo "Error: Server did not become ready within 20s. Logs:" >&2
    cat "$run_dir/sangam.log" >&2
    kill "$server_pid" 2>/dev/null || true
    rm -f "$STATE_FILE"
    exit 1
  fi

  echo "==> Instance ready at http://127.0.0.1:$port (PID: $server_pid)"
  echo "    Database: $SANGAM_DATABASE_PATH"
  echo "    Artifacts: $ARTIFACTS_DIR/$run_id"
}

cmd_doctor() {
  get_active_env

  local port="$SANGAM_VERIFY_PORT"
  local pid="$SANGAM_VERIFY_PID"
  local run_id="$SANGAM_VERIFY_RUN_ID"
  local out_file="$SANGAM_ARTIFACTS_DIR/doctor.json"

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "Doctor FAILED: Process $pid is not running." >&2
    exit 1
  fi

  local health_file readiness_file
  health_file="$(mktemp)"
  readiness_file="$(mktemp)"
  trap 'rm -f "$health_file" "$readiness_file"' RETURN

  local health_code readiness_code
  health_code="$(curl -sS -o "$health_file" -w "%{http_code}" "http://127.0.0.1:$port/api/v1/health" || true)"
  readiness_code="$(curl -sS -o "$readiness_file" -w "%{http_code}" "http://127.0.0.1:$port/api/v1/readiness" || true)"
  [[ "$health_code" =~ ^[0-9]{3}$ ]] || health_code="000"
  [[ "$readiness_code" =~ ^[0-9]{3}$ ]] || readiness_code="000"

  if ! uv run python - "$health_file" "$readiness_file" "$SANGAM_DATABASE_PATH" "$out_file" "$run_id" "$pid" "$port" "$health_code" "$readiness_code" <<'PYEOF'
import json
import sqlite3
import sys
from datetime import UTC, datetime
from importlib import resources
from pathlib import Path

health_path, readiness_path, database_path, out_path, run_id, pid, port, health_code, readiness_code = sys.argv[1:]
errors: list[str] = []

def load_json(path: str, label: str) -> object:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        errors.append(f"{label} response is not valid JSON: {error}")
        return None

health = load_json(health_path, "health")
readiness = load_json(readiness_path, "readiness")
if health_code != "200":
    errors.append(f"/health returned HTTP {health_code}")
if not isinstance(health, dict) or health.get("status") != "ok":
    errors.append("/health payload does not report status=ok")
if readiness_code != "200":
    errors.append(f"/readiness returned HTTP {readiness_code}")
if not isinstance(readiness, dict) or readiness.get("status") != "ready":
    errors.append("/readiness payload does not report status=ready")
checks = readiness.get("checks") if isinstance(readiness, dict) else None
if not isinstance(checks, dict) or not checks:
    errors.append("/readiness payload has no checks")
else:
    for name, check in checks.items():
        if not isinstance(check, dict) or check.get("ok") is not True:
            errors.append(f"readiness check failed: {name}")

sqlite_check = "unavailable"
schema_version = "unknown"
expected_schema_version = "unknown"
try:
    expected_schema_version = max(
        migration.name.split("_", 1)[0]
        for migration in resources.files("sangam.migrations").iterdir()
        if migration.name.endswith(".sql")
    )
except (OSError, ValueError) as error:
    errors.append(f"Packaged migration inventory failed: {error}")
try:
    with sqlite3.connect(database_path) as connection:
        sqlite_check = str(connection.execute("PRAGMA quick_check").fetchone()[0])
        schema_version = str(connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0])
except (OSError, sqlite3.Error) as error:
    errors.append(f"SQLite verification failed: {error}")
if sqlite_check != "ok":
    errors.append(f"SQLite quick_check returned {sqlite_check!r}")
if schema_version in {"None", "unknown"}:
    errors.append("schema_migrations has no recorded version")
if expected_schema_version != "unknown" and schema_version != expected_schema_version:
    errors.append(
        f"schema version {schema_version} does not match packaged version {expected_schema_version}"
    )

evidence = {
    "timestamp": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    "run_id": run_id,
    "pid": int(pid),
    "port": int(port),
    "health_http_code": int(health_code),
    "readiness_http_code": int(readiness_code),
    "sqlite_quick_check": sqlite_check,
    "schema_version": schema_version,
    "expected_schema_version": expected_schema_version,
    "health": health,
    "readiness": readiness,
    "ok": not errors,
    "errors": errors,
}
Path(out_path).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
if errors:
    print("Doctor FAILED:")
    print("\n".join(f"  - {error}" for error in errors), file=sys.stderr)
    raise SystemExit(1)
print(f"Doctor PASS: Sangam instance healthy and ready (schema {schema_version}, SQLite {sqlite_check}).")
PYEOF
  then
    echo "  Evidence saved to: $out_file" >&2
    return 1
  fi
  echo "  URL: http://127.0.0.1:$port"
  echo "  PID: $pid"
  echo "  Evidence saved to: $out_file"
}

cmd_status() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No active verification instance."
    return 0
  fi
  # shellcheck disable=SC1090
  source "$STATE_FILE"
  if kill -0 "$SANGAM_VERIFY_PID" 2>/dev/null; then
    echo "Status: RUNNING"
    echo "  Run ID: $SANGAM_VERIFY_RUN_ID"
    echo "  PID: $SANGAM_VERIFY_PID"
    echo "  Port: $SANGAM_VERIFY_PORT"
    echo "  URL: $SANGAM_API_URL"
    echo "  Artifacts: $SANGAM_ARTIFACTS_DIR"
  else
    echo "Status: STOPPED (stale state file present)"
  fi
}

cmd_seed() {
  get_active_env
  local port="$SANGAM_VERIFY_PORT"
  local report_file="$SANGAM_ARTIFACTS_DIR/seed.json"

  echo "==> Seeding verification dataset into Sangam on port $port..."
  cd "$ROOT_DIR"
  uv run python scripts/seed_verification.py "$port" > "$report_file"
  cat "$report_file"
  echo "==> Seed data report saved to: $report_file"
}

cmd_cli() {
  get_active_env
  export SANGAM_API_URL
  cd "$ROOT_DIR"
  uv run sangam "$@"
}

cmd_api() {
  get_active_env
  local method="$1"
  shift
  local path="$1"
  shift
  local data="${1:-}"

  local idemp_key
  idemp_key="$(uuidgen 2>/dev/null || date +%s%N)"
  local url="$SANGAM_API_URL/api/v1$path"

  if [[ -n "$data" ]]; then
    curl -s -X "$method" "$url"       -H "Content-Type: application/json"       -H "Idempotency-Key: $idemp_key"       -d "$data"
  else
    curl -s -X "$method" "$url"       -H "Idempotency-Key: $idemp_key"
  fi
  echo ""
}

cmd_benchmark() {
  get_active_env
  local port="$SANGAM_VERIFY_PORT"
  local count="${1:-30}"
  local report_file="$SANGAM_ARTIFACTS_DIR/benchmark.json"

  echo "==> Running performance benchmark on Sangam (Count: $count requests)..."
  cd "$ROOT_DIR"
  uv run python - <<PYEOF
import json
import os
import sqlite3
import threading
import time
import uuid
from pathlib import Path
import httpx

base_url = "http://127.0.0.1:$port/api/v1"
db_path = "$SANGAM_DATABASE_PATH"
count = int("$count")
if count < 1:
    raise SystemExit("benchmark count must be a positive integer")
benchmark_id = uuid.uuid4().hex[:12]
title_prefix = f"Benchmark Document {benchmark_id} #"
errors = []

negative_mode = os.environ.get("SANGAM_VERIFY_BENCHMARK_NEGATIVE", "")
negative_expected_id = negative_mode == "wrong-document"
negative_stream_error = negative_mode in ("stream-error", "five-event-error")

client = httpx.Client(timeout=15.0)

# 1. Measure readiness ping latency
t0 = time.perf_counter()
r = client.get(f"{base_url}/readiness")
readiness_latency_ms = (time.perf_counter() - t0) * 1000
try:
    readiness = r.json()
except ValueError as error:
    readiness = None
    errors.append(f"readiness response is not valid JSON: {error}")
if r.status_code != 200 or not isinstance(readiness, dict) or readiness.get("status") != "ready":
    errors.append(f"readiness failed: HTTP {r.status_code}, payload={readiness!r}")
checks = readiness.get("checks", {}) if isinstance(readiness, dict) else {}
expected_checks = {
    "database",
    "schema",
    "writable_roots",
    "startup_reconciliation",
    "pending_materializations",
    "backup_freshness",
}
if not isinstance(checks, dict) or not checks:
    errors.append("readiness contains no checks")
elif set(checks) != expected_checks:
    errors.append(
        f"readiness checks do not match expected set: {sorted(checks)}"
    )
if not isinstance(checks, dict) or any(not isinstance(check, dict) or check.get("ok") is not True for check in checks.values()):
    errors.append("readiness contains a failed or malformed check")

# 2. Benchmark Live Server SSE Streaming overlapped with active storage contention
# Verifies streaming responsiveness, first-event latency, inter-event delays,
# completed assistant response item semantics, and direct SQLite persistence
# while storage writes and searches run continuously until the stream finishes.
stream_done = threading.Event()
stream_started = threading.Event()
stream_results = {
    "latencies": [],
    "events_count": 0,
    "thread_id": None,
    "first_event_ms": 0.0,
    "inter_event_delays_ms": [],
    "errors": [],
    "error_events": [],
    "completed_cleanly": False,
    "event_types": [],
    "total_time_seconds": 0.0,
    "assistant_item_id": None,
    "assistant_content": "",
    "t_start": 0.0,
    "t_end": 0.0,
}

def stream_worker():
    t_stream_worker_start = time.perf_counter()
    stream_results["t_start"] = t_stream_worker_start
    try:
        model_name = "unsupported/negative-error-model" if negative_stream_error else "openai/gpt-5.4-nano"
        with client.stream(
            "POST",
            f"{base_url}/chatkit",
            json={
                "type": "threads.create",
                "params": {
                    "input": {
                        "content": [{"type": "input_text", "text": "Contention streaming benchmark probe"}],
                        "attachments": [],
                        "inference_options": {"model": model_name},
                    }
                },
            },
            headers={"Content-Type": "application/json"},
        ) as stream_resp:
            stream_started.set()
            if stream_resp.status_code != 200:
                body_sample = stream_resp.read().decode("utf-8", errors="replace")[:200]
                stream_results["errors"].append(f"streaming failed with HTTP {stream_resp.status_code}: {body_sample}")
                return
            content_type = stream_resp.headers.get("content-type", "")
            if "text/event-stream" not in content_type:
                stream_results["errors"].append(f"streaming returned unexpected content-type: {content_type}")
                return

            sse_events = []
            prev_t = t_stream_worker_start
            for line in stream_resp.iter_lines():
                now_t = time.perf_counter()
                if line.startswith("data: "):
                    try:
                        ev = json.loads(line[6:])
                    except Exception as err:
                        stream_results["errors"].append(f"malformed SSE JSON: {err}")
                        continue

                    ev_type = ev.get("type")
                    sse_events.append(ev)
                    stream_results["event_types"].append(ev_type)
                    stream_results["latencies"].append((now_t - t_stream_worker_start) * 1000)
                    stream_results["inter_event_delays_ms"].append((now_t - prev_t) * 1000)
                    prev_t = now_t

                    if ev_type == "error":
                        stream_results["error_events"].append(ev)
                        err_code = ev.get('code')
                        err_msg = ev.get('message')
                        stream_results["errors"].append(
                            f"SSE error event received: code={err_code!r}, message={err_msg!r}"
                        )

            t_stream_worker_end = time.perf_counter()
            stream_results["t_end"] = t_stream_worker_end
            stream_results["total_time_seconds"] = t_stream_worker_end - t_stream_worker_start
            stream_results["events_count"] = len(sse_events)

            if sse_events and sse_events[0].get("type") == "thread.created":
                stream_results["thread_id"] = sse_events[0].get("thread", {}).get("id")

            if stream_results["latencies"]:
                stream_results["first_event_ms"] = stream_results["latencies"][0]

            # Completed assistant response according to ChatKit event schema
            completed_assistant_items = [
                ev.get("item")
                for ev in sse_events
                if ev.get("type") == "thread.item.done"
                and isinstance(ev.get("item"), dict)
                and ev["item"].get("type") == "assistant_message"
            ]
            if completed_assistant_items:
                asst_item = completed_assistant_items[-1]
                asst_id = asst_item.get("id")
                stream_results["assistant_item_id"] = asst_id
                content_parts = asst_item.get("content", [])
                asst_text = "".join(
                    part.get("text", "")
                    for part in content_parts
                    if isinstance(part, dict) and part.get("type") == "output_text"
                )
                stream_results["assistant_content"] = asst_text

            if (
                not stream_results["error_events"]
                and not stream_results["errors"]
                and stream_results["assistant_item_id"] is not None
            ):
                stream_results["completed_cleanly"] = True
    except Exception as exc:
        stream_results["errors"].append(f"streaming exception: {exc}")
    finally:
        if not stream_results["t_end"]:
            stream_results["t_end"] = time.perf_counter()
        stream_done.set()

stream_thread = threading.Thread(target=stream_worker, name="benchmark-sse-stream")
stream_thread.start()
stream_started.wait(timeout=1.0)

# 3. Sustained Storage Workload: document writes and FTS5 searches running until stream completes
create_latencies = []
created_doc_ids = []
created_documents = {}
search_latencies = []

t_storage_start = time.perf_counter()
doc_idx = 0

while doc_idx < count or not stream_done.is_set():
    # Write
    payload = {
        "title": f"{title_prefix}{doc_idx}",
        "content": f"# Benchmark Document {doc_idx}\n\nContent body with unique term benchmark_token_{doc_idx} and searchable metadata."
    }
    headers = {"Idempotency-Key": str(uuid.uuid4())}
    req_t0 = time.perf_counter()
    resp = client.post(f"{base_url}/documents", json=payload, headers=headers)
    req_ms = (time.perf_counter() - req_t0) * 1000
    create_latencies.append(req_ms)
    if resp.status_code not in (200, 201):
        errors.append(f"write {doc_idx} failed with HTTP {resp.status_code}: {resp.text[:200]}")
    else:
        try:
            document_id = resp.json().get("document_id")
            if not document_id:
                errors.append(f"write {doc_idx} returned no document_id")
            else:
                created_doc_ids.append(document_id)
                created_documents[f"benchmark_token_{doc_idx}"] = document_id
        except ValueError as err:
            errors.append(f"write {doc_idx} returned invalid JSON: {err}")

    # Search
    token = f"benchmark_token_{doc_idx}"
    s_t0 = time.perf_counter()
    s_resp = client.get(f"{base_url}/search", params={"q": token})
    search_ms = (time.perf_counter() - s_t0) * 1000
    search_latencies.append(search_ms)
    if s_resp.status_code != 200:
        errors.append(f"search {doc_idx} failed with HTTP {s_resp.status_code}: {s_resp.text[:200]}")
    else:
        try:
            search_results = s_resp.json()
            expected_document_id = created_documents.get(token)
            if negative_expected_id and created_doc_ids:
                expected_document_id = created_doc_ids[(doc_idx + 1) % len(created_doc_ids)]
            if not isinstance(search_results, list) or not any(
                isinstance(result, dict) and result.get("document_id") == expected_document_id
                for result in search_results
            ):
                errors.append(
                    f"search {doc_idx} did not return the expected benchmark document "
                    f"{expected_document_id!r} for {token}"
                )
        except ValueError as err:
            errors.append(f"search {doc_idx} returned invalid JSON: {err}")

    doc_idx += 1

t_storage_end = time.perf_counter()
storage_duration = t_storage_end - t_storage_start

# Join streaming thread
stream_thread.join(timeout=35.0)
if stream_thread.is_alive():
    errors.append("streaming probe timed out after 35 seconds")

t_stream_start = stream_results.get("t_start", t_storage_start)
t_stream_end = stream_results.get("t_end", t_storage_end)
stream_duration = max(0.001, t_stream_end - t_stream_start)

overlap_start = max(t_storage_start, t_stream_start)
overlap_end = min(t_storage_end, t_stream_end)
actual_overlap = max(0.0, overlap_end - overlap_start)
overlap_percentage = round((actual_overlap / stream_duration) * 100, 1)

throughput_writes = len(create_latencies) / storage_duration if storage_duration > 0 else 0
throughput_searches = len(search_latencies) / storage_duration if storage_duration > 0 else 0

# Check streaming errors & requirements
if stream_results["error_events"]:
    for ev in stream_results["error_events"]:
        err_code = ev.get('code')
        err_msg = ev.get('message')
        errors.append(
            f"streaming encountered error event: code={err_code!r}, message={err_msg!r}"
        )
if stream_results["errors"]:
    for err in stream_results["errors"]:
        errors.append(f"streaming error: {err}")

if not stream_results["assistant_item_id"]:
    errors.append(
        "streaming stream ended without a completed assistant response "
        "(missing thread.item.done event with item.type='assistant_message')"
    )

create_latencies.sort()
search_latencies.sort()
delays = sorted(stream_results["inter_event_delays_ms"])

def p(arr, percentile):
    if not arr:
        return 0.0
    idx = int(len(arr) * percentile)
    return round(arr[min(idx, len(arr) - 1)], 2)

# Verify DB state directly for both documents and chat persistence
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("SELECT COUNT(*) FROM documents WHERE title LIKE ?", (f"{title_prefix}%",))
doc_count_db = cur.fetchone()[0]

chat_thread_row = None
chat_item_count = 0
chat_assistant_row = None
chat_assistant_matched = False
chat_content_matched = False

thread_id = stream_results.get("thread_id")
assistant_item_id = stream_results.get("assistant_item_id")
assistant_text = stream_results.get("assistant_content", "")

if thread_id:
    cur.execute(
        "SELECT thread_id, created_by, data_json FROM chat_threads WHERE thread_id = ?",
        (thread_id,),
    )
    chat_thread_row = cur.fetchone()

    cur.execute(
        "SELECT COUNT(*) FROM chat_thread_items WHERE thread_id = ?",
        (thread_id,),
    )
    chat_item_count = cur.fetchone()[0]

    if assistant_item_id:
        cur.execute(
            "SELECT item_id, thread_id, data_json, created_at FROM chat_thread_items WHERE thread_id = ? AND item_id = ?",
            (thread_id, assistant_item_id),
        )
        chat_assistant_row = cur.fetchone()
        if chat_assistant_row:
            try:
                db_raw = json.loads(chat_assistant_row[2])
                db_payload = db_raw.get("payload", db_raw) if isinstance(db_raw, dict) else {}
                db_id = db_payload.get("id")
                db_type = db_payload.get("type")
                db_content = db_payload.get("content", [])
                db_text = "".join(
                    part.get("text", "")
                    for part in db_content
                    if isinstance(part, dict) and part.get("type") == "output_text"
                )
                if db_id == assistant_item_id and db_type == "assistant_message":
                    chat_assistant_matched = True
                if db_text == assistant_text:
                    chat_content_matched = True
                else:
                    errors.append(
                        f"assistant response content mismatch between stream and SQLite for {assistant_item_id}: "
                        f"stream has {len(assistant_text)} chars, db has {len(db_text)} chars"
                    )
            except Exception as db_err:
                errors.append(f"failed to parse chat_thread_items data_json: {db_err}")
conn.close()

if not chat_thread_row:
    errors.append(f"chat thread {thread_id} was not persisted in SQLite chat_threads table")
if not chat_assistant_row:
    errors.append(f"completed assistant response item {assistant_item_id} was not persisted in SQLite chat_thread_items")
elif not chat_assistant_matched:
    errors.append(f"persisted chat item in SQLite does not match assistant item ID {assistant_item_id}")
if not chat_content_matched:
    errors.append("persisted chat item content in SQLite does not match streamed assistant response")

results = {
    "benchmark_count": count,
    "readiness_latency_ms": round(readiness_latency_ms, 2),
    "writes": {
        "count": len(create_latencies),
        "total_time_seconds": round(storage_duration, 3),
        "writes_per_second": round(throughput_writes, 1),
        "latency_ms": {
            "p50": p(create_latencies, 0.50),
            "p90": p(create_latencies, 0.90),
            "p95": p(create_latencies, 0.95),
            "p99": p(create_latencies, 0.99),
        }
    },
    "fts5_search": {
        "count": len(search_latencies),
        "total_time_seconds": round(storage_duration, 3),
        "searches_per_second": round(throughput_searches, 1),
        "latency_ms": {
            "p50": p(search_latencies, 0.50),
            "p90": p(search_latencies, 0.90),
            "p95": p(search_latencies, 0.95),
            "p99": p(search_latencies, 0.99),
        }
    },
    "database_verification": {
        "persisted_documents_in_sqlite": doc_count_db,
        "match_expected": doc_count_db == len(create_latencies),
        "unique_document_ids": len(set(created_doc_ids)),
        "chat_thread_persisted_in_sqlite": chat_thread_row is not None,
        "chat_items_persisted_in_sqlite": chat_item_count,
        "assistant_item_persisted_in_sqlite": chat_assistant_row is not None,
        "assistant_item_id_matched": chat_assistant_matched,
        "assistant_content_matched": chat_content_matched,
    },
    "live_streaming_under_contention": {
        "events_count": stream_results["events_count"],
        "thread_id": stream_results["thread_id"],
        "event_types": stream_results["event_types"],
        "completed_cleanly": stream_results["completed_cleanly"],
        "error_events": stream_results["error_events"],
        "assistant_item_id": stream_results["assistant_item_id"],
        "assistant_content_length": len(assistant_text),
        "total_time_seconds": round(stream_results["total_time_seconds"], 3),
        "first_event_latency_ms": round(stream_results["first_event_ms"], 2),
        "delays_between_events_ms": {
            "p50": p(delays, 0.50),
            "p90": p(delays, 0.90),
            "max": round(max(delays), 2) if delays else 0.0,
        },
        "contention_overlap": {
            "storage_duration_seconds": round(storage_duration, 3),
            "stream_duration_seconds": round(stream_duration, 3),
            "actual_overlap_seconds": round(actual_overlap, 3),
            "overlap_percentage": overlap_percentage,
            "writes_during_contention": len(create_latencies),
            "searches_during_contention": len(search_latencies),
        }
    }
}

if len(create_latencies) < count:
    errors.append(f"only {len(create_latencies)} write responses were recorded; expected at least {count}")
if len(created_doc_ids) != len(create_latencies) or len(set(created_doc_ids)) != len(create_latencies):
    errors.append("write responses did not contain unique document IDs for every request")
if len(search_latencies) != len(create_latencies):
    errors.append("number of search responses did not match write responses")
if doc_count_db != len(create_latencies):
    errors.append(f"SQLite persisted {doc_count_db} benchmark documents; expected {len(create_latencies)}")
results["ok"] = not errors
results["errors"] = errors

Path("$report_file").write_text(json.dumps(results, indent=2), encoding="utf-8")
print(json.dumps(results, indent=2))
if errors:
    raise SystemExit("Benchmark FAILED: " + "; ".join(errors))
PYEOF
  echo "==> Benchmark report saved to: $report_file"
}

cmd_eval() {
  local model="${1:-openai/gpt-5.6-luna}"
  local limit="${2:-}"
  local report_file
  if [[ -f "$STATE_FILE" ]]; then
    # shellcheck disable=SC1090
    source "$STATE_FILE"
    report_file="$SANGAM_ARTIFACTS_DIR/agent-eval.json"
  else
    local run_id
    run_id="$(date +%Y%m%d%H%M%S)_$RANDOM"
    local artifacts_dir="$ROOT_DIR/artifacts/verify-sangam/$run_id"
    mkdir -p "$artifacts_dir"
    report_file="$artifacts_dir/agent-eval.json"
  fi

  echo "==> Verifying Chat Agent & Capability Policy (Model: $model)..."
  cd "$ROOT_DIR"

  # 1. Deterministic capability policy and plan lifecycle verification
  echo "  --> Verifying deterministic capability policies and organization lifecycle..."
  uv run pytest tests/test_chat_capability_lifecycle.py tests/test_organization_plans.py

  # 2. Live empirical evals via OpenRouter if key is available
  local has_key=0
  if [[ -n "${SANGAM_OPENROUTER_API_KEY:-}" ]] || [[ -n "${OPENROUTER_API_KEY:-}" ]] || grep -qE "^SANGAM_OPENROUTER_API_KEY=.+" "$ROOT_DIR/.env" 2>/dev/null; then
    has_key=1
  fi

  if [[ $has_key -eq 1 ]]; then
    echo "  --> Running live agent evaluations against OpenRouter ($model)..."
    local extra_args=()
    if [[ -n "$limit" ]]; then
      extra_args+=(--limit "$limit")
    fi
    uv run python scripts/run_chat_evals.py \
      --model "$model" \
      --autonomy-mode review \
      --output "$report_file" \
      "${extra_args[@]}"
    echo "==> Agent eval evidence saved to: $report_file"
  else
    echo "  --> Notice: SANGAM_OPENROUTER_API_KEY not configured in environment or .env."
    echo "      Deterministic chat policies verified; skipping live remote LLM eval."
  fi
}

cmd_cleanup() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo "No active verification instance to clean up."
    return 0
  fi

  # shellcheck disable=SC1090
  source "$STATE_FILE"
  local pid="${SANGAM_VERIFY_PID:-}"
  local run_dir="${SANGAM_VERIFY_RUN_DIR:-}"

  echo "==> Cleaning up verification instance..."
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "  Stopping server process (PID: $pid)..."
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi

  if [[ -n "$run_dir" ]] && [[ -d "$run_dir" ]]; then
    echo "  Removing temporary run state: $run_dir"
    rm -rf "$run_dir"
  fi

  rm -f "$STATE_FILE"
  echo "==> Cleanup complete. Proof artifacts preserved at: $SANGAM_ARTIFACTS_DIR"
}

case "${1:-help}" in
  launch)
    shift
    cmd_launch "$@"
    ;;
  doctor)
    cmd_doctor
    ;;
  status)
    cmd_status
    ;;
  seed)
    cmd_seed
    ;;
  cli)
    shift
    cmd_cli "$@"
    ;;
  api)
    shift
    cmd_api "$@"
    ;;
  benchmark)
    shift
    cmd_benchmark "$@"
    ;;
  eval)
    shift
    cmd_eval "$@"
    ;;
  cleanup)
    cmd_cleanup
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo "Unknown command: $1" >&2
    usage >&2
    exit 1
    ;;
esac
