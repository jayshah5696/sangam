from __future__ import annotations

import asyncio
import threading

import pytest
from starlette.requests import Request

from sangam.api_chat import _LeasedStreamingResponse
from sangam.chat_runtime import BoundedChatAdmission, read_limited_body
from sangam.errors import ServiceUnavailableError, ValidationError
from sangam.security import Principal


def test_chat_context_preparation_under_sqlite_lock_does_not_block_event_loop(client) -> None:
    async def scenario() -> None:
        chat = client.app.state.services.chat
        admission = BoundedChatAdmission(max_active=1, max_waiting=1, wait_timeout=1)
        locker = chat.evidence.database.connect()
        locker.execute("BEGIN IMMEDIATE")
        started = threading.Event()

        def prepare_context():
            started.set()
            return chat.evidence.create_turn_context(
                Principal.trusted_human(
                    actor_id="human:jay",
                    display_name="Jay",
                    operation_id="chat-runtime-lock-test",
                ),
                entry_point="workspace",
                document_id=None,
                revision_id=None,
                selected_text="",
            )

        task = asyncio.create_task(admission.run_sync(prepare_context))
        assert await asyncio.to_thread(started.wait, 1)
        loop_marker = asyncio.Event()
        asyncio.get_running_loop().call_later(0.02, loop_marker.set)
        await asyncio.wait_for(loop_marker.wait(), timeout=0.2)
        locker.commit()
        assert loop_marker.is_set()
        prepared = await task
        assert prepared.entry_point == "workspace"
        await admission.close()
        locker.close()

    asyncio.run(scenario())


def test_chat_admission_bounds_waiters_and_times_out_before_work_starts() -> None:
    async def scenario() -> None:
        admission = BoundedChatAdmission(max_active=1, max_waiting=1, wait_timeout=0.01)
        active = await admission.acquire()
        waiting = asyncio.create_task(admission.acquire())
        await asyncio.sleep(0)
        with pytest.raises(ServiceUnavailableError, match="wait deadline expired"):
            await waiting
        await active.release()
        available = await admission.acquire()
        await available.release()
        await admission.close()

    asyncio.run(scenario())


def test_chat_admission_rejects_excess_and_releases_cancelled_waiters() -> None:
    async def scenario() -> None:
        admission = BoundedChatAdmission(max_active=1, max_waiting=1, wait_timeout=2)
        active = await admission.acquire()
        waiting = asyncio.create_task(admission.acquire())
        await asyncio.sleep(0)
        with pytest.raises(ServiceUnavailableError, match="queue is full"):
            await admission.acquire()
        waiting.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiting
        replacement_waiter = asyncio.create_task(admission.acquire())
        await asyncio.sleep(0)
        await active.release()
        replacement = await replacement_waiter
        await replacement.release()
        await admission.close()

    asyncio.run(scenario())


def test_zero_waiting_chat_limit_still_allows_active_sync_work() -> None:
    async def scenario() -> None:
        admission = BoundedChatAdmission(max_active=1, max_waiting=0, wait_timeout=1)
        lease = await admission.acquire()
        assert await admission.run_sync(lambda: "done") == "done"
        await lease.release()
        await admission.close()

    asyncio.run(scenario())


def test_stream_start_failure_releases_chat_admission_lease() -> None:
    async def scenario() -> None:
        admission = BoundedChatAdmission(max_active=1, max_waiting=0, wait_timeout=1)
        lease = await admission.acquire()

        async def stream():
            yield b"data"

        response = _LeasedStreamingResponse(stream(), lease)

        async def receive() -> dict[str, str]:
            await asyncio.Event().wait()
            return {"type": "http.disconnect"}

        async def send(_message: dict[str, object]) -> None:
            raise RuntimeError("client disconnected before stream start")

        with pytest.raises(RuntimeError, match="client disconnected"):
            await response(
                {"type": "http", "asgi": {"version": "3.0"}, "method": "GET", "path": "/"},
                receive,
                send,
            )
        replacement = await admission.acquire()
        await replacement.release()
        await admission.close()

    asyncio.run(scenario())


def test_chunked_chat_body_stops_at_the_configured_limit() -> None:
    async def scenario() -> None:
        received = 0
        chunks = [b"12345678", b"abcdefgh", b"unread"]

        async def receive() -> dict[str, object]:
            nonlocal received
            received += 1
            if chunks:
                return {"type": "http.request", "body": chunks.pop(0), "more_body": bool(chunks)}
            return {"type": "http.request", "body": b"", "more_body": False}

        request = Request({"type": "http", "method": "POST", "headers": []}, receive)
        with pytest.raises(ValidationError, match="configured size limit"):
            await read_limited_body(request, max_bytes=10)
        assert received == 2

    asyncio.run(scenario())


def test_declared_oversize_body_is_rejected_before_receiving_any_bytes() -> None:
    async def scenario() -> None:
        received = False

        async def receive() -> dict[str, object]:
            nonlocal received
            received = True
            return {"type": "http.request", "body": b"", "more_body": False}

        request = Request(
            {
                "type": "http",
                "method": "POST",
                "headers": [(b"content-length", b"11")],
            },
            receive,
        )
        with pytest.raises(ValidationError, match="configured size limit"):
            await read_limited_body(request, max_bytes=10)
        assert received is False

    asyncio.run(scenario())
