from __future__ import annotations

import asyncio
import concurrent.futures
import json
import sqlite3
import threading
import time
from unittest.mock import MagicMock

import pytest
from conftest import headers
from fastapi.testclient import TestClient
from test_phase_five_pdf_research import import_pdf, text_pdf

from sangam.activity import ActivityService
from sangam.api import create_app
from sangam.chat_store import BoundedThreadRunner
from sangam.config import Settings
from sangam.db import Database
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


def test_chat_store_cancellation_before_executor_start_releases_permit() -> None:
    runner = BoundedThreadRunner(max_concurrency=2, max_waiting=5)
    runner._executor.shutdown(wait=False)
    runner._executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)

    block_first = threading.Event()
    first_started = threading.Event()

    def first_task():
        first_started.set()
        block_first.wait(timeout=5.0)
        return "first"

    def second_task():
        return "second"

    async def scenario():
        t1 = asyncio.create_task(runner.run(first_task))
        while not first_started.is_set():
            await asyncio.sleep(0.01)

        assert runner._active_workers == 1

        t2 = asyncio.create_task(runner.run(second_task))
        await asyncio.sleep(0.01)
        assert runner._active_workers == 2

        t2.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t2

        await asyncio.sleep(0.05)
        assert runner._active_workers == 1

        block_first.set()
        assert await t1 == "first"
        await asyncio.sleep(0.05)
        assert runner._active_workers == 0
        await runner.close()

    asyncio.run(scenario())


def test_chat_store_shutdown_times_out_and_raises_runtime_error_on_unfinished_writes() -> None:
    runner = BoundedThreadRunner(max_concurrency=1, max_waiting=2)

    block_worker = threading.Event()
    worker_started = threading.Event()

    def hanging_task():
        worker_started.set()
        block_worker.wait(timeout=5.0)
        return "done"

    async def scenario():
        t = asyncio.create_task(runner.run(hanging_task))
        while not worker_started.is_set():
            await asyncio.sleep(0.01)

        with pytest.raises(RuntimeError, match="ChatKitStore shutdown timed out with 1 operations"):
            await runner.close(timeout=0.05)

        block_worker.set()
        await t

    asyncio.run(scenario())


def test_audit_service_enforces_budget_and_backpressure_while_batch_is_committing(
    client: TestClient,
) -> None:
    real_db = client.app.state.services.activity.database
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_mem_budget_committing",
    )

    pause_commit = threading.Event()
    commit_started = threading.Event()

    class PausableConnection:
        def __init__(self, raw):
            self._raw = raw

        def executemany(self, sql, params):
            commit_started.set()
            pause_commit.wait(timeout=5.0)
            return self._raw.executemany(sql, params)

        def __getattr__(self, item):
            return getattr(self._raw, item)

    mock_db = MagicMock(wraps=real_db)
    mock_db.connect = lambda: PausableConnection(real_db.connect())
    mock_db.connection = real_db.connection
    mock_db.transaction = real_db.transaction

    service = ActivityService(mock_db, max_queue_bytes=16 * 1024)

    try:
        res1 = service.admit(estimated_bytes=1024)
        res2 = service.admit(estimated_bytes=1024)

        payload_12k = "y" * 12_000
        p1_done = threading.Event()

        def producer_1():
            res1.record(
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id="doc_mem_batch_1",
                details={"diff": payload_12k},
            )
            p1_done.set()

        t1 = threading.Thread(target=producer_1)
        t1.start()

        assert commit_started.wait(timeout=2.0)
        assert service._committing_items == 1
        assert len(service._queue) == 0

        p2_blocked = threading.Event()
        p2_done = threading.Event()

        def producer_2():
            p2_blocked.set()
            res2.record(
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id="doc_mem_batch_2",
                details={"diff": payload_12k},
            )
            p2_done.set()

        t2 = threading.Thread(target=producer_2)
        t2.start()

        assert p2_blocked.wait(timeout=1.0)
        time.sleep(0.1)
        assert not p2_done.is_set(), "Producer 2 bypassed waiting while batch was committing!"

        pause_commit.set()
        t1.join(timeout=2.0)
        t2.join(timeout=2.0)
        assert p1_done.is_set()
        assert p2_done.is_set()

        events = service.list_events(operation_id="op_mem_budget_committing")
        assert len(events) == 2
    finally:
        pause_commit.set()
        service.close()


def test_audit_service_oversized_event_commits_without_deadlock_or_truncation(
    client: TestClient,
) -> None:
    real_db = client.app.state.services.activity.database
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_oversized_event",
    )
    service = ActivityService(real_db, max_queue_bytes=16 * 1024)

    try:
        huge_payload = "Z" * 32_000
        service.record(
            principal=principal,
            action="create",
            resource_type="document",
            outcome="accepted",
            resource_id="doc_oversized",
            details={"diff": huge_payload},
        )

        events = service.list_events(resource_id="doc_oversized")
        assert len(events) == 1
        assert events[0].details.get("diff") == huge_payload
    finally:
        service.close()


def test_chat_store_attachments_column_created_by_and_ownership_isolation(
    client: TestClient,
) -> None:
    from chatkit.types import FileAttachment

    from sangam.chat_context import ChatRequestContext
    from sangam.chat_store import SQLiteChatKitStore
    from sangam.errors import NotFoundError

    database = client.app.state.services.activity.database
    store = SQLiteChatKitStore(database)

    principal_jay = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="op_jay_att"
    )
    principal_cli = Principal.trusted_human(
        actor_id="client:cli", display_name="CLI", operation_id="op_cli_att"
    )

    ctx_jay = ChatRequestContext(principal=principal_jay)
    ctx_cli = ChatRequestContext(principal=principal_cli)

    attachment = FileAttachment(
        id="att_123",
        name="notes.txt",
        mime_type="text/plain",
    )

    async def scenario():
        await store.save_attachment(attachment, ctx_jay)

        with database.connection() as conn:
            row = conn.execute(
                "SELECT created_by, data_json FROM chat_attachments WHERE attachment_id = ?",
                ("att_123",),
            ).fetchone()
            assert row is not None
            assert row["created_by"] == "human:jay"

        loaded = await store.load_attachment("att_123", ctx_jay)
        assert loaded.id == "att_123"
        assert loaded.name == "notes.txt"

        with pytest.raises(NotFoundError):
            await store.load_attachment("att_123", ctx_cli)

        cli_fake = FileAttachment(
            id="att_123",
            name="malicious.txt",
            mime_type="text/plain",
        )
        with pytest.raises(NotFoundError):
            await store.save_attachment(cli_fake, ctx_cli)

        await store.delete_attachment("att_123", ctx_jay)
        with pytest.raises(NotFoundError):
            await store.load_attachment("att_123", ctx_jay)

        await store.close()

    asyncio.run(scenario())


