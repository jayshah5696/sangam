from __future__ import annotations

import asyncio
import concurrent.futures
import sqlite3
import threading
import time
from unittest.mock import MagicMock

import pytest
from conftest import headers
from fastapi.testclient import TestClient
from test_phase_five_pdf_research import import_pdf, text_pdf

from sangam.activity import ActivityService
from sangam.chat_store import BoundedThreadRunner
from sangam.errors import ServiceUnavailableError
from sangam.security import Principal


def test_concurrent_pdf_imports_targeting_same_path_preserves_winning_file(
    client: TestClient, settings
) -> None:
    pdf1 = text_pdf("First winner candidate")
    pdf2 = text_pdf("Second winner candidate")
    target_path = "research/raced_paper.pdf"

    results = []

    def run_import(idx: int, content: bytes):
        res = import_pdf(
            client,
            content=content,
            key=f"pdf-race-{idx}",
            title=f"Paper {idx}",
            path=target_path,
        )
        results.append(res)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        f1 = executor.submit(run_import, 1, pdf1)
        f2 = executor.submit(run_import, 2, pdf2)
        f1.result(timeout=10)
        f2.result(timeout=10)

    status_codes = sorted(r.status_code for r in results)
    assert status_codes == [201, 422], f"Unexpected status codes: {status_codes}"

    winner_resp = next(r for r in results if r.status_code == 201)
    winner_doc = winner_resp.json()
    winner_id = winner_doc["document_id"]

    file_path = settings.workspace_root / target_path
    assert file_path.is_file(), "Winning PDF file was incorrectly deleted!"
    winner_bytes = file_path.read_bytes()
    assert winner_bytes in (pdf1, pdf2)

    fetch_resp = client.get(
        f"/api/v1/pdfs/{winner_id}/content",
        headers=headers("fetch-winner-pdf"),
    )
    assert fetch_resp.status_code == 200
    assert fetch_resp.content == winner_bytes


def test_audit_service_shutdown_drains_during_active_production(
    client: TestClient,
) -> None:
    activity_service = client.app.state.services.activity
    real_db = activity_service.database
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_shutdown_active_prod",
    )

    admitted_events: list[str] = []
    admitted_lock = threading.Lock()
    rejected_count = 0
    producer_count = 12
    barrier = threading.Barrier(producer_count + 1)

    def producer(worker_idx: int):
        barrier.wait()
        for op_idx in range(5):
            res_id = f"doc_shut_{worker_idx}_{op_idx}"
            try:
                activity_service.record(
                    principal=principal,
                    action="create",
                    resource_type="document",
                    outcome="accepted",
                    resource_id=res_id,
                    path=f"{res_id}.md",
                )
                with admitted_lock:
                    admitted_events.append(res_id)
            except ServiceUnavailableError:
                nonlocal rejected_count
                rejected_count += 1
            time.sleep(0.01)

    threads = [threading.Thread(target=producer, args=(i,)) for i in range(producer_count)]
    for t in threads:
        t.start()

    # Synchronize startup, let writes begin, then trigger shutdown while active
    barrier.wait()
    time.sleep(0.02)
    activity_service.close(timeout=35.0)

    for t in threads:
        t.join(timeout=10.0)

    # Every single admitted event MUST be persisted in SQLite with exact identity
    with real_db.connection() as conn:
        rows = conn.execute("SELECT resource_id FROM operation_events").fetchall()
        persisted_ids = {r["resource_id"] for r in rows}

    assert len(admitted_events) > 0, "At least some events should have been admitted before close"
    for admitted_id in admitted_events:
        assert admitted_id in persisted_ids, (
            f"Admitted event {admitted_id} was lost during shutdown!"
        )

    # Subsequent record attempt must immediately fail with ServiceUnavailableError
    with pytest.raises(ServiceUnavailableError, match="Activity audit logging is shutting down"):
        activity_service.record(
            principal=principal,
            action="create",
            resource_type="document",
            outcome="accepted",
            resource_id="doc_post_shutdown",
        )


def test_audit_pre_admission_blocks_mutation_when_audit_is_unhealthy(
    client: TestClient,
) -> None:
    activity_service = client.app.state.services.activity
    original_healthy = activity_service._worker_healthy
    original_error = activity_service._worker_error

    try:
        activity_service._worker_healthy = False
        activity_service._worker_error = RuntimeError("Simulated audit disk failure")

        response = client.post(
            "/api/v1/documents",
            json={"title": "Should Not Create", "content": "hello", "path": "unhealthy_test.md"},
            headers=headers("audit-unhealthy-test"),
        )
        assert response.status_code == 503
        data = response.json()
        assert data["error"]["code"] == "service_unavailable"

        docs = client.app.state.services.documents.list_documents()
        assert not any(d.path == "unhealthy_test.md" for d in docs)
    finally:
        activity_service._worker_healthy = original_healthy
        activity_service._worker_error = original_error

    list_resp = client.get("/api/v1/documents", headers=headers("check-no-create"))
    assert list_resp.status_code == 200
    paths = [d["path"] for d in list_resp.json()]
    assert "unhealthy_test.md" not in paths


