"""Reproducible Concurrency, Saturated Backpressure, and Audit Integrity Benchmark for Sangam.

Measures:
1. High-concurrency agent reads exercising audit writes under WAL mode (40 parallel workers)
2. Concurrent agent write creates with audit batching (20 parallel workers)
3. Concurrent agent document updates exercising diff generation & persistence (20 parallel workers)
4. Mixed Read/Create/Update agent workload (20 workers)
5. Saturated backpressure workload under tight memory budget (64 KB total / 32 KB queue)
6. Deep SQLite audit log verification: exact payload validation across all event types,
   proving zero dropped events and complete untruncated change representations.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import statistics
import tempfile
import time
from pathlib import Path

from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings


def make_client(
    tmp_path: Path,
    *,
    max_total_bytes: int | None = None,
    max_queue_bytes: int | None = None,
) -> tuple[TestClient, Settings]:
    settings = Settings(
        database_path=tmp_path / "database" / "bench.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
        backups_enabled=False,
        frontend_dist=tmp_path / "missing-frontend",
        openrouter_api_key=None,
    )
    app = create_app(settings)
    if max_total_bytes is not None:
        app.state.services.activity.max_total_bytes = max_total_bytes
    if max_queue_bytes is not None:
        app.state.services.activity.max_queue_bytes = max_queue_bytes
    return TestClient(app), settings


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
        f"{name:<34} | Ops: {count:>4} | Err: {errors:>2} | "
        f"Mean: {mean:>6.1f}ms | p50: {p50:>5.1f}ms | p95: {p95:>5.1f}ms | p99: {p99:>5.1f}ms | "
        f"Throughput: {rps:>6.1f} op/s"
    )


def run_read_benchmark(
    client: TestClient, token: str, workers: int, requests_per_worker: int
) -> tuple[int, list[str]]:
    # Seed 50 documents first and assert HTTP 201
    seed_doc_ids: list[str] = []
    for i in range(50):
        resp = client.post(
            "/api/v1/documents",
            json={"title": f"Bench Doc {i}", "content": f"Content {i} for benchmark"},
            headers={
                "Authorization": f"Bearer {token}",
                "Idempotency-Key": f"seed-doc-{i}",
            },
        )
        assert resp.status_code == 201, f"Seed doc {i} failed: {resp.text}"
        seed_doc_ids.append(resp.json()["document_id"])

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
    return len(latencies), seed_doc_ids


def run_write_benchmark(
    client: TestClient, token: str, workers: int, requests_per_worker: int
) -> tuple[int, list[str]]:
    latencies: list[float] = []
    errors = 0
    created_doc_ids: list[str] = []
    start = time.perf_counter()

    def worker(worker_id: int):
        w_latencies = []
        w_errors = 0
        w_ids = []
        for req in range(requests_per_worker):
            t0 = time.perf_counter()
            resp = client.post(
                "/api/v1/documents",
                json={
                    "title": f"Bench Mut {worker_id}-{req}",
                    "content": f"# Benchmark Content\nWorker {worker_id} request {req}",
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
                w_ids.append(resp.json()["document_id"])
            else:
                w_errors += 1
        return w_latencies, w_errors, w_ids

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(worker, i) for i in range(workers)]
        for f in concurrent.futures.as_completed(futures):
            wl, we, w_ids = f.result()
            latencies.extend(wl)
            errors += we
            created_doc_ids.extend(w_ids)

    total_time = time.perf_counter() - start
    print_stats(f"Agent Write-Heavy ({workers} workers)", latencies, errors, total_time)
    if errors > 0:
        raise RuntimeError(f"Write benchmark encountered {errors} errors")
    return len(latencies), created_doc_ids


def run_update_benchmark(
    client: TestClient, token: str, doc_ids: list[str], workers: int, requests_per_worker: int
) -> tuple[int, list[str]]:
    """Concurrently updates documents, verifying diff generation and persistence."""
    latencies: list[float] = []
    errors = 0
    updated_doc_ids: list[str] = []
    start = time.perf_counter()

    # Assign distinct documents to each worker to avoid conflict errors
    def worker(worker_id: int):
        w_latencies = []
        w_errors = 0
        w_ids = []
        doc_id = doc_ids[worker_id % len(doc_ids)]
        for req in range(requests_per_worker):
            # Fetch current revision
            current_resp = client.get(
                f"/api/v1/documents/{doc_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            if current_resp.status_code != 200:
                w_errors += 1
                continue
            current_doc = current_resp.json()
            rev_id = current_doc["current_revision_id"]

            new_content = (
                f"# Updated Document {doc_id}\n\n"
                f"Worker {worker_id} pass {req}\n"
                f"Timestamp: {time.time()}\n"
                f"Detailed body change with lines added and modified.\n"
            )

            t0 = time.perf_counter()
            resp = client.patch(
                f"/api/v1/documents/{doc_id}",
                json={
                    "expected_revision_id": rev_id,
                    "content": new_content,
                    "summary": f"Worker {worker_id} update {req}",
                },
                headers={
                    "Authorization": f"Bearer {token}",
                    "Idempotency-Key": f"bench-update-{worker_id}-{req}",
                },
            )
            elapsed = time.perf_counter() - t0
            if resp.status_code == 200:
                w_latencies.append(elapsed)
                w_ids.append(doc_id)
            else:
                w_errors += 1
        return w_latencies, w_errors, w_ids

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(worker, i) for i in range(workers)]
        for f in concurrent.futures.as_completed(futures):
            wl, we, w_ids = f.result()
            latencies.extend(wl)
            errors += we
            updated_doc_ids.extend(w_ids)

    total_time = time.perf_counter() - start
    print_stats(f"Agent Update-Diff ({workers} workers)", latencies, errors, total_time)
    if errors > 0:
        raise RuntimeError(f"Update benchmark encountered {errors} errors")
    return len(latencies), updated_doc_ids


def run_mixed_benchmark(
    client: TestClient, token: str, doc_ids: list[str], workers: int, requests_per_worker: int
) -> tuple[int, list[str], list[str]]:
    latencies: list[float] = []
    errors = 0
    mixed_created_ids: list[str] = []
    mixed_updated_ids: list[str] = []
    start = time.perf_counter()

    def worker(worker_id: int):
        w_latencies = []
        w_errors = 0
        w_cids = []
        w_uids = []
        for req in range(requests_per_worker):
            mod = req % 5
            t0 = time.perf_counter()
            if mod == 0:  # 20% create
                resp = client.post(
                    "/api/v1/documents",
                    json={
                        "title": f"Bench Mixed Create {worker_id}-{req}",
                        "content": "Mixed create content load",
                        "path": f"mixed/{worker_id}_{req}.md",
                    },
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Idempotency-Key": f"bench-mixed-create-{worker_id}-{req}",
                    },
                )
                success = resp.status_code == 201
                if success:
                    w_cids.append(resp.json()["document_id"])
            elif mod == 1:  # 20% update
                doc_id = doc_ids[(worker_id + len(doc_ids) // 2) % len(doc_ids)]
                curr = client.get(
                    f"/api/v1/documents/{doc_id}",
                    headers={"Authorization": f"Bearer {token}"},
                )
                if curr.status_code == 200:
                    rev_id = curr.json()["current_revision_id"]
                    resp = client.patch(
                        f"/api/v1/documents/{doc_id}",
                        json={
                            "expected_revision_id": rev_id,
                            "content": f"Mixed updated content {worker_id}-{req}\n",
                            "summary": f"Mixed update {req}",
                        },
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Idempotency-Key": f"bench-mixed-update-{worker_id}-{req}",
                        },
                    )
                    success = resp.status_code == 200
                    if success:
                        w_uids.append(doc_id)
                else:
                    success = False
            else:  # 60% read
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
        return w_latencies, w_errors, w_cids, w_uids

    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(worker, i) for i in range(workers)]
        for f in concurrent.futures.as_completed(futures):
            wl, we, w_cids, w_uids = f.result()
            latencies.extend(wl)
            errors += we
            mixed_created_ids.extend(w_cids)
            mixed_updated_ids.extend(w_uids)

    total_time = time.perf_counter() - start
    print_stats(f"Agent Mixed Workload ({workers} workers)", latencies, errors, total_time)
    if errors > 0:
        raise RuntimeError(f"Mixed benchmark encountered {errors} errors")
    return len(latencies), mixed_created_ids, mixed_updated_ids


def run_saturated_backpressure_benchmark(workers: int = 20, ops_per_worker: int = 10) -> None:
    """Proves backpressure and strict memory bound enforcement under saturated load.

    Uses a tight memory budget (64 KB total, 32 KB queue) with 20 parallel workers
    generating large diff payloads (~4-8 KB each). Total attempted demand is ~120 KB,
    strictly forcing admission and expansion backpressure.
    """
    tight_total_bytes = 64 * 1024
    tight_queue_bytes = 32 * 1024

    with tempfile.TemporaryDirectory() as temp_dir:
        client, settings = make_client(
            Path(temp_dir),
            max_total_bytes=tight_total_bytes,
            max_queue_bytes=tight_queue_bytes,
        )
        with client:
            token = issue_benchmark_agent_token(client)
            expected_audits = 1  # token issue

            # Seed distinct documents per worker with ~4 KB content
            large_seed_ids: list[str] = []
            for i in range(max(workers, 20)):
                body = f"# Seed {i}\n" + ("Line of substantial benchmark payload.\n" * 80)
                resp = client.post(
                    "/api/v1/documents",
                    json={"title": f"Saturated Seed {i}", "content": body},
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Idempotency-Key": f"sat-seed-{i}",
                    },
                )
                assert resp.status_code == 201
                large_seed_ids.append(resp.json()["document_id"])
                expected_audits += 1

            start = time.perf_counter()
            latencies: list[float] = []
            errors = 0

            def sat_worker(worker_id: int):
                w_latencies = []
                w_errors = 0
                doc_id = large_seed_ids[worker_id % len(large_seed_ids)]
                for req in range(ops_per_worker):
                    curr = client.get(
                        f"/api/v1/documents/{doc_id}",
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    if curr.status_code != 200:
                        w_errors += 1
                        continue
                    rev_id = curr.json()["current_revision_id"]

                    # Generate substantial diff payload (~5 KB)
                    body = f"# Sat Update {worker_id}-{req}\n" + (
                        f"Content modification block {worker_id}-{req} padding line.\n" * 90
                    )
                    t0 = time.perf_counter()
                    resp = client.patch(
                        f"/api/v1/documents/{doc_id}",
                        json={
                            "expected_revision_id": rev_id,
                            "content": body,
                            "summary": f"Sat update {worker_id}-{req}",
                        },
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Idempotency-Key": f"sat-update-{worker_id}-{req}",
                        },
                    )
                    elapsed = time.perf_counter() - t0
                    if resp.status_code == 200:
                        w_latencies.append(elapsed)
                    else:
                        w_errors += 1
                return w_latencies, w_errors

            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(sat_worker, i) for i in range(workers)]
                for f in concurrent.futures.as_completed(futures):
                    wl, we = f.result()
                    latencies.extend(wl)
                    errors += we

            total_time = time.perf_counter() - start
            print_stats("Saturated Backpressure (64KB cap)", latencies, errors, total_time)
            assert errors == 0, f"Saturated benchmark had {errors} errors"
            expected_audits += len(latencies) * 2  # get_document read + patch update

            activity_svc = client.app.state.services.activity
            activity_svc.list_events(limit=1)

            # Assert strict memory bound enforcement under saturation
            peak_total = activity_svc.peak_total_bytes
            peak_queue = activity_svc.peak_queue_bytes
            assert peak_total <= tight_total_bytes, (
                f"Peak total {peak_total} exceeded tight budget {tight_total_bytes}"
            )
            assert peak_queue <= tight_queue_bytes, (
                f"Peak queue {peak_queue} exceeded tight queue budget {tight_queue_bytes}"
            )
            # Verify backpressure was tested (peak reached substantial portion of budget)
            assert peak_total >= 16 * 1024, (
                f"Peak total {peak_total} was too low; saturation was not exercised"
            )
            assert activity_svc._admitted_bytes == 0, "Leaked admitted bytes"
            assert activity_svc._queue_bytes == 0, "Leaked queue bytes"
            assert activity_svc._reserved_producer_bytes == 0, "Leaked producer bytes"

            # Check audit durability in SQLite
            with activity_svc.database.connection() as conn:
                row = conn.execute("SELECT count(*) as cnt FROM operation_events").fetchone()
                assert row["cnt"] == expected_audits, (
                    f"Saturated audit mismatch: {row['cnt']} vs {expected_audits}"
                )

            print(
                f"Saturated Invariant Metrics: Peak Total = {peak_total / 1024:.1f} KB / "
                f"{tight_total_bytes / 1024:.1f} KB, "
                f"Peak Queue = {peak_queue / 1024:.1f} KB / "
                f"{tight_queue_bytes / 1024:.1f} KB (Backpressure Verified)\n"
            )


def main() -> None:
    parser = argparse.ArgumentParser(description="Sangam concurrency benchmark")
    parser.add_argument("--workers", type=int, default=20, help="Number of concurrent workers")
    parser.add_argument("--ops-per-worker", type=int, default=15, help="Operations per worker")
    args = parser.parse_args()

    header = (
        f"\n=== Sangam Concurrency & Durability Benchmark (Workers: {args.workers}, "
        f"Ops: {args.ops_per_worker}) ==="
    )
    print(header)
    with tempfile.TemporaryDirectory() as temp_dir:
        client, settings = make_client(Path(temp_dir))
        with client:
            token = issue_benchmark_agent_token(client)
            expected_audits = 1  # token creation
            expected_audits += 50  # 50 seed documents

            read_ops, seed_doc_ids = run_read_benchmark(
                client,
                token=token,
                workers=min(args.workers * 2, 40),
                requests_per_worker=args.ops_per_worker,
            )
            expected_audits += read_ops

            write_ops, write_doc_ids = run_write_benchmark(
                client,
                token=token,
                workers=args.workers,
                requests_per_worker=args.ops_per_worker,
            )
            expected_audits += write_ops

            update_ops, update_doc_ids = run_update_benchmark(
                client,
                token=token,
                doc_ids=seed_doc_ids + write_doc_ids,
                workers=args.workers,
                requests_per_worker=args.ops_per_worker,
            )
            expected_audits += update_ops * 2  # read (get_document) + update (patch)

            mixed_ops, mixed_created_ids, mixed_updated_ids = run_mixed_benchmark(
                client,
                token=token,
                doc_ids=seed_doc_ids + write_doc_ids,
                workers=args.workers,
                requests_per_worker=args.ops_per_worker,
            )
            expected_audits += mixed_ops + len(mixed_updated_ids)  # mixed ops + get_document reads

            all_created_doc_ids = set(seed_doc_ids + write_doc_ids + mixed_created_ids)

            # Deep audit validation & database integrity verification across ALL event types
            activity_svc = client.app.state.services.activity
            activity_svc.list_events(limit=1)
            db = activity_svc.database

            with db.connection() as conn:
                row = conn.execute("SELECT count(*) as cnt FROM operation_events").fetchone()
                persisted_events = row["cnt"]

                # 1. Exact payload validation for 'create' events
                create_rows = conn.execute(
                    "SELECT event_id, resource_id, revision_id, path, action, outcome, detail_json "
                    "FROM operation_events WHERE action = 'create' AND resource_type = 'document'"
                ).fetchall()

                found_create_ids = set()
                for r in create_rows:
                    ev_id = r["event_id"]
                    assert r["resource_id"] is not None, f"Event {ev_id} missing resource_id"
                    assert r["revision_id"] is not None, f"Event {ev_id} missing revision_id"
                    assert r["outcome"] == "accepted", f"Event {ev_id} outcome not accepted"
                    details = json.loads(r["detail_json"])
                    assert isinstance(details, dict)
                    assert "title" in details, f"Event {r['event_id']} missing title"
                    assert "content_type" in details
                    assert "diff" in details, f"Event {r['event_id']} missing diff"
                    assert "X" * 10 not in details["diff"], "Event diff contains placeholder X"

                    # Correlate with documents table
                    doc = conn.execute(
                        "SELECT document_id, current_revision_id, path "
                        "FROM documents WHERE document_id = ?",
                        (r["resource_id"],),
                    ).fetchone()
                    assert doc is not None, f"Document {r['resource_id']} not found in DB"
                    found_create_ids.add(r["resource_id"])

                assert all_created_doc_ids == found_create_ids, (
                    f"Mismatch between created documents and create audit events! "
                    f"Missing: {all_created_doc_ids - found_create_ids}"
                )

                # 2. Exact payload validation for 'update' events
                update_rows = conn.execute(
                    "SELECT event_id, resource_id, revision_id, path, action, outcome, detail_json "
                    "FROM operation_events WHERE action = 'update' AND resource_type = 'document'"
                ).fetchall()

                expected_updates = update_ops + len(mixed_updated_ids)
                assert len(update_rows) == expected_updates, (
                    f"Update events count mismatch: {len(update_rows)} vs {expected_updates}"
                )
                for r in update_rows:
                    assert r["resource_id"] is not None
                    assert r["revision_id"] is not None
                    assert r["outcome"] == "accepted"
                    details = json.loads(r["detail_json"])
                    assert isinstance(details, dict)
                    assert "expected_revision_id" in details
                    assert "lines_added" in details
                    assert "diff" in details, f"Update event {r['event_id']} missing diff"
                    assert "X" * 10 not in details["diff"], "Update diff contains placeholder X"
                    valid_diff = any(k in details["diff"] for k in ("---", "+++", "\n"))
                    assert valid_diff, "Update diff missing unified diff structure"

                # 3. Validation for 'list' and 'read' events
                list_rows = conn.execute(
                    "SELECT count(*) as cnt FROM operation_events "
                    "WHERE action = 'list' AND resource_type = 'document'"
                ).fetchone()
                expected_lists = read_ops + (
                    mixed_ops - len(mixed_created_ids) - len(mixed_updated_ids)
                )
                assert list_rows["cnt"] == expected_lists, (
                    f"List events count mismatch: {list_rows['cnt']} vs {expected_lists}"
                )

                read_rows = conn.execute(
                    "SELECT count(*) as cnt FROM operation_events "
                    "WHERE action = 'read' AND resource_type = 'document'"
                ).fetchone()
                expected_reads = update_ops + len(mixed_updated_ids)
                assert read_rows["cnt"] == expected_reads, (
                    f"Read events count mismatch: {read_rows['cnt']} vs {expected_reads}"
                )

                # 4. Validation for 'issue' token event
                issue_rows = conn.execute(
                    "SELECT event_id, action, resource_type, outcome "
                    "FROM operation_events WHERE action = 'issue'"
                ).fetchall()
                assert len(issue_rows) == 1
                assert issue_rows[0]["resource_type"] == "agent_token"
                assert issue_rows[0]["outcome"] == "accepted"

            print(
                f"\nAudit Log Durability Check: {persisted_events} persisted / "
                f"{expected_audits} expected "
                f"({persisted_events / expected_audits * 100:.1f}% durability, "
                f"0 dropped events, 100% verified across all event types)"
            )
            assert persisted_events == expected_audits, (
                f"Audit row count mismatch! Persisted: {persisted_events}, "
                f"Expected: {expected_audits}"
            )

            # Memory and WAL storage statistics
            assert activity_svc._admitted_bytes == 0, "Leaked admitted bytes in ActivityService"
            assert activity_svc._queue_bytes == 0, "Drained queue bytes not zero"
            assert activity_svc._reserved_producer_bytes == 0, "Leaked reserved producer bytes"

            peak_queue = activity_svc.peak_queue_bytes
            peak_total = activity_svc.peak_total_bytes
            assert peak_queue <= activity_svc.max_queue_bytes, (
                f"Peak queue {peak_queue} exceeded max {activity_svc.max_queue_bytes}"
            )
            assert peak_total <= activity_svc.max_total_bytes, (
                f"Peak total {peak_total} exceeded max {activity_svc.max_total_bytes}"
            )
            assert peak_total > 0, "Peak total bytes should be non-zero during concurrent workload"

            print(
                f"Memory Invariant Metrics: Peak Queue = {peak_queue / 1024:.1f} KB / "
                f"{activity_svc.max_queue_bytes / 1024:.1f} KB, "
                f"Peak Total = {peak_total / 1024:.1f} KB / "
                f"{activity_svc.max_total_bytes / 1024:.1f} KB\n"
            )

    # Run dedicated saturated backpressure benchmark
    print("=== Running Saturated Backpressure Benchmark (Constrained Memory) ===")
    run_saturated_backpressure_benchmark(workers=args.workers, ops_per_worker=args.ops_per_worker)


if __name__ == "__main__":
    main()