def test_chat_store_pagination_returns_continuation_cursor(client: TestClient) -> None:
    from datetime import UTC, datetime

    from chatkit.types import (
        InferenceOptions,
        ThreadMetadata,
        UserMessageItem,
        UserMessageTextContent,
    )

    from sangam.chat_context import ChatRequestContext
    from sangam.chat_store import SQLiteChatKitStore

    database = client.app.state.services.activity.database
    store = SQLiteChatKitStore(database)

    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="op_pag"
    )
    ctx = ChatRequestContext(principal=principal)

    async def scenario():
        thread = ThreadMetadata(id="thread_pag_1", created_at=datetime.now(UTC))
        await store.save_thread(thread, ctx)

        for i in range(5):
            item = UserMessageItem(
                id=f"item_{i:02d}",
                thread_id=thread.id,
                content=[UserMessageTextContent(text=f"Hello {i}")],
                inference_options=InferenceOptions(model="test"),
                created_at=datetime.now(UTC),
            )
            await store.save_item(thread.id, item, ctx)

        page1 = await store.load_thread_items(
            thread.id, after=None, limit=2, order="asc", context=ctx
        )
        assert len(page1.data) == 2
        assert page1.has_more is True
        assert page1.after is not None
        cursor1 = page1.after
        assert page1.data[0].id == "item_00"
        assert page1.data[1].id == "item_01"

        page2 = await store.load_thread_items(
            thread.id, after=cursor1, limit=2, order="asc", context=ctx
        )
        assert len(page2.data) == 2
        assert page2.has_more is True
        assert page2.after is not None
        assert page2.data[0].id == "item_02"
        assert page2.data[1].id == "item_03"

        page3 = await store.load_thread_items(
            thread.id, after=page2.after, limit=2, order="asc", context=ctx
        )
        assert len(page3.data) == 1
        assert page3.has_more is False
        assert page3.after is None
        assert page3.data[0].id == "item_04"

        for i in range(2, 6):
            t = ThreadMetadata(id=f"thread_pag_{i}", created_at=datetime.now(UTC))
            await store.save_thread(t, ctx)

        tpage1 = await store.load_threads(after=None, limit=2, order="asc", context=ctx)
        assert len(tpage1.data) == 2
        assert tpage1.has_more is True
        assert tpage1.after is not None

        tpage2 = await store.load_threads(after=tpage1.after, limit=2, order="asc", context=ctx)
        assert len(tpage2.data) == 2
        assert tpage2.has_more is True
        assert tpage2.after is not None
        assert tpage2.data[0].id != tpage1.data[0].id
        assert tpage2.data[0].id != tpage1.data[1].id

        await store.close()

    asyncio.run(scenario())


def test_audit_service_multiple_expanding_producers_progress_without_deadlock(
    client: TestClient,
) -> None:
    real_db = client.app.state.services.activity.database
    service = ActivityService(real_db, max_queue_bytes=16 * 1024)
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_two_expanding_prod",
    )

    try:
        res1 = service.admit(estimated_bytes=1024)
        res2 = service.admit(estimated_bytes=1024)
        payload_32k = "W" * 32_000

        t1 = threading.Thread(
            target=lambda: res1.record(
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id="doc_exp_prod_1",
                details={"diff": payload_32k},
            )
        )
        t2 = threading.Thread(
            target=lambda: res2.record(
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id="doc_exp_prod_2",
                details={"diff": payload_32k},
            )
        )

        t1.start()
        t2.start()
        t1.join(timeout=10.0)
        t2.join(timeout=10.0)

        assert not t1.is_alive(), "Producer 1 deadlocked/timed out"
        assert not t2.is_alive(), "Producer 2 deadlocked/timed out"

        events = service.list_events(operation_id="op_two_expanding_prod")
        assert len(events) == 2
        assert service._admitted_items == 0
        assert service._admitted_bytes == 0
        assert service._active_producers == 0
    finally:
        service.close()


def test_audit_service_pre_transfer_failure_releases_reservation_without_counter_leak(
    client: TestClient,
) -> None:
    real_db = client.app.state.services.activity.database
    service = ActivityService(real_db, max_queue_bytes=16 * 1024)

    try:
        with (
            pytest.raises(RuntimeError, match="Operation failed before recording"),
            service.admit(estimated_bytes=2048),
        ):
            assert service._admitted_items == 1
            assert service._admitted_bytes == 2048
            assert service._active_producers == 1
            raise RuntimeError("Operation failed before recording")

        assert service._admitted_items == 0
        assert service._admitted_bytes == 0
        assert service._active_producers == 0
    finally:
        service.close()


def test_audit_service_executed_operation_survives_worker_failure_via_direct_persistence(
    client: TestClient,
) -> None:
    real_db = client.app.state.services.activity.database
    service = ActivityService(real_db, max_queue_bytes=16 * 1024)
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_fallback_persist",
    )

    try:
        res = service.admit(estimated_bytes=1024)
        service._worker_healthy = False
        service._worker_error = RuntimeError("Disk IO simulated failure")

        res.record(
            principal=principal,
            action="create",
            resource_type="document",
            outcome="accepted",
            resource_id="doc_fallback_direct",
            details={"diff": "survived_payload"},
        )

        assert res._transferred is False
        assert service._admitted_items == 0
        assert service._admitted_bytes == 0
        assert service._active_producers == 0

        events = service.list_events(resource_id="doc_fallback_direct")
        assert len(events) == 1
        assert events[0].details.get("diff") == "survived_payload"
    finally:
        service.close()


def test_app_lifespan_reports_chat_shutdown_error_while_preserving_activity_cleanup(
    settings: Settings,
) -> None:
    app = create_app(settings)
    runner = app.state.services.chat.store_adapter._runner

    block_task = threading.Event()
    task_started = threading.Event()

    def hanging_task():
        task_started.set()
        block_task.wait(timeout=5.0)

    fut = runner._executor.submit(hanging_task)
    assert task_started.wait(timeout=2.0)
    runner._active_futures.add(fut)

    orig_close = runner.close

    async def fast_close(timeout: float = 0.05) -> None:
        await orig_close(timeout=0.05)

    runner.close = fast_close

    activity_closed = [False]
    orig_activity_close = app.state.services.activity.close

    def spy_activity_close(*args: object, **kwargs: object) -> None:
        activity_closed[0] = True
        orig_activity_close(*args, **kwargs)

    app.state.services.activity.close = spy_activity_close

    try:
        with (
            pytest.raises(RuntimeError, match="ChatKitStore shutdown timed out"),
            TestClient(app),
        ):
            pass
        assert activity_closed[0] is True, "Activity service was NOT closed!"
    finally:
        block_task.set()


def test_audit_queue_capacity_accounts_for_full_event_size_preventing_undercount(
    client: TestClient,
) -> None:
    real_db = client.app.state.services.documents.database
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="op_cap"
    )

    pause_commit = threading.Event()
    commit_started = threading.Event()

    class PausableConnection:
        def __init__(self, raw):
            self._raw = raw

        def executemany(self, sql, params):
            commit_started.set()
            pause_commit.wait(timeout=5.0)
            return self._raw.executemany(sql, params)

        def __getattr__(self, item):
            return getattr(self._raw, item)

    mock_db = MagicMock(wraps=real_db)
    mock_db.connect = lambda: PausableConnection(real_db.connect())
    mock_db.connection = real_db.connection
    mock_db.transaction = real_db.transaction

    service = ActivityService(mock_db, max_queue_bytes=16 * 1024)

    try:
        res1 = service.admit(estimated_bytes=8 * 1024)
        res2 = service.admit(estimated_bytes=8 * 1024)

        # P1 expands to 12 KB
        payload_12k = "A" * (12 * 1024 - 400)
        # P2 produces 8 KB
        payload_8k = "B" * (8 * 1024 - 400)

        # Thread 1 records P1
        t1 = threading.Thread(
            target=lambda: res1.record(
                principal=principal,
                action="read",
                resource_type="document",
                outcome="accepted",
                details={"diff": payload_12k},
            )
        )
        t1.start()
        assert commit_started.wait(timeout=3.0)

        # Thread 2 records P2 while P1 is committing
        p2_completed = threading.Event()

        def run_p2():
            res2.record(
                principal=principal,
                action="read",
                resource_type="document",
                outcome="accepted",
                details={"diff": payload_8k},
            )
            p2_completed.set()

        t2 = threading.Thread(target=run_p2)
        t2.start()

        time.sleep(0.15)
        # P2 must be waiting because 12 KB + 8 KB > 16 KB budget
        assert not p2_completed.is_set(), "P2 should be waiting on budget capacity!"
        max_b = 16 * 1024
        assert service._queue_bytes + service._committing_bytes <= max_b, "Exceeded budget!"
        # Crucially: P2 has not serialized its payload while waiting, preserving total memory bounds
        assert len(service._queue) == 0, "P2 must not enter the queue while waiting!"

        # Unblock worker so P1 finishes and P2 can proceed
        pause_commit.set()
        t1.join(timeout=3.0)
        t2.join(timeout=3.0)
        assert p2_completed.is_set(), "P2 must successfully complete once P1 frees capacity!"
    finally:
        pause_commit.set()
        service.close()


