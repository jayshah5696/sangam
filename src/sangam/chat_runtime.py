from __future__ import annotations

import asyncio
from collections.abc import Callable
from functools import partial
from typing import Any, TypeVar

from starlette.requests import Request

from sangam.chat_store import BoundedThreadRunner
from sangam.errors import ServiceUnavailableError, ValidationError

T = TypeVar("T")


class ChatAdmissionLease:
    """A request slot that remains held until its response stream finishes."""

    def __init__(self, admission: BoundedChatAdmission) -> None:
        self._admission = admission
        self._released = False

    async def release(self) -> None:
        if self._released:
            return
        self._released = True
        await self._admission._release()


class BoundedChatAdmission:
    """Bounds admitted requests and runs synchronous chat work on owned workers."""

    def __init__(
        self,
        *,
        max_active: int,
        max_waiting: int,
        wait_timeout: float,
    ) -> None:
        self._max_active = max_active
        self._max_waiting = max_waiting
        self._wait_timeout = wait_timeout
        self._active = 0
        self._admitted = 0
        self._closing = False
        self._condition = asyncio.Condition()
        self._workers = BoundedThreadRunner(
            max_concurrency=max_active,
            max_waiting=max(1, max_waiting),
        )

    async def acquire(self) -> ChatAdmissionLease:
        async with self._condition:
            if self._closing:
                raise self._overloaded("Chat runtime is shutting down")
            if self._admitted >= self._max_active + self._max_waiting:
                raise self._overloaded("Chat request queue is full")
            self._admitted += 1
            deadline = asyncio.get_running_loop().time() + self._wait_timeout
            try:
                while self._active >= self._max_active:
                    if self._closing:
                        raise self._overloaded("Chat runtime is shutting down")
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        raise self._overloaded("Chat request wait deadline expired")
                    try:
                        await asyncio.wait_for(self._condition.wait(), timeout=remaining)
                    except TimeoutError as error:
                        raise self._overloaded("Chat request wait deadline expired") from error
                if self._closing:
                    raise self._overloaded("Chat runtime is shutting down")
                self._active += 1
            except BaseException:
                self._admitted -= 1
                self._condition.notify_all()
                raise
        return ChatAdmissionLease(self)

    async def _release(self) -> None:
        async with self._condition:
            self._active = max(0, self._active - 1)
            self._admitted = max(0, self._admitted - 1)
            self._condition.notify_all()

    async def run_sync(self, func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
        call = partial(func, *args, **kwargs)
        task = asyncio.create_task(self._workers.run(call))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # The request still owns its slot and transaction until the worker
            # finishes. A cancelled await cannot cancel a committing thread.
            try:
                await task
            finally:
                raise

    async def close(self, timeout: float = 35.0) -> None:
        async with self._condition:
            self._closing = True
            self._condition.notify_all()
        await self._workers.close(timeout=timeout)

    @staticmethod
    def _overloaded(message: str) -> ServiceUnavailableError:
        return ServiceUnavailableError(message, details={"retry_after_seconds": 1})


async def read_limited_body(request: Request, *, max_bytes: int) -> bytes:
    """Read a request in bounded chunks and reject oversize bodies as they arrive."""
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except ValueError as error:
            raise ValidationError("Chat request Content-Length is invalid") from error
        if declared_length < 0:
            raise ValidationError("Chat request Content-Length is invalid")
        if declared_length > max_bytes:
            raise ValidationError("Chat request exceeds the configured size limit")

    content = bytearray()
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > max_bytes:
            raise ValidationError("Chat request exceeds the configured size limit")
        content.extend(chunk)
    return bytes(content)
