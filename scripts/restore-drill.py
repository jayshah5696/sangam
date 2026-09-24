from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import httpx
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def text_pdf(text: str) -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_reference = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_reference})}
    )
    stream = DecodedStreamObject()
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream.set_data(f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a backup, restore it into empty storage, and verify a booted Sangam."
    )
    parser.add_argument("--port", type=int, default=8998)
    parser.add_argument("--work-root", type=Path)
    parser.add_argument("--artifact", type=Path)
    parser.add_argument("--keep", action="store_true", help="Keep temporary drill state")
    return parser.parse_args()


def wait_ready(base_url: str, process: subprocess.Popen[str]) -> dict[str, Any]:
    deadline = time.monotonic() + 30
    last_error = "unknown"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Sangam exited before readiness (code {process.returncode})")
        try:
            response = httpx.get(f"{base_url}/api/v1/readiness", timeout=2)
            if response.status_code == 200:
                payload = response.json()
                if payload.get("status") == "ready":
                    return payload
                last_error = json.dumps(payload, sort_keys=True)
        except httpx.HTTPError as error:
            last_error = str(error)
        time.sleep(0.25)
    raise RuntimeError(f"Sangam did not become ready: {last_error}")


def start_instance(root: Path, port: int) -> subprocess.Popen[str]:
    env = os.environ.copy()
    env.update(
        {
            "SANGAM_DATABASE_PATH": str(root / "database" / "sangam.sqlite3"),
            "SANGAM_WORKSPACE_ROOT": str(root / "workspace"),
            "SANGAM_BACKUP_ROOT": str(root / "backups"),
            "SANGAM_BACKUPS_ENABLED": "true",
            "SANGAM_FRONTEND_DIST": str(Path.cwd() / "frontend" / "dist"),
            "SANGAM_API_URL": f"http://127.0.0.1:{port}",
        }
    )
    log = (root / "sangam.log").open("w", encoding="utf-8")
    return subprocess.Popen(
        ["uv", "run", "uvicorn", "sangam.main:app", "--host", "127.0.0.1", "--port", str(port)],
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
        text=True,
    )