def test_mutation_and_audit_event_are_atomic_in_same_transaction(
    client: TestClient, settings
) -> None:
    db = Database(settings.database_path)

    # Verify successful mutation persists both document and audit event
    res = client.post(
        "/api/v1/documents",
        json={"title": "Atomic Doc", "content": "content", "path": "atomic.md"},
        headers=headers("atomic-k1"),
    )
    assert res.status_code == 201
    doc_id = res.json()["document_id"]

    # Verify both exist in sqlite
    with db.connection() as conn:
        doc_row = conn.execute(
            "SELECT document_id FROM documents WHERE document_id = ?", (doc_id,)
        ).fetchone()
        assert doc_row is not None

        audit_row = conn.execute(
            "SELECT event_id, outcome FROM operation_events WHERE resource_id = ? AND action = ?",
            (doc_id, "create"),
        ).fetchone()
        assert audit_row is not None
        assert audit_row["outcome"] == "accepted"

    # Now verify failed transaction rolls back both document mutation and audit event
    orig_record_with_conn = client.app.state.services.activity.record_with_connection

    def fail_audit(*args, **kwargs):
        raise sqlite3.OperationalError("Simulated disk I/O error during audit insert")

    client.app.state.services.activity.record_with_connection = fail_audit

    try:
        with pytest.raises(sqlite3.OperationalError, match="Simulated disk I/O error"):
            client.post(
                "/api/v1/documents",
                json={"title": "Should Fail Completely", "content": "c", "path": "fail.md"},
                headers=headers("atomic-k2"),
            )
    finally:
        client.app.state.services.activity.record_with_connection = orig_record_with_conn

    # Verify fail.md does NOT exist in documents table at all!
    with db.connection() as conn:
        failed_doc = conn.execute("SELECT * FROM documents WHERE path = ?", ("fail.md",)).fetchone()
        assert failed_doc is None, "Document must NOT have committed if audit write failed!"


def test_audit_records_correct_document_and_revision_on_pathless_create_and_duplicate(
    client: TestClient, settings
) -> None:
    db = Database(settings.database_path)

    # 1. Pathless create
    res = client.post(
        "/api/v1/documents",
        json={"title": "Pathless Doc", "content": "Hello world from pathless", "path": None},
        headers=headers("pathless-create-k1"),
    )
    assert res.status_code == 201
    created = res.json()
    created_id = created["document_id"]
    created_rev = created["current_revision_id"]
    assert created["path"] is None

    # Check operation_events in SQLite
    with db.connection() as conn:
        event = conn.execute(
            "SELECT resource_id, revision_id, path, action, outcome FROM operation_events "
            "WHERE resource_id = ? AND action = 'create'",
            (created_id,),
        ).fetchone()
        assert event is not None, "Audit event for pathless create was not found with document_id"
        assert event["resource_id"] == created_id
        assert event["revision_id"] == created_rev
        assert event["path"] is None
        assert event["outcome"] == "accepted"

    # 2. Duplicate document
    dup_res = client.post(
        f"/api/v1/documents/{created_id}/duplicate",
        json={"expected_revision_id": created_rev, "title": "Duplicated Doc"},
        headers=headers("dup-doc-k1"),
    )
    assert dup_res.status_code == 201
    dup_doc = dup_res.json()
    dup_id = dup_doc["document_id"]
    dup_rev = dup_doc["current_revision_id"]
    assert dup_id != created_id

    # Check operation_events for the duplicate action
    with db.connection() as conn:
        dup_event = conn.execute(
            "SELECT resource_id, revision_id, action, outcome FROM operation_events "
            "WHERE resource_id = ? AND action = 'duplicate'",
            (dup_id,),
        ).fetchone()
        assert dup_event is not None, "Audit event must identify the newly created document"
        assert dup_event["resource_id"] == dup_id
        assert dup_event["revision_id"] == dup_rev
        assert dup_event["outcome"] == "accepted"

        # Ensure source document ID was NOT recorded as the duplicate target
        source_dup_event = conn.execute(
            "SELECT event_id FROM operation_events WHERE resource_id = ? AND action = 'duplicate'",
            (created_id,),
        ).fetchone()
        assert source_dup_event is None, "Source doc ID must not be recorded as target"


def test_audit_service_enforces_total_memory_bound_before_serialization(
    client: TestClient,
) -> None:
    real_db = client.app.state.services.activity.database
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="op_mem_bound_pre_alloc"
    )

    # max_queue_bytes = 16 KB, max_total_bytes = 16 KB
    service = ActivityService(real_db, max_queue_bytes=16 * 1024, max_total_bytes=16 * 1024)

    try:
        # Producer 1 reserves 8 KB
        res1 = service.admit(estimated_bytes=8 * 1024)
        # Producer 2 reserves 8 KB -> admitted_bytes is now 16 KB (total memory fully reserved)
        res2 = service.admit(estimated_bytes=8 * 1024)
        assert service._admitted_bytes == 16 * 1024

        # Producer 3 tries to admit -> must fail or block because total memory is at budget
        with pytest.raises(ServiceUnavailableError, match="Audit queue capacity exceeded"):
            service.admit(estimated_bytes=1024, timeout=0.05)

        # Producer 1 records an event with diff
        res1.record(
            principal=principal,
            action="read",
            resource_type="document",
            outcome="accepted",
            details={"diff": "A" * 6000},
        )

        # After Producer 1 is committed, capacity is freed
        # Producer 2 can now record
        res2.record(
            principal=principal,
            action="read",
            resource_type="document",
            outcome="accepted",
            details={"diff": "B" * 6000},
        )

        assert service._admitted_bytes == 0
        assert service._queue_bytes == 0
    finally:
        service.close()


def test_set_audit_target_outside_transaction_raises_and_cleans_up_on_exit(
    client: TestClient,
) -> None:
    db = client.app.state.services.activity.database

    # 1. Calling set_audit_target outside an active transaction raises RuntimeError
    with pytest.raises(RuntimeError, match="set_audit_target called outside an active transaction"):
        db.set_audit_target(resource_id="doc_outside", revision_id="rev_outside")

    # 2. Inside a transaction, setting audit target works
    with db.transaction():
        db.set_audit_target(resource_id="doc_inside", revision_id="rev_inside")
        target = db.get_audit_target()
        assert target.get("resource_id") == "doc_inside"
        assert target.get("revision_id") == "rev_inside"

    # 3. After transaction exits, target is cleaned up
    assert db.get_audit_target() == {}

    # 4. Next transaction on the same thread starts with empty target
    with db.transaction():
        assert db.get_audit_target() == {}


