"""Reproducible Concurrency and Throughput Benchmark for Sangam.

Measures:
1. High-concurrency agent reads exercising audit writes under WAL mode (40 parallel workers)
2. Concurrent agent write mutations with audit batching (20 parallel workers)
3. Mixed 80/20 Read/Write agent workload (20 workers)
4. Full audit row verification in SQLite database (zero dropped audit logs)
"""

from __future__ import annotations

import argparse
import concurrent.futures
import statistics
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings


def make_client(tmp_path: Path) -> tuple[TestClient, Settings]:
    settings = Settings(
        database_path=tmp_path / "database" / "bench.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
        backups_enabled=False,
        frontend_dist=tmp_path / "missing-frontend",
        openrouter_api_key=None,
    )
    return TestClient(create_app(settings)), settings


def issue_benchmark_agent_token(client: TestClient) -> str:
    response = client.post(
        "/api/v1/agent-tokens",
        json={
            "actor_id": "agent:benchmark",
            "display_name": "Benchmark Agent",
            "label": "benchmark agent token",
            "scopes": [
                {"capability": "read", "path_prefix": None},
                {"capability": "create", "path_prefix": None},
                {"capability": "update", "path_prefix": None},
                {"capability": "search", "path_prefix": None},
            ],
        },
        headers={"Idempotency-Key": "bench-agent-token-key"},
    )
    assert response.status_code == 201, f"Failed to issue agent token: {response.text}"
    return response.json()["token"]


def print_stats(name: str, latencies: list[float], errors: int, total_time: float) -> None:
    count = len(latencies)
    if count == 0:
        print(f"{name:35} No successful operations. Errors: {errors}")
        return

    latencies_ms = [lat * 1000 for lat in latencies]
    latencies_ms.sort()
    p50 = statistics.median(latencies_ms)
    p95 = latencies_ms[int(0.95 * count)]
    p99 = latencies_ms[int(0.99 * count)]
    mean = statistics.mean(latencies_ms)
    rps = count / total_time if total_time > 0 else 0

    print(
        f"{name:<32} | Ops: {count:>4} | Err: {errors:>2} | "
        f"Mean: {mean:>6.1f}ms | p50: {p50:>5.1f}ms | p95: {p95:>5.1f}ms | p99: {p99:>5.1f}ms | "
        f"Throughput: {rps:>6.1f} op/s"
    )


def run_read_benchmark(
    client: TestClient, token: str, workers: int, requests_per_worker: int
) -> int:
    # Seed 50 documents first
    for i in range(50):
        client.post(
            "/api/v1/documents",
            json={"title": f"Bench Doc {i}", "content": f"Content {i} for benchmark"},
            headers={
                "Authorization": f"Bearer {token}",
                "Idempotency-Key": f"seed-doc-{i}",
            },
        )

    latencies: list[float] = []
    errors = 0
    start = time.perf_counter()

    def worker(worker_id: int):
        w_latencies = []
        w_errors = 0
        for req in range(requests_per_worker):
            t0 = time.perf_counter()
            resp = client.get(
                "/api/v1/documents",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Idempotency-Key": f"bench-read-{worker_id}-{req}",
                },
            )
            elapsed = time.perf_counter() - t0
            if resp.status_code == 200:
                w_latencies.append(elapsed)
            else:
                w_errors += 1
        return w_latencies, w_errors

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(worker, i) for i in range(workers)]
        for f in concurrent.futures.as_completed(futures):
            wl, we = f.result()
            latencies.extend(wl)
            errors += we

    total_time = time.perf_counter() - start
    print_stats(f"Agent Read-Heavy ({workers} workers)", latencies, errors, total_time)
    if errors > 0:
        raise RuntimeError(f"Read benchmark encountered {errors} errors")
    return len(latencies)


def run_write_benchmark(
    client: TestClient, token: str, workers: int, requests_per_worker: int
) -> int:
    latencies: list[float] = []
    errors = 0
    start = time.perf_counter()

    def worker(worker_id: int):
        w_latencies = []
        w_errors = 0
        for req in range(requests_per_worker):
            t0 = time.perf_counter()
            resp = client.post(
                "/api/v1/documents",
                json={
                    "title": f"Bench Mut {worker_id}-{req}",
                    "content": f"# Benchmark Content\\nWorker {worker_id} request {req}",
                    "path": f"bench/{worker_id}_{req}.md",
                },
                headers={
                    "Authorization": f"Bearer {token}",
                    "Idempotency-Key": f"bench-write-{worker_id}-{req}",
                },
            )
            elapsed = time.perf_counter() - t0
            if resp.status_code == 201:
                w_latencies.append(elapsed)
            else:
                w_errors += 1
        return w_latencies, w_errors

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(worker, i) for i in range(workers)]
        for f in concurrent.futures.as_completed(futures):
            wl, we = f.result()
            latencies.extend(wl)
            errors += we

    total_time = time.perf_counter() - start
    print_stats(f"Agent Write-Heavy ({workers} workers)", latencies, errors, total_time)
    if errors > 0:
        raise RuntimeError(f"Write benchmark encountered {errors} errors")
    return len(latencies)


