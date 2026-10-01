"""Drive persistent assignments over real HTTP, including process restart.

The selected configured provider performs inference. No model output or domain
service is mocked. Storage and result files are isolated from the user's data.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import tempfile
import time
from pathlib import Path
from uuid import uuid4

import httpx

from sangam.assignments import Assignment
from sangam.schemas import ChatProposal, Document, ProjectDetail


def main() -> None:
    port = os.environ.get("SANGAM_ASSIGNMENT_VERIFY_PORT", "8897")
    report_path = Path("artifacts/assignment-verification.json")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    checks: list[str] = []
    with tempfile.TemporaryDirectory(prefix="sangam-assignments-") as temporary:
        root = Path(temporary)
        env = {
            **os.environ,
            "SANGAM_DATABASE_PATH": str(root / "database/sangam.sqlite3"),
            "SANGAM_WORKSPACE_ROOT": str(root / "workspace"),
            "SANGAM_BACKUP_ROOT": str(root / "backups"),
            "SANGAM_BACKUPS_ENABLED": "false",
        }
        log = (root / "server.log").open("w+")
        process: subprocess.Popen | None = None
        api = httpx.Client(base_url=f"http://127.0.0.1:{port}/api/v1", timeout=30)

        def start() -> None:
            nonlocal process
            process = subprocess.Popen(
                [
                    "uv",
                    "run",
                    "uvicorn",
                    "sangam.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    port,
                    "--no-access-log",
                ],
                env=env,
                stdout=log,
                stderr=log,
            )
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    log.seek(0)
                    raise RuntimeError(log.read())
                try:
                    if api.get("/readiness").status_code == 200:
                        return
                except httpx.TransportError:
                    pass
                time.sleep(0.1)
            raise RuntimeError("Isolated server did not become ready")

        def stop() -> None:
            if process and process.poll() is None:
                process.terminate()
                process.wait(timeout=40)

        def call(method: str, path: str, body=None, key: str | None = None, expected: int = 200):
            response = api.request(
                method, path, json=body, headers={"Idempotency-Key": key or str(uuid4())}
            )
            assert response.status_code == expected, (path, response.status_code, response.text)
            return response.json()

        def settled(assignment_id: str) -> Assignment:
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                assignment = Assignment.model_validate(call("GET", f"/assignments/{assignment_id}"))
                if assignment.status not in {"queued", "running"}:
                    assert assignment.status == "completed", assignment.model_dump_json()
                    return assignment
                time.sleep(0.2)
            raise RuntimeError("Assignment did not settle")

        try:
            start()
            config = call("GET", "/chat/config")
            assert config["inference_enabled"], (
                "Configure a live provider before running assignment verification"
            )
            project = ProjectDetail.model_validate(
                call("POST", "/projects", {"name": "CPU model recommendation"}, expected=201)
            )
            source = Document.model_validate(
                call(
                    "POST",
                    "/documents",
                    {
                        "title": "Benchmark",
                        "content": (
                            "Model Small used 2 GB and took 12 ms on CPU. "
                            "Model Large used 8 GB and took 40 ms. "
                            "The test used 100 short English queries. "
                            "No long-document test was performed."
                        ),
                    },
                    expected=201,
                )
            )
            draft = Document.model_validate(
                call(
                    "POST",
                    "/documents",
                    {
                        "title": "Recommendation",
                        "content": (
                            "Model Small is best for every language and every document length."
                        ),
                    },
                    expected=201,
                )
            )
            base = f"/projects/{project.project_id}"
            for document, role in [(source, "source"), (draft, "draft")]:
                call(
                    "POST",
                    base + "/documents",
                    {"document_id": document.document_id, "role": role},
                    expected=201,
                )
            call("POST", base + "/visits")
            body = {
                "instructions": (
                    "Review the recommendation. Address the weak universal claim, "
                    "strongest counterexample, and missing experiment. "
                    "Use exact quotes where available."
                ),
                "document_ids": [source.document_id, draft.document_id],
                "max_seconds": 180,
            }
            assignment = Assignment.model_validate(
                call("POST", base + "/assignments", body, "review", 201)
            )
            replay = call("POST", base + "/assignments", body, "review", 201)
            assert replay["assignment_id"] == assignment.assignment_id
            # HTTP observers detach immediately; the owning server continues.
            assignment = settled(assignment.assignment_id)
            assert assignment.artifact_ids and assignment.input_tokens > 0
            artifact = Document.model_validate(
                call("GET", f"/documents/{assignment.artifact_ids[0]}")
            )
            assert "Evidence missing" in artifact.content or "Inspect source" in artifact.content
            checks.append("live provider: project skeptic persisted findings after HTTP detached")

            # Reproduce a lost completion acknowledgement after the document
            # operation committed. Restart must use its original operation key.
            stop()
            with sqlite3.connect(env["SANGAM_DATABASE_PATH"]) as db:
                saved = assignment.model_copy(update={"status": "running", "artifact_ids": []})
                db.execute(
                    "UPDATE assignments SET status='running', data_json=? WHERE assignment_id=?",
                    (saved.model_dump_json(), assignment.assignment_id),
                )
            start()
            recovered = settled(assignment.assignment_id)
            assert recovered.artifact_ids == assignment.artifact_ids
            checks.append(
                "real process restart reconciled the original document operation without duplicates"
            )

            # Seed an ordinary revision-pinned proposal through the same domain
            # service used by capabilities, while the server is stopped.
            stop()
            from sangam.application import build_application_services
            from sangam.config import Settings
            from sangam.security import Principal

            settings = Settings(
                database_path=Path(env["SANGAM_DATABASE_PATH"]),
                workspace_root=Path(env["SANGAM_WORKSPACE_ROOT"]),
                backup_root=Path(env["SANGAM_BACKUP_ROOT"]),
                backups_enabled=False,
            )
            services = build_application_services(settings)
            principal = Principal.trusted_human(
                actor_id=settings.trusted_human_actor_id,
                display_name="Verifier",
                operation_id="seed-proposal",
            )
            proposal = services.chat.proposals.create(
                principal,
                thread_id=assignment.thread_id,
                document_id=draft.document_id,
                expected_revision_id=draft.current_revision_id,
                content="Model Small is a promising CPU option.",
                summary="Bound the recommendation",
                citations=[
                    {
                        "document_id": source.document_id,
                        "revision_id": source.current_revision_id,
                        "snippet": "No long-document test was performed.",
                    }
                ],
            )
            services.activity.close()
            start()
            revised = Document.model_validate(
                call(
                    "PATCH",
                    f"/documents/{draft.document_id}",
                    {
                        "expected_revision_id": draft.current_revision_id,
                        "content": draft.content + "\nHuman note: CPU latency matters most.",
                    },
                )
            )
            briefing = call("GET", base + "/briefing")
            assert any(
                item["revision_id"] == revised.current_revision_id for item in briefing["changes"]
            )
            assert any(item["proposal_id"] == proposal.proposal_id for item in briefing["changes"])
            boundary = briefing["since"]
            assert call("GET", base + "/briefing")["since"] == boundary
            refresh = Assignment.model_validate(
                call(
                    "POST",
                    f"/chat/proposals/{proposal.proposal_id}/refresh",
                    {
                        "feedback": (
                            "Qualify the universal claim using the benchmark. "
                            "Preserve the newer human note exactly."
                        ),
                        "reviewed_content": proposal.content,
                    },
                    expected=201,
                )
            )
            refreshed = settled(refresh.assignment_id)
            candidates = call("GET", f"/chat/proposals?document_id={draft.document_id}")
            fresh = next(
                ChatProposal.model_validate(item)
                for item in candidates
                if item["proposal_id"] in refreshed.proposal_ids
            )
            assert fresh.expected_revision_id == revised.current_revision_id
            assert "Human note: CPU latency matters most." in fresh.content
            assert any(item["proposal_id"] == proposal.proposal_id for item in candidates)
            current = Document.model_validate(call("GET", f"/documents/{draft.document_id}"))
            assert current.content == revised.content
            call(
                "POST",
                f"/chat/proposals/{fresh.proposal_id}/apply",
                {"expected_revision_id": fresh.expected_revision_id},
                expected=200,
            )
            after = call("GET", base + "/briefing")
            assert any(item["kind"] == "applied_edit" for item in after["changes"])
            checks.append(
                "stale refresh preserved the original, human edit, exact revision and human apply"
            )
            checks.append(
                "briefing reported changes, proposals and applied edits without advancing on reads"
            )

            paused = Assignment.model_validate(
                call("POST", base + "/assignments", body, "paused-review", 201)
            )
            call(
                "POST", f"/assignments/{paused.assignment_id}/control", {"action": "pause"}, "pause"
            )
            call(
                "POST",
                f"/assignments/{paused.assignment_id}/control",
                {"action": "steer", "content": "CPU matters most"},
                "steer",
            )
            stop()
            start()
            assert call("GET", f"/assignments/{paused.assignment_id}")["status"] == "paused"
            call("POST", f"/assignments/{paused.assignment_id}/control", {"action": "stop"}, "stop")
            stop()
            start()
            assert call("GET", f"/assignments/{paused.assignment_id}")["status"] == "stopped"
            checks.append(
                "pause, steering and stop survived process restarts without restarting work"
            )
            with sqlite3.connect(env["SANGAM_DATABASE_PATH"]) as db:
                assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
            report_path.write_text(
                json.dumps(
                    {
                        "checks": checks,
                        "model": config["default_model"],
                        "assignment_id": assignment.assignment_id,
                        "artifact_id": artifact.document_id,
                        "input_tokens": assignment.input_tokens,
                        "output_tokens": assignment.output_tokens,
                    },
                    indent=2,
                )
                + "\n"
            )
            print(json.dumps({"passed": len(checks), "evidence": str(report_path)}))
        finally:
            stop()
            api.close()
            log.close()


if __name__ == "__main__":
    main()
