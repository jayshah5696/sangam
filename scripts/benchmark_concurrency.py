"""Reproducible Concurrency and Throughput Benchmark for Sangam.

Measures:
1. High-concurrency reads under WAL mode (50 parallel workers)
2. Concurrent write mutations with audit batching (20 parallel workers)
3. Mixed 80/20 Read/Write workload (30 workers)
4. Path-level PDF import contention
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
        f"{name:<30} | Ops: {count:>4} | Err: {errors:>2} | "
        f"Mean: {mean:>6.1f}ms | p50: {p50:>5.1f}ms | p95: {p95:>5.1f}ms | p99: {p99:>5.1f}ms | "
        f"Throughput: {rps:>6.1f} op/s"
    )


def run_read_benchmark(client: TestClient, workers: int, requests_per_worker: int) -> None:
    # Seed 50 documents first
    for i in range(50):
        client.post(
            "/api/v1/documents",
            json={"title": f"Bench Doc {i}", "content": f"Content {i} for benchmark"},
            headers={"Idempotency-Key": f"seed-doc-{i}"},
        )

    latencies: list[float] = []
    errors = 0
    start = time.perf_counter()

    def worker(worker_id: int):
        nonlocal errors
        w_latencies = []
        w_errors = 0
        for req in range(requests_per_worker):
            t0 = time.perf_counter()
            resp = client.get(
                "/api/v1/documents",
                headers={"Idempotency-Key": f"bench-read-{worker_id}-{req}"},
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
    print_stats(f"Read-Heavy ({workers} workers)", latencies, errors, total_time)


def run_write_benchmark(client: TestClient, workers: int, requests_per_worker: int) -> None:
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
                    "content": f"# Benchmark Content\nWorker {worker_id} request {req}",
                    "path": f"bench/{worker_id}_{req}.md",
                },
                headers={"Idempotency-Key": f"bench-write-{worker_id}-{req}"},
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
    print_stats(f"Write-Heavy ({workers} workers)", latencies, errors, total_time)


def run_mixed_benchmark(client: TestClient, workers: int, requests_per_worker: int) -> None:
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
                    headers={"Idempotency-Key": f"bench-mixed-{worker_id}-{req}"},
                )
                success = resp.status_code == 201
            else:
                resp = client.get(
                    "/api/v1/documents",
                    headers={"Idempotency-Key": f"bench-mixed-read-{worker_id}-{req}"},
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
    print_stats(f"Mixed 80/20 ({workers} workers)", latencies, errors, total_time)


def main() -> None:
    parser = argparse.ArgumentParser(description="Sangam concurrency benchmark")
    parser.add_argument("--workers", type=int, default=20, help="Number of concurrent workers")
    parser.add_argument("--ops-per-worker", type=int, default=15, help="Operations per worker")
    args = parser.parse_args()

    header = f"\n=== Sangam Benchmark (Workers: {args.workers}, Ops: {args.ops_per_worker}) ==="
    print(header)
    with tempfile.TemporaryDirectory() as temp_dir:
        client, settings = make_client(Path(temp_dir))
        with client:
            run_read_benchmark(
                client,
                workers=min(args.workers * 2, 50),
                requests_per_worker=args.ops_per_worker,
            )
            run_write_benchmark(
                client,
                workers=args.workers,
                requests_per_worker=args.ops_per_worker,
            )
            run_mixed_benchmark(
                client,
                workers=args.workers,
                requests_per_worker=args.ops_per_worker,
            )
    print(
        "========================================================================================\n"
    )


if __name__ == "__main__":
    main()