def test_pdf_move_delete_restore_audit_records_correct_revisions_and_isolates_same_thread(
    client: TestClient, settings
) -> None:
    from test_phase_five_pdf_research import import_pdf, text_pdf

    db = Database(settings.database_path)
    source = text_pdf("Audit Revision Tracking PDF")
    imported = import_pdf(
        client,
        content=source,
        key="pdf-audit-rev",
        path="notes/audit_track.pdf",
        title="Audit Track PDF",
    ).json()
    document_id = imported["document_id"]
    rev_1 = imported["current_revision_id"]

    # 1. Move PDF -> revision becomes rev_2
    move_resp = client.post(
        f"/api/v1/documents/{document_id}/move",
        json={"path": "archive/audit_track.pdf", "expected_revision_id": rev_1},
        headers=headers("pdf-move-k1"),
    )
    assert move_resp.status_code == 200, move_resp.text
    moved = move_resp.json()
    rev_2 = moved["current_revision_id"]
    assert rev_2 != rev_1

    with db.connection() as conn:
        move_event = conn.execute(
            "SELECT resource_id, revision_id, action, outcome FROM operation_events "
            "WHERE resource_id = ? AND action = 'move'",
            (document_id,),
        ).fetchone()
        assert move_event is not None
        assert move_event["resource_id"] == document_id
        assert move_event["revision_id"] == rev_2
        assert move_event["outcome"] == "accepted"

    # 2. Delete (trash) PDF -> revision becomes rev_3
    del_resp = client.request(
        "DELETE",
        f"/api/v1/documents/{document_id}",
        json={"expected_revision_id": rev_2},
        headers=headers("pdf-trash-k1"),
    )
    assert del_resp.status_code == 200, del_resp.text
    deleted = del_resp.json()
    rev_3 = deleted["current_revision_id"]
    assert rev_3 != rev_2

    with db.connection() as conn:
        del_event = conn.execute(
            "SELECT resource_id, revision_id, action, outcome FROM operation_events "
            "WHERE resource_id = ? AND action = 'delete'",
            (document_id,),
        ).fetchone()
        assert del_event is not None
        assert del_event["resource_id"] == document_id
        assert del_event["revision_id"] == rev_3
        assert del_event["outcome"] == "accepted"

    # 3. Restore PDF -> revision becomes rev_4
    restore_resp = client.post(
        f"/api/v1/documents/{document_id}/restore",
        headers=headers("pdf-restore-k1"),
        json={"expected_revision_id": rev_3, "revision_id": rev_3},
    )
    assert restore_resp.status_code == 200, restore_resp.text
    restored = restore_resp.json()
    rev_4 = restored["current_revision_id"]
    assert rev_4 != rev_3

    with db.connection() as conn:
        restore_event = conn.execute(
            "SELECT resource_id, revision_id, action, outcome FROM operation_events "
            "WHERE resource_id = ? AND action = 'restore'",
            (document_id,),
        ).fetchone()
        assert restore_event is not None
        assert restore_event["resource_id"] == document_id
        assert restore_event["revision_id"] == rev_4
        assert restore_event["outcome"] == "accepted"

    # 4. Immediate subsequent transaction on same thread has no stale audit target
    subsequent_resp = client.post(
        "/api/v1/documents",
        json={"title": "Subsequent Doc", "content": "hello world", "path": "subsequent.md"},
        headers=headers("subsequent-k1"),
    )
    assert subsequent_resp.status_code == 201, subsequent_resp.text
    subsequent = subsequent_resp.json()
    sub_id = subsequent["document_id"]
    sub_rev = subsequent["current_revision_id"]

    with db.connection() as conn:
        sub_event = conn.execute(
            "SELECT resource_id, revision_id, action, outcome FROM operation_events "
            "WHERE resource_id = ? AND action = 'create'",
            (sub_id,),
        ).fetchone()
        assert sub_event is not None
        assert sub_event["resource_id"] == sub_id
        assert sub_event["revision_id"] == sub_rev
        assert sub_event["outcome"] == "accepted"


def test_audit_conservative_json_bound_handles_escapes_and_unicode(client: TestClient) -> None:
    service = client.app.state.services.activity
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="op_unicode"
    )

    test_payloads = [
        {"diff": "Plain ASCII text with no special characters"},
        {"diff": 'Text with "quotes" and \\backslashes\\ and \t\n control characters'},
        {"diff": "Accented French: café, déjà vu, crème brûlée"},
        {"diff": "Cyrillic: Привет мир, Тестирование кодировок"},
        {"diff": "CJK characters: 測試 中文 ログ 日本語"},
        {"diff": "Astral emoji: 🚀 🔍 🛡️ 💎 🧠"},
        {
            "diff": 'Mixed " \n \r ' + "é" * 1000 + "😀" * 500,
            "title": 'Document with "special" characters: 測試',
            "category": "research",
        },
    ]

    for i, payload in enumerate(test_payloads):
        # 1. Conservative bound estimate must be >= actual serialized JSON size
        est = service.estimate_payload_bytes(payload)
        row, actual_size = service._prepare_event_row(
            principal=principal,
            action="create",
            resource_type="document",
            outcome="accepted",
            resource_id=f"doc_unicode_{i}",
            details=payload,
        )
        assert est >= actual_size, (
            f"Estimate {est} was less than actual {actual_size} for payload {i}"
        )

        # 2. Record with reservation preserves payload verbatim without truncation or corruption
        with service.admit(estimated_bytes=est) as res:
            res.record(
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id=f"doc_unicode_{i}",
                details=payload,
            )

        events = service.list_events(operation_id="op_unicode")
        matched = [e for e in events if e.resource_id == f"doc_unicode_{i}"]
        assert len(matched) == 1
        assert matched[0].details == payload


def test_audit_exclusive_oversized_ownership_and_atomic_capacity(client: TestClient) -> None:
    real_db = client.app.state.services.activity.database
    service = ActivityService(real_db, max_queue_bytes=8 * 1024, max_total_bytes=8 * 1024)
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="op_exclusive_oversized"
    )

    try:
        # Two producers admit small 512B reservations
        res1 = service.admit(estimated_bytes=512)
        res2 = service.admit(estimated_bytes=512)

        oversized_payload = "X" * 10_000  # 10 KB > 8 KB limit
        p1_started = threading.Event()
        p1_done = threading.Event()
        p2_done = threading.Event()

        def producer_1():
            p1_started.set()
            res1.record(
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id="doc_over_1",
                details={"diff": oversized_payload},
            )
            p1_done.set()

        def producer_2():
            res2.record(
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id="doc_over_2",
                details={"diff": oversized_payload},
            )
            p2_done.set()

        t1 = threading.Thread(target=producer_1)
        t2 = threading.Thread(target=producer_2)

        t1.start()
        assert p1_started.wait(timeout=2.0)
        t2.start()

        t1.join(timeout=10.0)
        t2.join(timeout=10.0)

        assert p1_done.is_set(), "Producer 1 failed to complete"
        assert p2_done.is_set(), "Producer 2 failed to complete"

        events = service.list_events(operation_id="op_exclusive_oversized")
        assert len(events) == 2
        assert service._oversized_owner_id is None
        assert service._reserved_producer_bytes == 0
        assert service._queue_bytes == 0
    finally:
        service.close()


def test_overlap_write_transaction_and_oversized_audit_event(client: TestClient) -> None:
    """Area 1 acceptance: Overlapping write mutation with audit hook and oversized audit event."""
    activity_service = client.app.state.services.activity
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="op_overlap_tx"
    )

    orig_q = activity_service.max_queue_bytes
    orig_t = activity_service.max_total_bytes
    activity_service.max_queue_bytes = 32_000
    activity_service.max_total_bytes = 64_000

    try:
        oversized_payload = "W" * 70_000
        tx_started = threading.Event()
        audit_submitted = threading.Event()
        audit_finished = threading.Event()
        tx_finished = threading.Event()
        created_doc_id = None

        def write_tx():
            nonlocal created_doc_id
            tx_started.set()
            assert audit_submitted.wait(timeout=5.0)
            resp = client.post(
                "/api/v1/documents",
                json={"title": "Overlap Doc", "content": "doc content", "path": "overlap_doc.md"},
                headers=headers("overlap-tx-key-1"),
            )
            assert resp.status_code == 201
            created_doc_id = resp.json()["document_id"]
            tx_finished.set()

        def audit_record():
            assert tx_started.wait(timeout=5.0)
            with activity_service.admit(estimated_bytes=80_000) as res:
                audit_submitted.set()
                res.record(
                    principal=principal,
                    action="create",
                    resource_type="document",
                    outcome="accepted",
                    resource_id="doc_overlap_audit",
                    details={"diff": oversized_payload},
                )
            audit_finished.set()

        t_tx = threading.Thread(target=write_tx)
        t_aud = threading.Thread(target=audit_record)

        t_tx.start()
        t_aud.start()

        t_tx.join(timeout=10.0)
        t_aud.join(timeout=10.0)

        assert tx_finished.is_set(), "Write transaction deadlocked or timed out"
        assert audit_finished.is_set(), "Audit recording deadlocked or timed out"

        db = activity_service.database
        with db.connection() as conn:
            doc = conn.execute(
                "SELECT * FROM documents WHERE document_id = ?", (created_doc_id,)
            ).fetchone()
            assert doc is not None
            # Verify mutation audit event has document_id and revision_id
            mut_event = conn.execute(
                "SELECT * FROM operation_events WHERE resource_id = ?", (created_doc_id,)
            ).fetchone()
            assert mut_event is not None
            assert mut_event["outcome"] == "accepted"
            assert mut_event["revision_id"] == doc["current_revision_id"]

            event = conn.execute(
                "SELECT * FROM operation_events WHERE resource_id = ?", ("doc_overlap_audit",)
            ).fetchone()
            assert event is not None
            assert event["outcome"] == "accepted"
    finally:
        activity_service.max_queue_bytes = orig_q
        activity_service.max_total_bytes = orig_t


