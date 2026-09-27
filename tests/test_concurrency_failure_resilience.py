from __future__ import annotations

import concurrent.futures
import contextlib
import sqlite3
import threading
from unittest.mock import MagicMock

import pytest
from conftest import headers
from fastapi.testclient import TestClient
from test_phase_five_pdf_research import import_pdf, text_pdf

from sangam.activity import ActivityService
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
    # One request must succeed (201) and the conflicting path must fail validation (422)
    assert status_codes == [201, 422], f"Unexpected status codes: {status_codes}"

    winner_resp = next(r for r in results if r.status_code == 201)
    winner_doc = winner_resp.json()
    winner_id = winner_doc["document_id"]

    # Verify winning file still exists on disk and is completely intact
    file_path = settings.workspace_root / target_path
    assert file_path.is_file(), "Winning PDF file was incorrectly deleted!"
    winner_bytes = file_path.read_bytes()
    assert winner_bytes in (pdf1, pdf2)

    # Verify document API can fetch the PDF bytes without conflict
    fetch_resp = client.get(
        f"/api/v1/pdfs/{winner_id}/content",
        headers=headers("fetch-winner-pdf"),
    )
    assert fetch_resp.status_code == 200
    assert fetch_resp.content == winner_bytes


def test_audit_service_shutdown_drains_all_in_flight_records_and_rejects_subsequent(
    client: TestClient,
) -> None:
    activity_service = client.app.state.services.activity
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_shutdown_test",
    )

    recorded_count = 10
    barrier = threading.Barrier(recorded_count)

    def producer(idx: int):
        barrier.wait()
        with contextlib.suppress(ServiceUnavailableError):
            activity_service.record(
                principal=principal,
                action="create",
                resource_type="document",
                outcome="accepted",
                resource_id=f"doc_{idx}",
                path=f"doc_{idx}.md",
            )

    threads = [threading.Thread(target=producer, args=(i,)) for i in range(recorded_count)]
    for t in threads:
        t.start()

    for t in threads:
        t.join(timeout=10)

    # Close the audit service
    activity_service.close(timeout=10.0)

    # Subsequent record attempt must immediately fail with ServiceUnavailableError
    with pytest.raises(ServiceUnavailableError, match="Activity audit logging is shutting down"):
        activity_service.record(
            principal=principal,
            action="create",
            resource_type="document",
            outcome="accepted",
            resource_id="doc_after_shutdown",
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
        # Must return 503 Service Unavailable
        assert response.status_code == 503
        data = response.json()
        assert data["error"]["code"] == "service_unavailable"

        # Check directly on the service that no document was committed
        docs = client.app.state.services.documents.list_documents()
        assert not any(d.path == "unhealthy_test.md" for d in docs)
    finally:
        activity_service._worker_healthy = original_healthy
        activity_service._worker_error = original_error

    # Now verify that when healthy, list succeeds and still no document exists
    list_resp = client.get("/api/v1/documents", headers=headers("check-no-create"))
    assert list_resp.status_code == 200
    paths = [d["path"] for d in list_resp.json()]
    assert "unhealthy_test.md" not in paths


def test_audit_service_recovers_from_transient_sqlite_busy(client: TestClient) -> None:
    real_db = client.app.state.services.activity.database
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_transient_test",
    )

    call_count = 0
    real_connect = real_db.connect

    class FlakyConnection:
        def __init__(self, raw):
            self._raw = raw

        def executemany(self, sql, params):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise sqlite3.OperationalError("database is locked")
            return self._raw.executemany(sql, params)

        def __getattr__(self, item):
            return getattr(self._raw, item)

    def flaky_connect():
        return FlakyConnection(real_connect())

    flaky_db = MagicMock()
    flaky_db.connect = flaky_connect
    service = ActivityService(flaky_db)
    try:
        service.record(
            principal=principal,
            action="update",
            resource_type="document",
            outcome="accepted",
            resource_id="doc_flaky",
            path="flaky.md",
        )
        assert call_count >= 2
        assert service.is_healthy() is True
    finally:
        service.close()


def test_audit_service_handles_large_diff_without_deadlock(client: TestClient) -> None:
    activity_service = client.app.state.services.activity
    principal = Principal.trusted_human(
        actor_id="human:jay",
        display_name="Jay",
        operation_id="op_diff_test",
    )

    huge_diff = "A" * 50_000
    # Must succeed cleanly and truncate diff without deadlock or unbounded memory
    activity_service.record(
        principal=principal,
        action="patch",
        resource_type="document",
        outcome="accepted",
        resource_id="doc_large_diff",
        details={"diff": huge_diff},
    )

    events = activity_service.list_events(resource_id="doc_large_diff")
    assert len(events) == 1
    assert "diff truncated" in events[0].details.get("diff", "")
