"""Drive resource limits through HTTP against the isolated control instance."""

from __future__ import annotations

import concurrent.futures
import hashlib
import http.client
import io
import json
import os
import selectors
import socket
import sqlite3
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from pypdf import PdfWriter


def read_response(connection: socket.socket) -> tuple[int, dict[str, str], bytes]:
    response = http.client.HTTPResponse(connection)
    response.begin()
    return (
        response.status,
        {key.lower(): value for key, value in response.getheaders()},
        response.read(),
    )


def main() -> None:
    base = os.environ["SANGAM_API_URL"]
    host = urlsplit(base)
    database = Path(os.environ["SANGAM_DATABASE_PATH"])
    report: dict[str, object] = {}
    with httpx.Client(base_url=base + "/api/v1", timeout=10) as client:
        # Hold bodies incomplete so admission, rather than a fast provider,
        # controls saturation. One slot is active and one has a waiting deadline.
        body = b'{"type":"threads.list","params":{}}'
        sockets: list[socket.socket] = []
        rejected: list[str] = []
        health_ms: list[float] = []
        with sqlite3.connect(database) as db:
            runs_before = db.execute("SELECT count(*) FROM chat_runs").fetchone()[0]
        try:
            with selectors.DefaultSelector() as ready:
                for _ in range(4):
                    connection = socket.create_connection((host.hostname, host.port), timeout=5)
                    sockets.append(connection)
                    connection.sendall(
                        b"POST /api/v1/chatkit HTTP/1.1\r\nHost: localhost\r\n"
                        b"Content-Type: application/json\r\nConnection: close\r\n"
                        + f"Content-Length: {len(body)}\r\n\r\n".encode()
                        + body[:-1]
                    )
                    ready.register(connection, selectors.EVENT_READ)
                deadline = time.monotonic() + 5
                while len(rejected) < 3 and time.monotonic() < deadline:
                    started = time.perf_counter()
                    client.get("/health").raise_for_status()
                    health_ms.append((time.perf_counter() - started) * 1000)
                    for key, _ in ready.select(timeout=0.05):
                        status, headers, payload = read_response(key.fileobj)
                        assert status == 503, (status, payload)
                        assert headers["retry-after"] == "1"
                        rejected.append(json.loads(payload)["error"]["message"])
                        ready.unregister(key.fileobj)
                assert len(rejected) == 3, rejected
                assert sum("queue is full" in message for message in rejected) == 2
                assert sum("deadline expired" in message for message in rejected) == 1
                remaining = list(ready.get_map().values())
                assert len(remaining) == 1
                remaining[0].fileobj.sendall(body[-1:])
                assert read_response(remaining[0].fileobj)[0] == 200
        finally:
            for connection in sockets:
                connection.close()
        assert max(health_ms) < 500, health_ms
        with sqlite3.connect(database) as db:
            assert db.execute("SELECT count(*) FROM chat_runs").fetchone()[0] == runs_before
        report["chat_admission"] = {"rejected": rejected, "health_latency_ms": health_ms}

        # Send an oversized chunk without sending the end marker. A response
        # proves the server rejects immediately instead of awaiting the full body.
        with socket.create_connection((host.hostname, host.port), timeout=5) as connection:
            connection.sendall(
                b"POST /api/v1/chatkit HTTP/1.1\r\nHost: localhost\r\n"
                b"Content-Type: application/json\r\nTransfer-Encoding: chunked\r\n"
                b"Connection: close\r\n\r\n" + b"4268\r\n" + b"x" * 17000 + b"\r\n"
            )
            status, _, _ = read_response(connection)
            assert status == 422
        report["chunked_chat_body"] = {"status": status, "end_marker_sent": False}

        created = client.post(
            "/documents",
            headers={"Idempotency-Key": uuid.uuid4().hex},
            json={"title": "Large revision proof", "content": "first"},
        )
        created.raise_for_status()
        document = created.json()
        revisions = [document["current_revision_id"]]
        for index in range(24):
            changed = client.patch(
                f"/documents/{document['document_id']}",
                headers={"Idempotency-Key": uuid.uuid4().hex},
                json={
                    "expected_revision_id": document["current_revision_id"],
                    "content": f"revision {index}\n" + "x" * 120000,
                },
            )
            changed.raise_for_status()
            document = changed.json()
            revisions.append(document["current_revision_id"])
        first = client.get(f"/documents/{document['document_id']}/revisions?limit=5")
        first.raise_for_status()
        assert len(first.content) < 10000
        assert all("content" not in item for item in first.json()["items"])
        items: list[str] = []
        page = first.json()
        while True:
            items.extend(item["revision_id"] for item in page["items"])
            if page["next_cursor"] is None:
                break
            response = client.get(
                f"/documents/{document['document_id']}/revisions",
                params={"limit": 5, "cursor": page["next_cursor"]},
            )
            response.raise_for_status()
            page = response.json()
        assert items == list(reversed(revisions))
        exact = client.get(f"/documents/{document['document_id']}/revisions/{revisions[0]}")
        exact.raise_for_status()
        assert exact.json()["content"] == "first"
        report["revision_pages"] = {
            "revisions": len(items),
            "page_bytes": len(first.content),
            "exact_content": "first",
        }

        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        source = io.BytesIO()
        writer.write(source)
        pdf_bytes = source.getvalue()

        def upload(index: int) -> str:
            with httpx.Client(base_url=base + "/api/v1", timeout=10) as uploader:
                for _ in range(20):
                    response = uploader.post(
                        "/pdfs",
                        params={"title": f"Concurrent PDF {index}", "path": f"pdf/{index}.pdf"},
                        headers={
                            "Idempotency-Key": f"pdf-{index}",
                            "Content-Type": "application/pdf",
                        },
                        content=pdf_bytes,
                    )
                    if response.status_code != 503:
                        response.raise_for_status()
                        return response.json()["document_id"]
                    # Backpressure is explicit; retry the same immutable import key.
                    time.sleep(0.1)
                raise AssertionError("PDF upload capacity did not become available")

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as workers:
            pdf_ids = list(workers.map(upload, range(6)))
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            documents = [client.get(f"/documents/{document_id}").json() for document_id in pdf_ids]
            if all(document["pdf_extraction_status"] == "ready" for document in documents):
                break
            client.get("/health").raise_for_status()
            time.sleep(0.05)
        else:
            raise AssertionError(documents)
        for document_id in pdf_ids:
            raw = client.get(f"/pdfs/{document_id}/content")
            raw.raise_for_status()
            assert hashlib.sha256(raw.content).digest() == hashlib.sha256(pdf_bytes).digest()
        with sqlite3.connect(database) as db:
            assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            attempts = db.execute("SELECT extraction_attempts FROM pdf_documents").fetchall()
            assert all(row[0] == 1 for row in attempts)
        report["pdf_queue"] = {"ready": len(pdf_ids), "attempts": [row[0] for row in attempts]}
    output = Path(os.environ["SANGAM_ARTIFACTS_DIR"]) / "api-reliability.json"
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"Evidence: {output}")


if __name__ == "__main__":
    main()