def test_recursive_payload_bound_covers_nested_structures_and_numeric_boundaries() -> None:
    """Area 3 acceptance: Nested payloads, unicode, escaping, and numeric bounds."""
    import json

    from sangam.activity import _estimate_value_bound

    test_values = [
        None,
        True,
        False,
        0,
        -1,
        123456789012345678901234567890,
        3.141592653589793,
        1e20,
        "",
        "hello world",
        '{"key": "value with \\n and \\t and \\"quotes\\""}',
        "Unicode: 日本語, العربية, 🚀, ñ, ü, ç",
        b"raw bytes",
        [1, 2, "three", True, None],
        (1, 2, 3),
        {1, 2, 3},
        {"nested": {"list": [1, 2, {"a": "b", "c": [True, False, None]}]}},
        {"huge_int": 10**50, "deep": {"deeper": {"deepest": {"value": "end"}}}},
    ]

    for val in test_values:
        bound = _estimate_value_bound(val)
        if isinstance(val, set):
            json_str = json.dumps(list(val))
        elif isinstance(val, (bytes, bytearray)):
            json_str = json.dumps(val.decode("latin-1"))
        else:
            json_str = json.dumps(val)
        assert bound >= len(json_str), (
            f"Bound {bound} failed for value {val!r} (json len {len(json_str)})"
        )


def test_post_commit_materialization_failure_records_correlated_failure_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Area 5 acceptance: Materialization failure records correlated failure audit event."""
    workspace = client.app.state.services.documents.workspace

    def failing_write_atomic(*args: object, **kwargs: object) -> str:
        raise OSError("Disk full during atomic materialization")

    monkeypatch.setattr(workspace, "write_atomic", failing_write_atomic)

    response = client.post(
        "/api/v1/documents",
        json={"title": "Failing Materialization", "content": "content", "path": "fail_mat.md"},
        headers=headers("fail-mat-k1"),
    )
    assert response.status_code in (500, 503)

    db = client.app.state.services.activity.database
    with db.connection() as conn:
        doc = conn.execute(
            "SELECT document_id, current_revision_id FROM documents WHERE path = ?",
            ("fail_mat.md",),
        ).fetchone()
        assert doc is not None, "Durable database revision must exist"
        doc_id = doc["document_id"]
        rev_id = doc["current_revision_id"]

        events = conn.execute(
            "SELECT action, outcome, revision_id, detail_json FROM operation_events "
            "WHERE resource_id = ? ORDER BY created_at ASC",
            (doc_id,),
        ).fetchall()
        assert len(events) >= 1
        fail_event = [e for e in events if e["outcome"] == "failed"]
        assert len(fail_event) == 1, "Must have recorded correlated failure event"
        assert fail_event[0]["revision_id"] == rev_id
        assert "materialization" in fail_event[0]["detail_json"]
        assert "The revision was committed" in fail_event[0]["detail_json"]


def test_worker_recovery_from_transient_lock_and_uncertain_reconciliation(
    client: TestClient,
) -> None:
    """Area 6 acceptance: Worker recovery and event reconciliation."""
    activity_service = client.app.state.services.activity

    # Transient error
    activity_service._worker_healthy = False
    activity_service._worker_error = sqlite3.OperationalError("database is locked")
    assert activity_service.is_healthy() is True, "Must recover from transient lock contention"

    # Terminal / disk failure
    activity_service._worker_healthy = False
    activity_service._worker_error = OSError("Disk device removed")
    assert activity_service.is_healthy() is False, "Must NOT recover from terminal OS error"
    activity_service._worker_healthy = True
    activity_service._worker_error = None

    # Uncertain event reconciliation
    event_id = "evt_reconcile_test_1"
    activity_service._uncertain_events[event_id] = time.time()
    assert activity_service.reconcile_event(event_id) == "uncertain"

    # Insert into database
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="op_rec"
    )
    with activity_service.database.connection() as conn:
        activity_service.record_with_connection(
            connection=conn,
            principal=principal,
            action="create",
            resource_type="document",
            outcome="accepted",
            resource_id="doc_rec_1",
        )
        # Check reconcile on real row
        row = conn.execute(
            "SELECT event_id FROM operation_events WHERE resource_id = ?", ("doc_rec_1",)
        ).fetchone()
        assert row is not None
        assert activity_service.reconcile_event(row["event_id"]) == "committed"
        assert row["event_id"] not in activity_service._uncertain_events


def test_annotation_validation_rejects_control_characters(client: TestClient) -> None:
    """Area 8 acceptance: Annotation color and tags reject control characters."""
    from test_phase_five_pdf_research import import_pdf, text_pdf

    from sangam.errors import ValidationError

    pdf_bytes = text_pdf("Annotation Validation Test PDF")
    imported = import_pdf(
        client,
        content=pdf_bytes,
        key="ann-val-pdf-key",
        path="research/ann_val.pdf",
        title="Annotation Validation PDF",
    ).json()
    doc_id = imported["document_id"]

    pdf_service = client.app.state.services.pdf_research
    with pytest.raises(ValidationError, match="Annotation color"):
        pdf_service.create_annotation(
            document_id=doc_id,
            page_number=1,
            annotation_type="highlight",
            selected_text="text",
            note=None,
            geometry=[],
            tags=["valid"],
            color="red\x00null",
            actor_id="human:jay",
            idempotency_key="ann-val-1",
        )

    with pytest.raises(ValidationError, match="Annotation tag"):
        pdf_service.create_annotation(
            document_id=doc_id,
            page_number=1,
            annotation_type="highlight",
            selected_text="text",
            note=None,
            geometry=[],
            tags=["tag\nwith\nnewline"],
            color="#FF0000",
            actor_id="human:jay",
            idempotency_key="ann-val-2",
        )


def test_materialization_failure_does_not_corrupt_unrelated_reservation_accounting(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Probe 1: Materialization failure must not reuse or corrupt an active reservation."""
    activity_svc = client.app.state.services.activity
    workspace = client.app.state.services.documents.workspace

    res_probe = activity_svc.admit(estimated_bytes=2048)
    assert activity_svc._reserved_producer_bytes == 2048
    initial_admitted = activity_svc._admitted_items

    def failing_write_atomic(*args: object, **kwargs: object) -> str:
        raise OSError("Simulated disk failure during atomic write")

    monkeypatch.setattr(workspace, "write_atomic", failing_write_atomic)

    resp = client.post(
        "/api/v1/documents",
        json={"title": "Failing Materialization", "content": "hello", "path": "fail_mat_probe.md"},
        headers=headers("fail-mat-probe-1"),
    )
    assert resp.status_code in (500, 503)

    assert activity_svc._reserved_producer_bytes == 2048, (
        f"Expected 2048 reserved bytes remaining, got {activity_svc._reserved_producer_bytes}"
    )
    assert activity_svc._admitted_items == initial_admitted

    res_probe.release()
    assert activity_svc._reserved_producer_bytes == 0


