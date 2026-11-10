"""Prove malformed-input and backup-retention regressions on disposable services."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx

from sangam.errors import ValidationError
from sangam.web_research import BraveSearchProvider


def gateway_handler(
    body: bytes, content_type: str, status: int = 502
) -> type[BaseHTTPRequestHandler]:
    class GatewayHandler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Operation-ID", "upstream-failure")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, message: str, *args: object) -> None:
            pass

    return GatewayHandler


def verify_cli_errors() -> list[int]:
    responses = [
        (b"<html>Bad gateway</html>", "text/html"),
        (b"", "text/plain"),
        (b'["unavailable"]', "application/json"),
        (b'{"error":"unavailable"}', "application/json"),
    ]
    exits: list[int] = []
    for body, content_type in responses:
        with HTTPServer(("127.0.0.1", 0), gateway_handler(body, content_type)) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                environment = os.environ.copy()
                environment.pop("SANGAM_TOKEN", None)
                environment["SANGAM_API_URL"] = f"http://127.0.0.1:{server.server_port}"
                result = subprocess.run(
                    ["sangam", "list"],
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=20,
                    check=False,
                )
                assert result.returncode == 1, result
                payload = json.loads(result.stderr)
                if content_type == "application/json":
                    assert payload == json.loads(body), payload
                else:
                    assert "502" in payload["error"]["message"], payload
                    assert payload["error"]["operation_id"] == "upstream-failure", payload
                exits.append(result.returncode)
            finally:
                server.shutdown()
                worker.join(timeout=5)
    return exits


def verify_provider_responses() -> int:
    malformed = [
        [],
        {"web": None},
        {"web": []},
        {"web": {"results": {}}},
        {"web": {"results": [None]}},
        {"web": {"results": [{"url": 42}]}},
    ]
    for payload in malformed:
        handler = gateway_handler(json.dumps(payload).encode(), "application/json", 200)
        with HTTPServer(("127.0.0.1", 0), handler) as server:
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                provider = BraveSearchProvider("disposable-fixture-key")
                provider.endpoint = f"http://127.0.0.1:{server.server_port}/search"
                try:
                    provider.search("fixture", limit=1, published_after=None, published_before=None)
                except ValidationError as error:
                    assert "provider is unavailable" in str(error), error
                else:
                    raise AssertionError(f"Malformed provider response was accepted: {payload}")
            finally:
                server.shutdown()
                worker.join(timeout=5)
    return len(malformed)


def main() -> None:
    run_dir = Path(os.environ["SANGAM_VERIFY_RUN_DIR"])
    evidence = Path(os.environ["SANGAM_ARTIFACTS_DIR"]) / "input-failures.json"
    with httpx.Client(base_url=os.environ["SANGAM_API_URL"] + "/api/v1", timeout=30) as api:

        def post(path: str, body: dict[str, str] | None = None) -> httpx.Response:
            return api.post(path, json=body, headers={"Idempotency-Key": uuid.uuid4().hex})

        statuses = []
        for url in (
            "https://example.com:invalid/",
            "https://example.com:99999/",
            "http://[::1/",
            "https://[not-an-ip]/",
            "https://example.com\uff0fother/",
        ):
            response = post("/captures/url", {"url": url})
            assert response.status_code == 422, response.text
            assert response.json()["error"]["code"] == "validation_error", response.text
            statuses.append(response.status_code)

        response = post(
            "/documents",
            {
                "title": "Malformed link proof",
                "content_type": "text/html",
                "content": '<img src="http://[invalid/"><p>Still readable</p>',
            },
        )
        assert response.status_code == 201, response.text
        document = response.json()
        publication = post(
            "/publications",
            {
                "document_id": document["document_id"],
                "slug": "malformed-asset-proof",
                "access_policy": "public",
            },
        )
        assert publication.status_code == 201, publication.text
        content = api.get("/publications/malformed-asset-proof/content")
        assert content.status_code == 200, content.text
        assert "Still readable" in content.json()["content"], content.text
        asset = api.get(
            f"/documents/{document['document_id']}/assets", params={"path": "http://[invalid/"}
        )
        assert asset.status_code == 404, asset.text
        with sqlite3.connect(os.environ["SANGAM_DATABASE_PATH"]) as database:
            row = database.execute(
                "SELECT current_revision_id FROM documents WHERE document_id = ?",
                (document["document_id"],),
            ).fetchone()
            assert row == (document["current_revision_id"],), row

        backup = post("/backups")
        assert backup.status_code == 201, backup.text
        backup_root = run_dir / "backups"
        old_path = backup_root / "20000101T000000000000Z-00000001"
        (backup_root / backup.json()["backup_id"]).rename(old_path)
        manifest_path = old_path / "manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["backup_id"] = "../retention-victim"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        victim = run_dir / "retention-victim"
        victim.mkdir()
        marker = victim / "keep.txt"
        marker.write_text("must survive retention", encoding="utf-8")
        listing = api.get("/backups")
        assert listing.status_code == 200 and listing.json() == [], listing.text
        for _ in range(3):
            created = post("/backups")
            assert created.status_code == 201, created.text
        listing = api.get("/backups")
        assert listing.status_code == 200 and len(listing.json()) == 2, listing.text
        assert marker.read_text(encoding="utf-8") == "must survive retention"
        assert manifest_path.is_file()

        attachments = run_dir / "workspace" / "attachments"
        attachments.mkdir()
        attachment = attachments / "untracked.txt"
        attachment.write_text("must survive restore", encoding="utf-8")
        failure_statuses = []
        for target in (attachment, attachments):
            permissions = target.stat().st_mode
            target.chmod(0)
            key = uuid.uuid4().hex
            try:
                failed = api.post("/backups", headers={"Idempotency-Key": key})
                assert failed.status_code == 500, failed.text
                assert not list(backup_root.glob(".sangam-backup-*"))
                failure_statuses.append(failed.status_code)
            finally:
                target.chmod(permissions)
            recovered = api.post("/backups", headers={"Idempotency-Key": key})
            assert recovered.status_code == 201, recovered.text
            verified = api.post(f"/backups/{recovered.json()['backup_id']}/verify")
            assert verified.status_code == 200 and verified.json()["valid"], verified.text

        restored = run_dir / "restored-proof"
        subprocess.run(
            [
                sys.executable,
                "scripts/restore-backup.py",
                recovered.json()["backup_id"],
                "--backup-root",
                str(backup_root),
                "--database-path",
                str(restored / "database.sqlite3"),
                "--workspace-root",
                str(restored / "workspace"),
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        assert (restored / "workspace/attachments/untracked.txt").read_text(
            encoding="utf-8"
        ) == "must survive restore"

    report = {
        "capture_statuses": statuses,
        "publication_status": content.status_code,
        "asset_status": asset.status_code,
        "persisted_revision": document["current_revision_id"],
        "retained_backups": len(listing.json()),
        "retention_victim_survived": marker.is_file(),
        "cli_gateway_exit_codes": verify_cli_errors(),
        "unreadable_backup_statuses": failure_statuses,
        "attachment_restored_after_permission_recovery": True,
        "malformed_provider_http_responses_rejected": verify_provider_responses(),
    }
    evidence.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(evidence)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
