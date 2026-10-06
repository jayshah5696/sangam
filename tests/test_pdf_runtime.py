from __future__ import annotations

import asyncio
import io
import threading
import time

import pytest
from pypdf import PdfWriter
from starlette.requests import Request
from test_phase_five_pdf_research import text_pdf

from sangam.errors import ValidationError
from sangam.pdf_runtime import PdfExtractionScheduler, spooled_pdf_body


class BoundedReads(io.BytesIO):
    def read(self, size: int = -1) -> bytes:
        assert 0 < size <= 65536, "PDF import must not materialize the entire upload"
        return super().read(size)


def test_streamed_pdf_import_hashes_copies_and_replays_without_unbounded_reads(client):
    service = client.app.state.services.pdf_research
    source = text_pdf("streamed import") + b"\n" * 200000
    arguments = dict(
        title="Stream",
        path="stream.pdf",
        supersedes_document_id=None,
        actor_id="human:jay",
        idempotency_key="stream",
    )
    document = service.import_pdf(content=BoundedReads(source), **arguments)
    replay = service.import_pdf(content=BoundedReads(source), **arguments)
    assert replay.document_id == document.document_id
    assert document.size_bytes == len(source)
    assert service.pdf_bytes(document.document_id)[1] == source


def test_spooled_body_counts_chunked_bytes_and_closes_file():
    async def scenario():
        chunks = iter([b"%PDF-", b"12345"])

        async def receive():
            return {"type": "http.request", "body": next(chunks), "more_body": True}

        request = Request({"type": "http", "headers": []}, receive)
        with pytest.raises(ValidationError, match="size limit"):
            async with spooled_pdf_body(request, max_bytes=9):
                pytest.fail("oversize input must never be handed to the importer")

        async def complete():
            return {"type": "http.request", "body": b"%PDF-small", "more_body": False}

        request = Request({"type": "http", "headers": []}, complete)
        async with spooled_pdf_body(request, max_bytes=20) as content:
            assert content.read() == b"%PDF-small"
            assert not content.closed
        assert content.closed

    asyncio.run(scenario())


def test_extraction_scheduler_keeps_backlog_in_database_and_bounds_workers(client, monkeypatch):
    client.portal.call(client.app.state.pdf_scheduler.close, 5)
    service = client.app.state.services.pdf_research
    for index in range(8):
        service.import_pdf(
            title=f"PDF {index}",
            path=f"queue/{index}.pdf",
            content=text_pdf(),
            supersedes_document_id=None,
            actor_id="human:jay",
            idempotency_key=f"queue-{index}",
        )
    started = threading.Event()
    unblock = threading.Event()
    active = 0
    peak = 0
    lock = threading.Lock()
    original = service.extract_text

    def slow_extract(document_id, cancel_event):
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            if active == 2:
                started.set()
        try:
            unblock.wait(3)
            return original(document_id, cancel_event)
        finally:
            with lock:
                active -= 1

    monkeypatch.setattr(service, "extract_text", slow_extract)
    scheduler = PdfExtractionScheduler(service, workers=2)
    scheduler.start()
    try:
        assert started.wait(2)
        assert len(service.pending_extractions()) == 8
        assert peak == 2
        unblock.set()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with service.database.connection() as connection:
                remaining = connection.execute(
                    "SELECT count(*) FROM pdf_documents "
                    "WHERE extraction_status IN ('pending', 'processing')"
                ).fetchone()[0]
            if not remaining:
                break
            time.sleep(0.02)
    finally:
        unblock.set()
        asyncio.run(scheduler.close(timeout=5))
    with service.database.connection() as connection:
        assert (
            connection.execute(
                "SELECT count(*) FROM pdf_documents WHERE extraction_status = 'ready'"
            ).fetchone()[0]
            == 8
        )
    assert peak == 2


@pytest.mark.parametrize("limit", ["pages", "time"])
def test_pdf_parser_limits_fail_durably_without_partial_pages(client, limit):
    client.portal.call(client.app.state.pdf_scheduler.close, 5)
    service = client.app.state.services.pdf_research
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.add_blank_page(width=100, height=100)
    source = io.BytesIO()
    writer.write(source)
    document = service.import_pdf(
        title="Limited",
        path="limited.pdf",
        content=source,
        supersedes_document_id=None,
        actor_id="human:jay",
        idempotency_key="limited",
    )
    if limit == "pages":
        service.max_pdf_pages = 1
    else:
        service.extraction_timeout_seconds = 0.001
    assert service.extract_text(document.document_id) is False
    current = service.documents.get_document(document.document_id)
    assert current.pdf_extraction_status == "failed"
    assert service.pages(document.document_id) == []


def test_pdf_parser_writes_atomically_and_cleans_temp_files(tmp_path, monkeypatch):
    import json
    import sys

    from sangam import pdf_parser

    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    source_file = tmp_path / "source.pdf"
    output_file = tmp_path / "pages.json"
    with source_file.open("wb") as f:
        writer.write(f)

    monkeypatch.setattr(
        sys,
        "argv",
        ["pdf_parser", str(source_file), str(output_file), "10", "10000"],
    )
    pdf_parser.main()

    assert output_file.is_file()
    data = json.loads(output_file.read_text(encoding="utf-8"))
    assert isinstance(data, list)
    temp_files = list(tmp_path.glob(".*.sangam-*"))
    assert temp_files == []


def test_pdf_parser_unlinks_temp_file_on_failure(tmp_path, monkeypatch):
    import os
    import sys

    from sangam import pdf_parser

    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    source_file = tmp_path / "source.pdf"
    output_file = tmp_path / "pages.json"
    with source_file.open("wb") as f:
        writer.write(f)

    def mock_replace(src, dst):
        raise OSError("Disk failure during replace")

    monkeypatch.setattr(os, "replace", mock_replace)
    monkeypatch.setattr(
        sys,
        "argv",
        ["pdf_parser", str(source_file), str(output_file), "10", "10000"],
    )

    with pytest.raises(OSError, match="Disk failure during replace"):
        pdf_parser.main()

    assert not output_file.exists()
    temp_files = list(tmp_path.glob(".*.sangam-*"))
    assert temp_files == []