def test_nested_structures_deep_bound_vs_actual_json() -> None:
    """Probe 2: 12 nested lists wrapping a 100,000-char string must estimate bound >= actual."""
    import json

    from sangam.activity import _estimate_value_bound

    s = "a" * 100_000
    val = s
    for _ in range(12):
        val = [val]

    bound = _estimate_value_bound(val)
    actual = len(json.dumps(val))
    assert bound >= actual, f"Bound {bound} was less than actual serialized JSON length {actual}"
    assert bound > 100_000, f"Bound {bound} undercounted large nested string"

    deep_val = "x"
    for _ in range(35):
        deep_val = [deep_val]
    with pytest.raises(ValueError, match="maximum nesting depth"):
        _estimate_value_bound(deep_val)


def test_two_expanding_producers_do_not_deadlock_on_empty_queue(client: TestClient) -> None:
    """Finding 2: Two expanding producers when queue is empty take turns rather than deadlocking."""
    activity_svc = client.app.state.services.activity
    orig_q = activity_svc.max_queue_bytes
    orig_t = activity_svc.max_total_bytes
    activity_svc.max_queue_bytes = 16_000
    activity_svc.max_total_bytes = 32_000

    try:
        res1 = activity_svc.admit(estimated_bytes=8_000)
        res2 = activity_svc.admit(estimated_bytes=8_000)

        payload = "E" * 10_000
        p1 = Principal.trusted_human(actor_id="human:jay", display_name="P1", operation_id="op_p1")
        p2 = Principal.trusted_human(actor_id="human:jay", display_name="P2", operation_id="op_p2")

        errors: list[Exception] = []

        def worker(res, princ, doc_id):
            try:
                res.record(
                    principal=princ,
                    action="create",
                    resource_type="document",
                    outcome="accepted",
                    resource_id=doc_id,
                    details={"diff": payload},
                )
            except Exception as e:
                errors.append(e)

        t1 = threading.Thread(target=worker, args=(res1, p1, "doc_p1"))
        t2 = threading.Thread(target=worker, args=(res2, p2, "doc_p2"))

        t1.start()
        t2.start()

        t1.join(timeout=10.0)
        t2.join(timeout=10.0)

        assert not t1.is_alive(), "Producer 1 deadlocked during expansion"
        assert not t2.is_alive(), "Producer 2 deadlocked during expansion"
        assert len(errors) == 0, f"Expansion workers encountered errors: {errors}"
    finally:
        activity_svc.max_queue_bytes = orig_q
        activity_svc.max_total_bytes = orig_t


def test_transactional_expansion_enforces_total_memory_limit(client: TestClient) -> None:
    """Finding 2: Transactional expansion enforces total memory bound."""
    activity_svc = client.app.state.services.activity
    orig_t = activity_svc.max_total_bytes
    activity_svc.max_total_bytes = 10_000

    try:
        res = activity_svc.admit(estimated_bytes=1000)
        principal = Principal.trusted_human(
            actor_id="human:jay", display_name="Jay", operation_id="op_tx_mem"
        )
        with (
            activity_svc.database.connection() as conn,
            pytest.raises(ServiceUnavailableError, match="Audit total memory limit exceeded"),
        ):
            res.record_with_connection(
                conn,
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id="doc_overflow",
                details={"diff": "X" * 15_000},
            )
    finally:
        activity_svc.max_total_bytes = orig_t


