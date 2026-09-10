# Performance & Latency Benchmarks

Verifiable behavior is not limited to functional correctness. For self-hosted systems like Sangam, non-functional invariants—write throughput, FTS5 search latency under load, and cold-boot readiness—must also be empirically proven and compared against performance budgets.

## Sub-features

- `perf-readiness-latency`: Measures cold and warm response times for `/api/v1/readiness`.
- `perf-write-throughput`: Asserts document persistence rate (writes/sec) and write latency percentiles (p50, p95).
- `perf-search-latency`: Asserts full-text search query response time (searches/sec, p50, p95) under active database load.
- `perf-db-consistency`: Confirms that the number of written records in SQLite exactly matches completed client requests.

## How to get to it (user POV)

- Run `./scripts/control-sangam.sh benchmark [COUNT]` from the repository root.
- Check saved metrics in `artifacts/verify-sangam/<RUN_ID>/benchmark.json`.

## Driving it with control-sangam

Preconditions:
- Clean isolated instance launched with `./scripts/control-sangam.sh launch [PORT]`.
- System is idle (no conflicting heavy background builds).

### Benchmark Execution

Run 50 iterations:
```bash
./scripts/control-sangam.sh benchmark 50
```

### Performance Budgets (Thresholds)

| Metric | Target Budget | Warning | Failure |
| :--- | :--- | :--- | :--- |
| **Readiness Latency** | < 15ms | > 30ms | > 100ms |
| **Write Latency (p50)** | < 25ms | > 50ms | > 150ms |
| **Write Latency (p95)** | < 45ms | > 80ms | > 250ms |
| **FTS5 Search (p50)** | < 10ms | > 20ms | > 50ms |
| **FTS5 Search (p95)** | < 20ms | > 35ms | > 100ms |
| **DB Consistency** | 100% match | N/A | Any dropped write |

### Evidence Artifact

The benchmark writes `benchmark.json` to the run's artifact directory:
```json
{
  "benchmark_count": 50,
  "readiness_latency_ms": 9.77,
  "writes": {
    "count": 50,
    "total_time_seconds": 0.85,
    "writes_per_second": 58.8,
    "latency_ms": {
      "p50": 16.5,
      "p90": 21.2,
      "p95": 23.4,
      "p99": 28.1
    }
  },
  "fts5_search": {
    "count": 50,
    "total_time_seconds": 0.31,
    "searches_per_second": 161.2,
    "latency_ms": {
      "p50": 5.8,
      "p90": 9.4,
      "p95": 11.2,
      "p99": 14.0
    }
  },
  "database_verification": {
    "persisted_documents_in_sqlite": 50,
    "match_expected": true
  }
}
```

## Gotchas

- SQLite WAL checkpointing can introduce slight latency variance on the 1000th page write. Check `PRAGMA wal_checkpoint(PASSIVE);` if testing thousands of writes.
- Do not benchmark in debug/profiler mode, as tracing hooks will artificially inflate latency figures.
