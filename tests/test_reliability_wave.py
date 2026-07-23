from __future__ import annotations

import hashlib
import io
import threading
import time

import pytest
from conftest import headers
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from sangam.api import create_app
from sangam.config import Settings
from sangam.errors import ConflictError
from sangam.pdf_research import PdfResearchService


def _text_pdf(text: str = "Reliability evidence") -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 12 Tf 20 100 Td ({text}) Tj ET".encode())
    page[NameObject("/Contents")] = writer._add_object(stream)
    page[NameObject("/Resources")] = DictionaryObject()
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def _import_pdf(client: TestClient, content: bytes, *, key: str = "reliability-pdf") -> dict:
    response = client.post(
        "/api/v1/pdfs",
        params={"title": "Reliability PDF", "path": "research/reliability.pdf"},
        content=content,
        headers={**headers(key), "Content-Type": "application/pdf"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_readiness_reports_all_release_checks_and_degrades_on_pending_state(
    client: TestClient,
) -> None:
    ready = client.get("/api/v1/readiness")
    assert ready.status_code == 200
    payload = ready.json()
    assert payload["status"] == "ready"
    assert set(payload["checks"]) == {
        "database",
        "schema",
        "writable_roots",
        "startup_reconciliation",
        "pending_materializations",
        "backup_freshness",
    }
    assert payload["checks"]["backup_freshness"]["detail"] == "disabled"

    created = client.post(
        "/api/v1/documents",
        json={"title": "Pending", "content": "state"},
        headers=headers("pending-readiness"),
    ).json()
    database = client.app.state.services.documents.database
    with database.transaction() as connection:
        connection.execute(
            "UPDATE documents SET materialization_state = 'pending' WHERE document_id = ?",
            (created["document_id"],),
        )

    degraded = client.get("/api/v1/readiness")
    assert degraded.status_code == 503
    assert degraded.json()["checks"]["pending_materializations"] == {
        "ok": False,
        "detail": "pending",
        "count": 1,
    }


def test_readiness_exposes_startup_reconciliation_and_schema_failures(client: TestClient) -> None:
    client.app.state.startup_reconciliation_error = RuntimeError("injected")
    startup = client.get("/api/v1/readiness")
    assert startup.status_code == 503
    assert startup.json()["checks"]["startup_reconciliation"]["detail"] == "failed"

    client.app.state.startup_reconciliation_error = None
    database = client.app.state.services.documents.database
    with database.transaction() as connection:
        connection.execute(
            "INSERT INTO schema_migrations(version, applied_at) VALUES ('999', 'now')"
        )
    schema = client.get("/api/v1/readiness")
    assert schema.status_code == 503
    assert schema.json()["checks"]["schema"]["detail"] == "migration_mismatch"


def test_reconciliation_scan_resolves_conflicts_when_disk_is_corrected(
    client: TestClient, settings: Settings
) -> None:
    created = client.post(
        "/api/v1/documents",
        json={"title": "Self healing", "content": "canonical", "path": "self-healing.md"},
        headers=headers("self-healing-create"),
    ).json()
    path = settings.workspace_root / "self-healing.md"
    path.write_text("external", encoding="utf-8")
    first = client.post("/api/v1/reconciliation/scan").json()
    assert len(first["conflicts"]) == 1

    path.write_text("canonical", encoding="utf-8")
    second = client.post("/api/v1/reconciliation/scan").json()
    assert second["conflicts"] == []
    document = client.get(f"/api/v1/documents/{created['document_id']}").json()
    assert document["materialization_state"] == "clean"
    assert document["file_hash"] == hashlib.sha256(b"canonical").hexdigest()


def test_reconciliation_scan_resolves_removed_unknown_file(
    client: TestClient, settings: Settings
) -> None:
    unknown = settings.workspace_root / "removed.md"
    unknown.write_text("unknown", encoding="utf-8")
    assert len(client.post("/api/v1/reconciliation/scan").json()["conflicts"]) == 1
    unknown.unlink()
    assert client.post("/api/v1/reconciliation/scan").json()["conflicts"] == []


def test_pdf_upload_limit_is_enforced_while_streaming(settings: Settings) -> None:
    settings.max_pdf_bytes = 1024
    with TestClient(create_app(settings)) as client:
        chunks = iter((b"%PDF-", b"x" * 1024))
        response = client.post(
            "/api/v1/pdfs",
            params={"title": "Too large", "path": "research/large.pdf"},
            content=chunks,
            headers={**headers("large-pdf"), "Content-Type": "application/pdf"},
        )
        assert response.status_code == 422
        assert response.json()["error"]["details"]["max_pdf_bytes"] == 1024
        assert not (settings.workspace_root / "research/large.pdf").exists()
        assert client.get("/api/v1/documents").json() == []


def test_pdf_full_and_range_responses_stream_without_read_binary(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = _text_pdf()
    document = _import_pdf(client, source)
    disk = client.app.state.services.pdf_research.workspace

    def fail_full_read(_path: str) -> bytes:
        raise AssertionError("streaming response should not load the whole PDF")

    monkeypatch.setattr(disk, "read_binary", fail_full_read)
    full = client.get(f"/api/v1/pdfs/{document['document_id']}/content")
    partial = client.get(
        f"/api/v1/pdfs/{document['document_id']}/content", headers={"Range": "bytes=3-11"}
    )
    assert full.content == source
    assert partial.status_code == 206
    assert partial.content == source[3:12]


def test_pdf_extraction_claim_allows_only_one_worker(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    document = _import_pdf(client, _text_pdf(), key="claimed-pdf")
    service: PdfResearchService = client.app.state.services.pdf_research
    with service.database.transaction() as connection:
        connection.execute(
            "UPDATE pdf_documents SET extraction_status = 'pending' WHERE document_id = ?",
            (document["document_id"],),
        )

    entered = threading.Event()
    release = threading.Event()
    original_pdf_bytes = service.pdf_bytes

    def delayed_pdf_bytes(document_id: str):
        entered.set()
        assert release.wait(5)
        return original_pdf_bytes(document_id)

    monkeypatch.setattr(service, "pdf_bytes", delayed_pdf_bytes)
    first_result: list[bool] = []
    worker = threading.Thread(
        target=lambda: first_result.append(service.extract_text(document["document_id"]))
    )
    worker.start()
    assert entered.wait(5)
    assert service.extract_text(document["document_id"]) is False
    with pytest.raises(ConflictError, match="already running"):
        service.retry_extraction(document["document_id"])
    release.set()
    worker.join(5)
    assert first_result == [True]
    assert service.documents.get_document(document["document_id"]).pdf_extraction_status == "ready"


def test_startup_extraction_shutdown_is_cooperative_and_bounded(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    services = create_app(settings).state.services
    services.pdf_research.import_pdf(
        title="Pending extraction",
        path="research/pending.pdf",
        content=_text_pdf(),
        supersedes_document_id=None,
        actor_id="human:jay",
        idempotency_key="pending-extraction",
    )
    started = threading.Event()

    def wait_for_shutdown(
        _self: PdfResearchService,
        _document_id: str,
        cancel_event: threading.Event | None = None,
    ) -> bool:
        started.set()
        assert cancel_event is not None
        cancel_event.wait(5)
        return False

    monkeypatch.setattr(PdfResearchService, "extract_text", wait_for_shutdown)
    settings.pdf_extraction_shutdown_timeout_seconds = 0.2
    before = time.monotonic()
    with TestClient(create_app(settings)):
        assert started.wait(5)
    assert time.monotonic() - before < 2