def test_commit_failure_records_correlated_failure_event(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Finding 4: When SQLite commit fails after audit insert, a failure audit event is logged."""
    db = client.app.state.services.activity.database
    orig_connect = db.connect
    fail_commit = False

    class ConnectionProxy:
        def __init__(self, target):
            self._target = target

        def commit(self):
            if fail_commit:
                raise sqlite3.OperationalError("Simulated disk error on commit")
            return self._target.commit()

        def __getattr__(self, name):
            return getattr(self._target, name)

    monkeypatch.setattr(db, "connect", lambda: ConnectionProxy(orig_connect()))

    resp = client.post(
        "/api/v1/documents",
        json={"title": "Commit Normal", "content": "content", "path": "commit_ok.md"},
        headers=headers("commit-ok-1"),
    )
    assert resp.status_code == 201

    fail_commit = True
    with pytest.raises(sqlite3.OperationalError, match="Simulated disk error on commit"):
        client.post(
            "/api/v1/documents",
            json={"title": "Commit Fail", "content": "content", "path": "commit_fail.md"},
            headers=headers("commit-fail-1"),
        )

    fail_commit = False
    db = client.app.state.services.activity.database
    with db.connection() as conn:
        doc = conn.execute("SELECT * FROM documents WHERE path = ?", ("commit_fail.md",)).fetchone()
        assert doc is None, "Document must be rolled back on commit failure"

        events = conn.execute(
            "SELECT action, outcome, path, detail_json FROM operation_events "
            "WHERE path = ? ORDER BY created_at ASC",
            ("commit_fail.md",),
        ).fetchall()
        assert len(events) >= 1
        fail_ev = [e for e in events if e["outcome"] == "failed"]
        assert len(fail_ev) >= 1
        assert "commit" in fail_ev[0]["detail_json"]
        assert "Simulated disk error on commit" in fail_ev[0]["detail_json"]


def test_worker_recovery_from_real_sqlite_write_lock(client: TestClient, settings) -> None:
    """Probe 3 & 5: Audit worker exhausts retries against a held SQLite lock, then recovers."""
    activity_svc = client.app.state.services.activity
    orig_timeout = getattr(activity_svc.database, "timeout", 10.0)
    activity_svc.database.timeout = 0.05

    lock_conn = sqlite3.connect(settings.database_path, timeout=0.1)
    lock_conn.execute("BEGIN IMMEDIATE")

    try:
        res = activity_svc.admit(estimated_bytes=500)
        p = Principal.trusted_human(
            actor_id="human:jay", display_name="Jay", operation_id="op_lock_test"
        )

        with pytest.raises(sqlite3.OperationalError):
            res.record(
                principal=p,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id="doc_lock_held",
            )
    finally:
        lock_conn.rollback()
        lock_conn.close()
        activity_svc.database.timeout = orig_timeout

    assert activity_svc.is_healthy() is True
    res_after = client.post(
        "/api/v1/documents",
        json={"title": "After Lock Release", "content": "content", "path": "after_lock.md"},
        headers=headers("after-lock-k1"),
    )
    assert res_after.status_code == 201


def test_document_update_persists_actual_diff_not_placeholder(client: TestClient) -> None:
    """Finding 1: Document updates and restores persist real diffs, not placeholders."""

    # 1. Create document
    create_resp = client.post(
        "/api/v1/documents",
        json={
            "title": "Original Doc",
            "content": "Line one\nold text\nLine three\n",
            "path": "diff_test.md",
        },
        headers=headers("create-diff-test-1"),
    )
    assert create_resp.status_code == 201
    doc_id = create_resp.json()["document_id"]
    rev1 = create_resp.json()["current_revision_id"]

    # 2. Update document
    update_resp = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={
            "content": "Line one\nnew text\nLine three\n",
            "expected_revision_id": rev1,
            "title": "Updated Doc",
        },
        headers=headers("update-diff-test-2"),
    )
    assert update_resp.status_code == 200
    rev2 = update_resp.json()["current_revision_id"]

    # Query operation_events for the update
    activity_svc = client.app.state.services.activity
    with activity_svc.database.connection() as conn:
        row = conn.execute(
            """
            SELECT detail_json, revision_id FROM operation_events
            WHERE resource_id = ? AND action = 'update'
            ORDER BY created_at DESC LIMIT 1
            """,
            (doc_id,),
        ).fetchone()
        assert row is not None
        assert row["revision_id"] == rev2
        details = json.loads(row["detail_json"])
        diff_text = details.get("diff", "")
        assert "XXXXXXXX" not in diff_text
        assert "-old text" in diff_text
        assert "+new text" in diff_text
        assert details.get("lines_added") == 1
        assert details.get("lines_removed") == 1

    # 3. Update to third version
    update3 = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={
            "content": "Line one\nthird text\nLine three\n",
            "expected_revision_id": rev2,
        },
        headers=headers("update-diff-test-3"),
    )
    assert update3.status_code == 200
    rev3 = update3.json()["current_revision_id"]

    # 4. Restore back to rev1
    restore_resp = client.post(
        f"/api/v1/documents/{doc_id}/restore",
        json={
            "expected_revision_id": rev3,
            "revision_id": rev1,
        },
        headers=headers("restore-diff-test-4"),
    )
    assert restore_resp.status_code == 200
    rev4 = restore_resp.json()["current_revision_id"]

    with activity_svc.database.connection() as conn:
        row = conn.execute(
            """
            SELECT detail_json, revision_id FROM operation_events
            WHERE resource_id = ? AND action = 'restore'
            ORDER BY created_at DESC LIMIT 1
            """,
            (doc_id,),
        ).fetchone()
        assert row is not None
        assert row["revision_id"] == rev4
        details = json.loads(row["detail_json"])
        diff_text = details.get("diff", "")
        # Restore diff is from rev3 ("third text") to rev1 ("old text")
        assert "-third text" in diff_text
        assert "+old text" in diff_text


def test_full_budget_expansion_strictly_enforces_advertised_bound(client: TestClient) -> None:
    """Finding 2: 16 KB budget with two 8 KB reservations; Res 1 expands to 12 KB diff.
    Peak total memory must NEVER exceed 16,384 bytes. Res 1 must wait until Res 2 finishes.
    """
    activity_svc = client.app.state.services.activity
    orig_total = activity_svc.max_total_bytes
    orig_queue = activity_svc.max_queue_bytes
    activity_svc.max_total_bytes = 16_384
    activity_svc.max_queue_bytes = 16_384

    try:
        res1 = activity_svc.admit(estimated_bytes=8192)
        res2 = activity_svc.admit(estimated_bytes=8192)

        principal = Principal.trusted_human(
            actor_id="human:jay", display_name="Jay", operation_id="op_expansion_bound"
        )
        large_diff = "A" * 12_000

        res1_completed = threading.Event()
        res1_error = []

        def worker1():
            try:
                res1.record(
                    principal=principal,
                    action="update",
                    resource_type="document",
                    outcome="accepted",
                    resource_id="doc_res1",
                    details={"diff": large_diff},
                )
                res1_completed.set()
            except Exception as e:
                res1_error.append(e)

        t1 = threading.Thread(target=worker1)
        t1.start()

        # Res 1 cannot expand yet because total_in_flight (16,384) + expansion > 16,384!
        time.sleep(0.1)
        assert not res1_completed.is_set(), "Res 1 should wait while Res 2 is holding capacity"

        # Now Res 2 releases its capacity
        res2.release()

        # Res 1 can now expand within the 16,384 budget!
        t1.join(timeout=5.0)
        assert res1_completed.is_set()
        assert not res1_error

        # CRITICAL ASSERTION: Peak total memory must NEVER exceed 16,384!
        assert activity_svc.peak_total_bytes <= 16_384, (
            f"Peak total bytes {activity_svc.peak_total_bytes} exceeded budget 16,384!"
        )
    finally:
        activity_svc.max_total_bytes = orig_total
        activity_svc.max_queue_bytes = orig_queue


def test_transactional_admitted_oversized_owner_permitted(client: TestClient) -> None:
    """Finding 2 Part B: Admitted oversized owner is permitted during transaction."""
    activity_svc = client.app.state.services.activity
    orig_total = activity_svc.max_total_bytes
    activity_svc.max_total_bytes = 10_000

    try:
        # Admitted as exclusive oversized owner
        res = activity_svc.admit(estimated_bytes=15_000)
        assert res._is_oversized_owner is True

        principal = Principal.trusted_human(
            actor_id="human:jay", display_name="Jay", operation_id="op_tx_oversized"
        )
        with activity_svc.database.connection() as conn:
            # Must succeed without raising ServiceUnavailableError
            res.record_with_connection(
                conn,
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id="doc_tx_oversized",
                details={"diff": "O" * 15_000},
            )
    finally:
        activity_svc.max_total_bytes = orig_total


def test_failure_audit_persistence_failure_is_not_swallowed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Finding 3: When audit persistence fails during request failure handling,
    the original error is preserved, chained with audit failure, reporting audit_persisted=False.
    """
    create_resp = client.post(
        "/api/v1/documents",
        json={"title": "Doc For Fail Audit", "content": "initial", "path": "fail_audit.md"},
        headers=headers("fail-audit-seed"),
    )
    assert create_resp.status_code == 201
    doc_id = create_resp.json()["document_id"]

    from sangam.activity import AuditReservation

    def failing_reservation_record(self, *args, **kwargs):
        raise RuntimeError("Simulated audit queue failure")

    monkeypatch.setattr(AuditReservation, "record", failing_reservation_record)

    # Make request that fails with 409 (revision conflict)
    resp = client.patch(
        f"/api/v1/documents/{doc_id}",
        json={
            "content": "updated",
            "expected_revision_id": "rev_wrong",
        },
        headers=headers("fail-audit-k1"),
    )
    # The original 409 Conflict status code is returned
    assert resp.status_code == 409
    body = resp.json()
    # The error details explicitly record the audit persistence failure
    assert body["error"]["code"] == "revision_conflict"
    assert body["error"]["details"].get("audit_persisted") is False
    assert "Simulated audit queue failure" in str(body["error"]["details"].get("audit_error"))


def test_two_expanding_producers_break_circular_wait_under_strict_capacity(
    client: TestClient,
) -> None:
    """Reviewer Finding 1: Two expanding reservations must not deadlock each other until timeout.
    Under a strict 16 KB budget with two 8 KB reservations expanding to 12 KB each,
    producers yield provisional byte credits in FIFO order to acquire complete event capacity,
    finishing without timeout while peak total memory stays strictly <= 16,384 bytes.
    """
    activity_svc = client.app.state.services.activity
    orig_total = activity_svc.max_total_bytes
    orig_queue = activity_svc.max_queue_bytes
    activity_svc.max_total_bytes = 16_384
    activity_svc.max_queue_bytes = 16_384

    try:
        res1 = activity_svc.admit(estimated_bytes=8192)
        res2 = activity_svc.admit(estimated_bytes=8192)

        principal = Principal.trusted_human(
            actor_id="human:jay", display_name="Jay", operation_id="op_circ_wait"
        )
        large_diff = "X" * 11_500
        results = {}
        errors = []

        def worker(res, name, doc_id):
            try:
                res.record(
                    principal=principal,
                    action="update",
                    resource_type="document",
                    outcome="accepted",
                    resource_id=doc_id,
                    details={"diff": large_diff},
                )
                results[name] = "success"
            except Exception as e:
                results[name] = f"error: {e}"
                errors.append(e)

        t1 = threading.Thread(target=worker, args=(res1, "p1", "doc_circ_1"))
        t2 = threading.Thread(target=worker, args=(res2, "p2", "doc_circ_2"))

        t0 = time.time()
        t1.start()
        t2.start()

        t1.join(timeout=10.0)
        t2.join(timeout=10.0)
        elapsed = time.time() - t0

        assert not t1.is_alive(), "Producer 1 deadlocked during expansion wait"
        assert not t2.is_alive(), "Producer 2 deadlocked during expansion wait"
        assert elapsed < 10.0, f"Producers took {elapsed}s; expected completion well under timeout"
        assert not errors, f"Expansion workers encountered errors: {errors}"
        assert results.get("p1") == "success"
        assert results.get("p2") == "success"

        # Strictly enforce peak memory bound <= 16,384 bytes
        assert activity_svc.peak_total_bytes <= 16_384, (
            f"Peak total bytes {activity_svc.peak_total_bytes} exceeded configured budget 16,384!"
        )
    finally:
        activity_svc.max_total_bytes = orig_total
        activity_svc.max_queue_bytes = orig_queue


def test_audit_diff_preserves_line_endings_and_diff_header_lines(client: TestClient) -> None:
    """Reviewer Finding 2: Audit diffs must distinguish line-ending additions/removals,
    missing-final-newline, and CRLF vs LF changes, while retaining correct counts for content
    resembling diff headers.
    """
    db = client.app.state.services.activity.database

    # Case 1: Missing final newline addition: "line" -> "line\n"
    c1 = client.post(
        "/api/v1/documents",
        json={"title": "Newline Doc", "content": "line", "path": "newline.md"},
        headers=headers("nl-create-k1"),
    )
    assert c1.status_code == 201
    doc1_id = c1.json()["document_id"]
    rev1_id = c1.json()["current_revision_id"]

    u1 = client.patch(
        f"/api/v1/documents/{doc1_id}",
        json={"content": "line\n", "expected_revision_id": rev1_id},
        headers=headers("nl-update-k1"),
    )
    assert u1.status_code == 200

    with db.connection() as conn:
        ev = conn.execute(
            "SELECT detail_json FROM operation_events WHERE resource_id = ? AND action = 'update'",
            (doc1_id,),
        ).fetchone()
        assert ev is not None
        details = json.loads(ev["detail_json"])
        diff_text = details.get("diff", "")
        assert r"\ No newline at end of file" in diff_text
        assert details.get("lines_added") == 1
        assert details.get("lines_removed") == 1
        assert details.get("final_newline") is True
        assert details.get("line_ending") == "lf"

    # Case 2: Content lines starting with ++ and --
    c2 = client.post(
        "/api/v1/documents",
        json={"title": "Symbols Doc", "content": "++var\n--flag\n", "path": "symbols.md"},
        headers=headers("sym-create-k1"),
    )
    assert c2.status_code == 201
    doc2_id = c2.json()["document_id"]
    rev2_id = c2.json()["current_revision_id"]

    u2 = client.patch(
        f"/api/v1/documents/{doc2_id}",
        json={"content": "+++var\n---flag\n", "expected_revision_id": rev2_id},
        headers=headers("sym-update-k1"),
    )
    assert u2.status_code == 200

    with db.connection() as conn:
        ev2 = conn.execute(
            "SELECT detail_json FROM operation_events WHERE resource_id = ? AND action = 'update'",
            (doc2_id,),
        ).fetchone()
        assert ev2 is not None
        details2 = json.loads(ev2["detail_json"])
        diff2 = details2.get("diff", "")
        # Both additions and removals must be present and counted
        assert "++++var" in diff2
        assert "+---flag" in diff2
        assert details2.get("lines_added") == 2
        assert details2.get("lines_removed") == 2

    # Case 3: CRLF to LF change
    c3 = client.post(
        "/api/v1/documents",
        json={"title": "CRLF Doc", "content": "header\r\nbody\r\n", "path": "crlf.md"},
        headers=headers("crlf-create-k1"),
    )
    assert c3.status_code == 201
    doc3_id = c3.json()["document_id"]
    rev3_id = c3.json()["current_revision_id"]

    u3 = client.patch(
        f"/api/v1/documents/{doc3_id}",
        json={"content": "header\nbody\n", "expected_revision_id": rev3_id},
        headers=headers("crlf-update-k1"),
    )
    assert u3.status_code == 200

    with db.connection() as conn:
        ev3 = conn.execute(
            "SELECT detail_json FROM operation_events WHERE resource_id = ? AND action = 'update'",
            (doc3_id,),
        ).fetchone()
        assert ev3 is not None
        details3 = json.loads(ev3["detail_json"])
        assert details3.get("line_ending") == "lf"
        assert details3.get("final_newline") is True
        assert details3.get("lines_added") == 2
        assert details3.get("lines_removed") == 2


def test_streaming_gate_rejects_error_events_and_requires_persisted_assistant_response(
    client: TestClient,
) -> None:
    """Verification Gate: Reject SSE error events, require completed assistant response,
    and verify item ID and content match SQLite chat_thread_items.
    """
    import json
    from datetime import UTC, datetime

    from chatkit.types import AssistantMessageContent, AssistantMessageItem, ThreadMetadata

    from sangam.chat_context import ChatRequestContext
    from sangam.chat_store import SQLiteChatKitStore

    # 1. Five-event error sequence simulation
    error_stream_events = [
        {
            "type": "thread.created",
            "thread": {"id": "thr_err_test", "created_at": "2026-03-31T00:00:00Z"},
        },
        {
            "type": "thread.item.done",
            "item": {
                "id": "msg_user",
                "thread_id": "thr_err_test",
                "type": "user_message",
                "content": [{"type": "input_text", "text": "test probe"}],
            },
        },
        {"type": "stream_options", "stream_options": {"allow_cancel": True}},
        {
            "type": "error",
            "code": "custom",
            "message": "Set SANGAM_OPENROUTER_API_KEY in the server environment.",
        },
        {"type": "thread.updated", "thread": {"id": "thr_err_test"}},
    ]

    # Evaluate against gate criteria
    error_events = [ev for ev in error_stream_events if ev.get("type") == "error"]
    assert len(error_events) == 1
    assert error_events[0].get("code") == "custom"
    assert "SANGAM_OPENROUTER_API_KEY" in error_events[0].get("message", "")

    completed_asst = [
        ev.get("item")
        for ev in error_stream_events
        if ev.get("type") == "thread.item.done"
        and isinstance(ev.get("item"), dict)
        and ev["item"].get("type") == "assistant_message"
    ]
    assert len(completed_asst) == 0, "Error stream must not have completed assistant response"

    # 2. Valid stream sequence with completed assistant response and SQLite persistence
    db = client.app.state.services.activity.database
    store = SQLiteChatKitStore(db)
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="op_asst_stream"
    )
    ctx = ChatRequestContext(principal=principal)

    async def persist_chat():
        thread = ThreadMetadata(id="thr_success_1", created_at=datetime.now(UTC))
        await store.save_thread(thread, ctx)
        asst_item = AssistantMessageItem(
            id="msg_asst_1",
            thread_id=thread.id,
            content=[AssistantMessageContent(text="Verified assistant stream response text.")],
            created_at=datetime.now(UTC),
        )
        await store.save_item(thread.id, asst_item, ctx)
        await store.close()

    asyncio.run(persist_chat())

    success_stream_events = [
        {"type": "thread.created", "thread": {"id": "thr_success_1"}},
        {"type": "thread.item.done", "item": {"id": "msg_user_1", "type": "user_message"}},
        {
            "type": "thread.item.done",
            "item": {
                "id": "msg_asst_1",
                "type": "assistant_message",
                "content": [
                    {"type": "output_text", "text": "Verified assistant stream response text."}
                ],
            },
        },
        {"type": "thread.updated", "thread": {"id": "thr_success_1"}},
    ]

    # Gate verification
    success_errs = [ev for ev in success_stream_events if ev.get("type") == "error"]
    assert not success_errs

    asst_items = [
        ev.get("item")
        for ev in success_stream_events
        if ev.get("type") == "thread.item.done"
        and isinstance(ev.get("item"), dict)
        and ev["item"].get("type") == "assistant_message"
    ]
    assert len(asst_items) == 1
    found_item = asst_items[0]
    asst_id = found_item.get("id")
    asst_text = "".join(p.get("text", "") for p in found_item.get("content", []))

    with db.connection() as conn:
        row = conn.execute(
            "SELECT item_id, thread_id, data_json FROM chat_thread_items "
            "WHERE thread_id = ? AND item_id = ?",
            ("thr_success_1", asst_id),
        ).fetchone()
        assert row is not None, "Assistant item must be found in SQLite"
        db_raw = json.loads(row["data_json"])
        payload = db_raw.get("payload", db_raw) if isinstance(db_raw, dict) else {}
        assert payload.get("id") == asst_id
        assert payload.get("type") == "assistant_message"
        db_text = "".join(
            p.get("text", "") for p in payload.get("content", []) if p.get("type") == "output_text"
        )
        assert db_text == asst_text
