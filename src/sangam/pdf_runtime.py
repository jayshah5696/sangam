"""Bound PDF receiving and drain the durable extraction queue with fixed workers."""

from __future__ import annotations

import asyncio
import logging
import tempfile
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from functools import partial
from typing import BinaryIO

from starlette.requests import Request

from sangam.errors import ValidationError
from sangam.pdf_research import PdfResearchService

logger = logging.getLogger(__name__)


async def run_pdf_io[T](call: Callable[[], T]) -> T:
    """Keep temporary files owned until their disk operation actually finishes."""
    task = asyncio.create_task(asyncio.to_thread(call))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        await task
        raise


@asynccontextmanager
async def spooled_pdf_body(request: Request, *, max_bytes: int) -> AsyncIterator[BinaryIO]:
    """Receive directly into a temporary file, closing it on every exit path."""
    raw_length = request.headers.get("content-length")
    if raw_length is not None:
        try:
            length = int(raw_length)
        except ValueError as error:
            raise ValidationError("Content-Length must be a non-negative integer") from error
        if length < 0:
            raise ValidationError("Content-Length must be a non-negative integer")
        if length > max_bytes:
            raise ValidationError("PDF exceeds the configured size limit")
    with tempfile.TemporaryFile(mode="w+b") as content:
        received = 0
        async for chunk in request.stream():
            received += len(chunk)
            if received > max_bytes:
                raise ValidationError("PDF exceeds the configured size limit")
            # Wait for disk writes before closing the file on cancellation.
            await run_pdf_io(partial(content.write, chunk))
        await run_pdf_io(lambda: content.seek(0))
        yield content


class PdfExtractionScheduler:
    """Keep queued work in SQLite, with at most `workers` parser threads."""

    def __init__(self, service: PdfResearchService, *, workers: int = 2) -> None:
        self.service = service
        self._stop = threading.Event()
        self._threads = [
            threading.Thread(target=self._drain, name=f"sangam-pdf-{index}", daemon=True)
            for index in range(workers)
        ]

    def start(self) -> None:
        for thread in self._threads:
            thread.start()

    def _drain(self) -> None:
        while not self._stop.is_set():
            try:
                pending = self.service.pending_extractions(limit=1)
                if pending:
                    # The service atomically claims the row before parsing. Two
                    # workers may see the same row; only its claimant processes it.
                    self.service.extract_text(pending[0], self._stop)
                    continue
            except Exception:
                logger.exception("PDF queue worker failed")
            self._stop.wait(0.25)

    async def close(self, timeout: float) -> None:
        self._stop.set()
        deadline = time.monotonic() + timeout
        for thread in self._threads:
            await asyncio.to_thread(thread.join, max(0, deadline - time.monotonic()))
        if any(thread.is_alive() for thread in self._threads):
            raise RuntimeError("PDF extraction shutdown timed out with active workers")