def run_mixed_benchmark(
    client: TestClient, token: str, workers: int, requests_per_worker: int
) -> int:
    latencies: list[float] = []
    errors = 0
    start = time.perf_counter()

    def worker(worker_id: int):
        w_latencies = []
        w_errors = 0
        for req in range(requests_per_worker):
            is_write = req % 5 == 0  # 20% writes, 80% reads
            t0 = time.perf_counter()
            if is_write:
                resp = client.post(
                    "/api/v1/documents",
                    json={
                        "title": f"Bench Mixed {worker_id}-{req}",
                        "content": "Mixed content load",
                        "path": f"mixed/{worker_id}_{req}.md",
                    },
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Idempotency-Key": f"bench-mixed-{worker_id}-{req}",
                    },
                )
                success = resp.status_code == 201
            else:
                resp = client.get(
                    "/api/v1/documents",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Idempotency-Key": f"bench-mixed-read-{worker_id}-{req}",
                    },
                )
                success = resp.status_code == 200
            elapsed = time.perf_counter() - t0
            if success:
                w_latencies.append(elapsed)
            else:
                w_errors += 1
        return w_latencies, w_errors

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(worker, i) for i in range(workers)]
        for f in concurrent.futures.as_completed(futures):
            wl, we = f.result()
            latencies.extend(wl)
            errors += we

    total_time = time.perf_counter() - start
    print_stats(f"Agent Mixed 80/20 ({workers} workers)", latencies, errors, total_time)
    if errors > 0:
        raise RuntimeError(f"Mixed benchmark encountered {errors} errors")
    return len(latencies)


def main() -> None:
    parser = argparse.ArgumentParser(description="Sangam concurrency benchmark")
    parser.add_argument("--workers", type=int, default=20, help="Number of concurrent workers")
    parser.add_argument("--ops-per-worker", type=int, default=15, help="Operations per worker")
    args = parser.parse_args()

    header = (
        f"\n=== Sangam Concurrency Benchmark (Workers: {args.workers}, "
        f"Ops: {args.ops_per_worker}) ==="
    )
    print(header)
    with tempfile.TemporaryDirectory() as temp_dir:
        client, settings = make_client(Path(temp_dir))
        with client:
            token = issue_benchmark_agent_token(client)

            # Initial token creation logged 1 event
            expected_audits = 1
            # 50 seed documents created
            expected_audits += 50

            read_ops = run_read_benchmark(
                client,
                token=token,
                workers=min(args.workers * 2, 40),
                requests_per_worker=args.ops_per_worker,
            )
            expected_audits += read_ops

            write_ops = run_write_benchmark(
                client,
                token=token,
                workers=args.workers,
                requests_per_worker=args.ops_per_worker,
            )
            expected_audits += write_ops

            mixed_ops = run_mixed_benchmark(
                client,
                token=token,
                workers=args.workers,
                requests_per_worker=args.ops_per_worker,
            )
            expected_audits += mixed_ops

            # Deep audit validation & database integrity verification
            activity_svc = client.app.state.services.activity
            activity_svc.list_events(limit=1)
            db = activity_svc.database

            with db.connection() as conn:
                row = conn.execute("SELECT count(*) as cnt FROM operation_events").fetchone()
                persisted_events = row["cnt"]

                # Deep validation on document create events
                rows = conn.execute(
                    "SELECT event_id, resource_id, revision_id, path, action, outcome, detail_json "
                    "FROM operation_events WHERE action = 'create'"
                ).fetchall()
                for r in rows:
                    assert r["resource_id"] is not None, (
                        f"Event {r['event_id']} missing resource_id"
                    )
                    assert r["revision_id"] is not None, (
                        f"Event {r['event_id']} missing revision_id"
                    )
                    assert r["outcome"] == "accepted", f"Event {r['event_id']} outcome not accepted"
                    # Correlate with documents table
                    doc = conn.execute(
                        "SELECT document_id, current_revision_id, path FROM documents "
                        "WHERE document_id = ?",
                        (r["resource_id"],),
                    ).fetchone()
                    assert doc is not None, f"Document {r['resource_id']} not found in DB"
                    assert doc["current_revision_id"] == r["revision_id"]

            print(
                f"\nAudit Log Durability Check: {persisted_events} persisted / "
                f"{expected_audits} expected "
                f"({persisted_events / expected_audits * 100:.1f}% durability, "
                f"0 dropped events, 100% verified)"
            )
            assert persisted_events == expected_audits, (
                f"Audit row count mismatch! Persisted: {persisted_events}, "
                f"Expected: {expected_audits}"
            )

            # Memory and WAL storage statistics
            assert activity_svc._admitted_bytes == 0, "Leaked admitted bytes in ActivityService"
            assert activity_svc._queue_bytes == 0, "Drained queue bytes not zero"
            assert activity_svc._reserved_producer_bytes == 0, "Leaked reserved producer bytes"

            db_size = Path(settings.database_path).stat().st_size
            wal_path = Path(str(settings.database_path) + "-wal")
            wal_size = wal_path.stat().st_size if wal_path.exists() else 0
            print(
                f"Storage Metrics: SQLite DB = {db_size / 1024:.1f} KB, "
                f"WAL = {wal_size / 1024:.1f} KB | Active Memory Queue: 0 B"
            )

    print(
        "========================================================================================\n"
    )


if __name__ == "__main__":
    main()
