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
  uv run uvicorn sangam.main:app --host 127.0.0.1 --port "$port" --no-access-log > "$run_dir/sangam.log" 2>&1 &
  local server_pid=$!

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

  local health_code
  health_code="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$port/api/v1/health" || echo "000")"
  if [[ "$health_code" != "200" ]]; then
    echo "Doctor FAILED: /api/v1/health returned HTTP $health_code" >&2
    exit 1
  fi

  local readiness_resp
  readiness_resp="$(curl -s "http://127.0.0.1:$port/api/v1/readiness")"

  # Database check using sqlite3
  local sqlite_check
  sqlite_check="$(sqlite3 "$SANGAM_DATABASE_PATH" "PRAGMA quick_check;" 2>&1 || echo "failed")"

  local schema_version
  schema_version="$(sqlite3 "$SANGAM_DATABASE_PATH" "SELECT COALESCE(MAX(version), 0) FROM schema_migrations;" 2>/dev/null || echo "unknown")"

  cat > "$out_file" <<EOF
{
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "run_id": "$run_id",
  "pid": $pid,
  "port": $port,
  "health_http_code": $health_code,
  "sqlite_quick_check": "$sqlite_check",
  "schema_version": "$schema_version",
  "readiness": $readiness_resp
}
EOF

  echo "Doctor PASS: Sangam instance healthy and ready."
  echo "  URL: http://127.0.0.1:$port"
  echo "  PID: $pid"
  echo "  Schema Version: $schema_version"
  echo "  SQLite check: $sqlite_check"
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
import time
import uuid
import httpx
import sqlite3
from pathlib import Path

base_url = "http://127.0.0.1:$port/api/v1"
db_path = "$SANGAM_DATABASE_PATH"
count = int("$count")

client = httpx.Client(timeout=10.0)

# 1. Measure readiness ping latency
t0 = time.perf_counter()
r = client.get(f"{base_url}/readiness")
readiness_latency_ms = (time.perf_counter() - t0) * 1000

# 2. Benchmark Document Creation throughput
create_latencies = []
created_doc_ids = []
t_start = time.perf_counter()

for i in range(count):
    payload = {
        "title": f"Benchmark Document #{i}",
        "content": f"# Benchmark Document {i}\n\nContent body with unique term benchmark_token_{i} and searchable metadata."
    }
    headers = {"Idempotency-Key": str(uuid.uuid4())}
    req_t0 = time.perf_counter()
    resp = client.post(f"{base_url}/documents", json=payload, headers=headers)
    req_ms = (time.perf_counter() - req_t0) * 1000
    create_latencies.append(req_ms)
    if resp.status_code in (200, 201):
        created_doc_ids.append(resp.json().get("document_id"))

t_total_create = time.perf_counter() - t_start
throughput_writes = count / t_total_create if t_total_create > 0 else 0

# 3. Benchmark FTS5 Search latency
search_latencies = []
t_search_start = time.perf_counter()
for i in range(count):
    token = f"benchmark_token_{i}"
    req_t0 = time.perf_counter()
    s_resp = client.get(f"{base_url}/search", params={"q": token})
    search_ms = (time.perf_counter() - req_t0) * 1000
    search_latencies.append(search_ms)

t_total_search = time.perf_counter() - t_search_start
throughput_searches = count / t_total_search if t_total_search > 0 else 0

create_latencies.sort()
search_latencies.sort()

def p(arr, percentile):
    if not arr:
        return 0.0
    idx = int(len(arr) * percentile)
    return round(arr[min(idx, len(arr) - 1)], 2)

# Verify DB state directly
conn = sqlite3.connect(db_path)
cur = conn.cursor()
cur.execute("SELECT COUNT(*) FROM documents WHERE title LIKE 'Benchmark Document %'")
doc_count_db = cur.fetchone()[0]
conn.close()

results = {
    "benchmark_count": count,
    "readiness_latency_ms": round(readiness_latency_ms, 2),
    "writes": {
        "count": len(create_latencies),
        "total_time_seconds": round(t_total_create, 3),
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
        "total_time_seconds": round(t_total_search, 3),
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
        "match_expected": doc_count_db == count
    }
}

Path("$report_file").write_text(json.dumps(results, indent=2), encoding="utf-8")
print(json.dumps(results, indent=2))
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
