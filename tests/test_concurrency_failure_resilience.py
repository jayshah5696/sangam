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
from sangam.config import Settings
from sangam.errors import ServiceUnavailableError
from sangam.main import create_app
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
    tmp_path: object,
) -> None:
    app = create_app(Settings(workspace_root=str(tmp_path)))
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