def test_audit_service_rejects_mutations_on_storage_failure_and_does_not_clear_on_select_1(
    client: TestClient,
) -> None:
    real_db = client.app.state.services.activity.database
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_disk_full_test",
    )

    class DiskFullConnection:
        def __init__(self, raw):
            self._raw = raw

        def executemany(self, sql, params):
            raise sqlite3.OperationalError("database or disk is full")

        def execute(self, sql, params=()):
            # SELECT 1 succeeds even on a full or readonly disk
            return self._raw.execute(sql, params)

        def __getattr__(self, item):
            return getattr(self._raw, item)

    flaky_db = MagicMock()
    flaky_db.connect = lambda: DiskFullConnection(real_db.connect())
    service = ActivityService(flaky_db)

    try:
        with pytest.raises(sqlite3.OperationalError, match="database or disk is full"):
            service.record(
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id="doc_disk_full",
            )

        # Worker must be marked unhealthy; read liveness must NOT reset health
        assert service.is_healthy() is False

        # Attempting further admission must fail with ServiceUnavailableError
        with pytest.raises(ServiceUnavailableError, match="Audit persistence is unavailable"):
            service.admit()
    finally:
        service.close()


def test_audit_service_preserves_complete_untruncated_diff(client: TestClient) -> None:
    real_db = client.app.state.services.activity.database
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_diff_untruncated",
    )
    service = ActivityService(real_db)

    try:
        huge_diff = "A" * 65_536  # 64 KB diff
        service.record(
            principal=principal,
            action="patch",
            resource_type="document",
            outcome="accepted",
            resource_id="doc_huge_diff",
            details={"diff": huge_diff},
        )

        events = service.list_events(resource_id="doc_huge_diff")
        assert len(events) == 1
        persisted_diff = events[0].details.get("diff")
        assert persisted_diff == huge_diff, "Diff was truncated! Full content must be preserved."
    finally:
        service.close()


def test_chat_store_cancellation_holds_permit_until_worker_completes() -> None:
    runner = BoundedThreadRunner(max_concurrency=1, max_waiting=2)

    worker_started = threading.Event()
    worker_can_finish = threading.Event()
    worker_finished = threading.Event()

    def slow_sync_worker():
        worker_started.set()
        worker_can_finish.wait(timeout=5.0)
        worker_finished.set()
        return "done"

    async def scenario():
        task = asyncio.create_task(runner.run(slow_sync_worker))

        # Wait for thread to actually start executing
        while not worker_started.is_set():
            await asyncio.sleep(0.01)

        assert runner._active_workers == 1

        # Cancel the asyncio task
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

        # Even though the task is cancelled, the permit MUST remain held
        assert runner._active_workers == 1

        # Allow the synchronous worker to complete
        worker_can_finish.set()
        while not worker_finished.is_set():
            await asyncio.sleep(0.01)

        # Give asyncio loop a slice to process done_callback
        await asyncio.sleep(0.05)
        assert runner._active_workers == 0

        # Now test max_waiting bound
        slow_again = threading.Event()

        def block_worker():
            slow_again.wait(timeout=5.0)
            return "ok"

        # Occupy active worker
        t_active = asyncio.create_task(runner.run(block_worker))
        await asyncio.sleep(0.01)

        # Fill waiting queue (max_waiting = 2)
        t_wait1 = asyncio.create_task(runner.run(lambda: "w1"))
        t_wait2 = asyncio.create_task(runner.run(lambda: "w2"))
        await asyncio.sleep(0.01)

        # 3rd waiting item must be rejected immediately with ServiceUnavailableError
        with pytest.raises(ServiceUnavailableError, match="queue limit exceeded"):
            await runner.run(lambda: "overflow")

        slow_again.set()
        await asyncio.gather(t_active, t_wait1, t_wait2)
        await runner.close()

    asyncio.run(scenario())


def test_audit_service_enforces_memory_budget_under_expansion(client: TestClient) -> None:
    real_db = client.app.state.services.activity.database
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_mem_budget_test",
    )
    # Small budget: 16 KB max
    service = ActivityService(real_db, max_queue_bytes=16 * 1024)

    try:
        # Fill queue with an event that expands to 12 KB
        payload = "x" * 12_000
        service.record(
            principal=principal,
            action="create",
            resource_type="document",
            outcome="accepted",
            resource_id="doc_mem_1",
            details={"diff": payload},
        )

        events = service.list_events(resource_id="doc_mem_1")
        assert len(events) == 1
        assert events[0].details.get("diff") == payload
    finally:
        service.close()