def stop_instance(process: subprocess.Popen[str]) -> None:
    if process.poll() is None:
        process.send_signal(signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def require(response: httpx.Response, expected: int) -> dict[str, Any]:
    if response.status_code != expected:
        raise RuntimeError(
            f"{response.request.method} {response.request.url} returned "
            f"{response.status_code}: {response.text}"
        )
    return response.json()


def main() -> None:
    args = parse_args()
    owned_root = args.work_root is None
    root = args.work_root or Path(tempfile.mkdtemp(prefix="sangam-restore-drill-"))
    if not owned_root and root.exists() and any(root.iterdir()):
        raise RuntimeError(f"supplied work root must be empty: {root}")
    source = root / "source"
    restored = root / "restored"
    source.mkdir(parents=True, exist_ok=True)
    restored.mkdir(parents=True, exist_ok=True)
    process: subprocess.Popen[str] | None = None
    restored_process: subprocess.Popen[str] | None = None
    result: dict[str, Any] = {"work_root": str(root), "checks": {}}
    pdf_bytes = text_pdf("Restore drill PDF search phrase")
    artifact = args.artifact or Path("artifacts/restore-drill") / f"{int(time.time())}.json"
    try:
        process = start_instance(source, args.port)
        base_url = f"http://127.0.0.1:{args.port}"
        result["checks"]["source_readiness"] = wait_ready(base_url, process)
        with httpx.Client(base_url=base_url, timeout=10) as client:
            document = require(
                client.post(
                    "/api/v1/documents",
                    json={
                        "title": "Restore drill note",
                        "content": "Restore drill search phrase, revision one.\n",
                        "path": "recovery/restore-drill.md",
                    },
                    headers={"Idempotency-Key": "restore-drill-create"},
                ),
                201,
            )
            updated = require(
                client.patch(
                    f"/api/v1/documents/{document['document_id']}",
                    json={
                        "expected_revision_id": document["current_revision_id"],
                        "content": "Restore drill search phrase, revision two.\n",
                    },
                    headers={"Idempotency-Key": "restore-drill-update"},
                ),
                200,
            )
            pdf = require(
                client.post(
                    "/api/v1/pdfs",
                    params={"title": "Restore drill PDF", "path": "recovery/restore-drill.pdf"},
                    content=pdf_bytes,
                    headers={
                        "Content-Type": "application/pdf",
                        "Idempotency-Key": "restore-drill-pdf",
                    },
                ),
                201,
            )
            backup = require(
                client.post("/api/v1/backups", headers={"Idempotency-Key": "restore-drill-backup"}),
                201,
            )
            if backup["verified_at"] is None:
                raise RuntimeError("created backup is not verified")
            verification = require(
                client.post(f"/api/v1/backups/{backup['backup_id']}/verify"),
                200,
            )
            if not verification["valid"] or verification["database_integrity"] != "ok":
                raise RuntimeError("backup verification did not pass")
            result["checks"]["backup"] = {
                "backup_id": backup["backup_id"],
                "document_count": backup["document_count"],
                "revision_count": backup["revision_count"],
                "verified": verification["valid"],
            }
            result["document_id"] = document["document_id"]
            result["revision_id"] = updated["current_revision_id"]
            result["pdf_id"] = pdf["document_id"]
        stop_instance(process)
        if process.poll() is None:
            raise RuntimeError("source Sangam process did not stop before restore")
        result["checks"]["source_stopped_before_restore"] = True
        process = None

        restore_db = restored / "database" / "sangam.sqlite3"
        restore_workspace = restored / "workspace"
        restore_backup_root = restored / "backups"
        restore_backup_root.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source / "backups", restore_backup_root)
        restore_command = [
            "uv",
            "run",
            "python",
            "scripts/restore-backup.py",
            backup["backup_id"],
            "--backup-root",
            str(restore_backup_root),
            "--database-path",
            str(restore_db),
            "--workspace-root",
            str(restore_workspace),
        ]
        restore = subprocess.run(restore_command, check=True, capture_output=True, text=True)
        result["checks"]["restore"] = restore.stdout.strip()

        restored_process = start_instance(restored, args.port)
        result["checks"]["restored_readiness"] = wait_ready(base_url, restored_process)
        with httpx.Client(base_url=base_url, timeout=10) as client:
            restored_doc = require(client.get(f"/api/v1/documents/{document['document_id']}"), 200)
            history = require(
                client.get(f"/api/v1/documents/{document['document_id']}/history"), 200
            )
            search = require(client.get("/api/v1/search", params={"q": "revision two"}), 200)
            restored_pdf = client.get(f"/api/v1/pdfs/{pdf['document_id']}/content")
            if restored_doc["current_revision_id"] != updated["current_revision_id"]:
                raise RuntimeError("restored current revision does not match backup")
            if len(history) != 2 or not any(
                revision["content"] == document["content"] for revision in history
            ):
                raise RuntimeError(f"expected two revisions after restore, found {len(history)}")
            if not any(item["document_id"] == document["document_id"] for item in search):
                raise RuntimeError("restored FTS search did not find the current revision")
            pdf_search = require(
                client.get(
                    f"/api/v1/pdfs/{pdf['document_id']}/search",
                    params={"q": "PDF search phrase"},
                ),
                200,
            )
            if restored_pdf.status_code != 200 or restored_pdf.content != pdf_bytes:
                raise RuntimeError("restored PDF bytes do not match the source bytes")
            if not pdf_search:
                raise RuntimeError("restored PDF search did not find its indexed phrase")
            result["checks"]["revisions"] = {
                "count": len(history),
                "current_revision_id": restored_doc["current_revision_id"],
            }
            result["checks"]["search"] = {"matches": len(search), "query": "revision two"}
            result["checks"]["pdf_search"] = {"matches": len(pdf_search)}
            result["checks"]["pdf_sha256"] = hashlib.sha256(restored_pdf.content).hexdigest()
        artifact.parent.mkdir(parents=True, exist_ok=True)
        result["artifact"] = str(artifact)
        artifact.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(json.dumps(result, indent=2, sort_keys=True))
    except Exception as error:
        artifact.parent.mkdir(parents=True, exist_ok=True)
        result.update({"artifact": str(artifact), "error": str(error), "ok": False})
        artifact.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        raise
    finally:
        if process is not None:
            stop_instance(process)
        if restored_process is not None:
            stop_instance(restored_process)
        if owned_root and not args.keep:
            shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"restore drill failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
