"""Empirical project proof against the control harness's disposable running instance."""

from __future__ import annotations

import json
import os
import sqlite3
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import httpx

from sangam.schemas import Document, ProjectDetail, ProjectDocumentItem


def main() -> None:
    url = os.environ["SANGAM_API_URL"]
    evidence = Path(os.environ["SANGAM_ARTIFACTS_DIR"]) / "projects.json"
    checks: list[str] = []
    api = httpx.Client(base_url=f"{url}/api/v1", timeout=30)
    db = sqlite3.connect(os.environ["SANGAM_DATABASE_PATH"])

    def call(
        method: str,
        path: str,
        body=None,
        *,
        key: str | None = None,
        token: str | None = None,
        expected: int = 200,
    ):
        headers = {"Idempotency-Key": key or str(uuid.uuid4())}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        response = api.request(method, path, json=body, headers=headers)
        assert response.status_code == expected, (method, path, response.status_code, response.text)
        return response

    def create_thread(token: str | None = None) -> str:
        headers = {"X-Sangam-Workspace-Context": "1"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        response = api.post(
            "/chatkit",
            headers=headers,
            json={
                "type": "threads.create",
                "params": {
                    "input": {
                        "content": [{"type": "input_text", "text": "Compare the sources"}],
                        "attachments": [],
                        "inference_options": {"model": "openai/gpt-5.4-nano"},
                    }
                },
            },
        )
        assert response.status_code == 200, response.text
        events = [
            json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
        ]
        return next(e["thread"]["id"] for e in events if e["type"] == "thread.created")

    # Real simultaneous identical create requests, including automatic ordinary Markdown brief.
    barrier = Barrier(4)

    def replay_create(_: int):
        barrier.wait()
        return ProjectDetail.model_validate(
            call(
                "POST", "/projects", {"name": "Live comparison"}, key="same-create", expected=201
            ).json()
        )

    with ThreadPoolExecutor(max_workers=4) as pool:
        creations = list(pool.map(replay_create, range(4)))
    p = creations[0]
    assert all(other == p for other in creations)
    assert db.execute("SELECT COUNT(*) FROM projects").fetchone()[0] == 1
    assert db.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == 1
    assert (
        db.execute(
            "SELECT COUNT(*) FROM operation_events "
            "WHERE resource_type='project' AND action='create'"
        ).fetchone()[0]
        == 1
    )
    call("POST", "/projects", {"name": "Changed payload"}, key="same-create", expected=409)
    checks.append("concurrent create replay: one project, one brief, one atomic accepted audit")
    project_path = f"/projects/{p.project_id}"

    token = call(
        "POST",
        "/agent-tokens",
        {
            "actor_id": "agent:project-proof",
            "display_name": "Project proof",
            "label": "Disposable proof",
            "scopes": [
                {"capability": c, "path_prefix": "public"}
                for c in ["read", "search", "create", "update"]
            ],
        },
        expected=201,
    ).json()["token"]
    for method, path, body in [
        ("GET", "/projects", None),
        ("GET", project_path, None),
        ("POST", "/projects", {"name": "Forbidden"}),
        ("PATCH", project_path, {"description": "Forbidden"}),
        ("DELETE", project_path, None),
    ]:
        response = call(method, path, body, token=token, expected=403)
        assert p.brief_document_id not in response.text
    checks.append("scoped read/write token denied every project route before reference disclosure")

    draft = Document.model_validate(
        call(
            "POST",
            "/documents",
            {
                "title": "Evaluation draft",
                "content": "# Comparison\n\nThe smaller model is enough for this task.",
            },
            expected=201,
        ).json()
    )
    source = Document.model_validate(
        call(
            "POST",
            "/documents",
            {"title": "Benchmark source", "content": "# Benchmarks\n\nOriginal measurements."},
            expected=201,
        ).json()
    )
    for doc, role in [(draft, "draft"), (source, "source")]:
        call(
            "POST",
            f"{project_path}/documents",
            {"document_id": doc.document_id, "role": role},
            expected=201,
        )
    shared = ProjectDetail.model_validate(
        call(
            "POST", "/projects", {"name": "Second use", "create_brief": False}, expected=201
        ).json()
    )
    call(
        "POST",
        f"/projects/{shared.project_id}/documents",
        {"document_id": source.document_id, "role": "decision"},
        expected=201,
    )
    checks.append("shared membership and Decision role without copied documents")

    layout = {
        "schemaVersion": 1,
        "activeGroupId": "draft",
        "recentlyClosed": [],
        "root": {
            "kind": "split",
            "id": "comparison",
            "ratio": 60,
            "direction": "horizontal",
            "first": {
                "kind": "group",
                "id": "draft",
                "activeTabId": draft.document_id,
                "tabs": [{"documentId": draft.document_id, "title": draft.title, "pinned": False}],
            },
            "second": {
                "kind": "group",
                "id": "source",
                "activeTabId": source.document_id,
                "tabs": [{"documentId": source.document_id, "title": source.title, "pinned": True}],
            },
        },
    }
    current = ProjectDetail.model_validate(call("GET", project_path).json())
    updates = {
        "expected_version": current.version,
        "active_document_id": draft.document_id,
        "workbench_state_json": json.dumps(layout),
    }
    updated = call("PATCH", project_path, updates, key="save-context").json()
    assert call("PATCH", project_path, updates, key="save-context").json() == updated
    assert json.loads(updated["workbench_state_json"]) == layout
    other_draft = Document.model_validate(
        call(
            "POST",
            "/documents",
            {"title": "Second draft", "content": "# Alternative\n\nA second working output."},
            expected=201,
        ).json()
    )
    call(
        "POST",
        f"{project_path}/documents",
        {"document_id": other_draft.document_id, "role": "draft"},
        expected=201,
    )
    updated = call("PATCH", project_path, {"active_document_id": other_draft.document_id}).json()
    chosen_layout = json.loads(updated["workbench_state_json"])
    duplicate_ids = {**layout, "root": {**layout["root"], "id": "draft"}}
    invalid = api.patch(
        project_path,
        json={
            "active_document_id": draft.document_id,
            "workbench_state_json": json.dumps(duplicate_ids),
        },
    )
    assert (chosen_layout["root"]["first"]["activeTabId"], invalid.status_code) == (
        other_draft.document_id,
        422,
    ), (chosen_layout, invalid.text)
    call("PATCH", project_path, {"active_document_id": p.brief_document_id}, expected=422)
    call("PATCH", project_path, {"workbench_state_json": "{bad"}, expected=422)
    checks.append(
        "valid split selection, distinct brief/draft, update replay and invalid-context rejection"
    )

    barrier = Barrier(2)

    def contend(name: str) -> int:
        barrier.wait()
        return api.patch(
            project_path,
            json={"name": name, "expected_version": updated["version"]},
            headers={"Idempotency-Key": str(uuid.uuid4())},
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(contend, ["First writer", "Second writer"]))
    assert sorted(statuses) == [200, 409], statuses
    checks.append("two concurrent optimistic writers: one accepted and one conflict")

    source_update = Document.model_validate(
        call(
            "PATCH",
            f"/documents/{source.document_id}",
            {
                "expected_revision_id": source.current_revision_id,
                "content": "# Benchmarks\n\nNew measurements.",
            },
        ).json()
    )
    detail = ProjectDetail.model_validate(call("GET", project_path).json())
    assert next(d for d in detail.documents if d.document_id == source.document_id).source_updated
    cleared = ProjectDocumentItem.model_validate(
        call(
            "PATCH",
            f"{project_path}/documents/{source.document_id}",
            {
                "notes": None,
                "pinned_page": None,
                "source_revision_id": source_update.current_revision_id,
            },
            key="review-source",
        ).json()
    )
    assert not cleared.source_updated and cleared.notes is None and cleared.pinned_page is None
    checks.append("source head comparison and explicit null clears persisted on a second read")

    thread_id = create_thread()
    attached = call(
        "POST", f"{project_path}/threads", {"thread_id": thread_id}, expected=201
    ).json()
    # Rename through ChatKit itself, proving the normal serialized title location is read.
    call(
        "POST",
        "/chatkit",
        {
            "type": "threads.update",
            "params": {"thread_id": thread_id, "title": "Useful comparison"},
        },
    )
    assert (
        ProjectDetail.model_validate(call("GET", project_path).json()).threads[0].title
        == "Useful comparison"
    )
    assert attached["thread_id"] == thread_id
    foreign_thread = create_thread(token)
    call("POST", f"{project_path}/threads", {"thread_id": foreign_thread}, expected=404)
    call("PATCH", project_path, {"active_thread_id": foreign_thread}, expected=404)
    call("DELETE", f"{project_path}/threads/{thread_id}", key="detach-conversation", expected=204)
    call("DELETE", f"{project_path}/threads/{thread_id}", key="detach-conversation", expected=204)
    assert ProjectDetail.model_validate(call("GET", project_path).json()).active_thread_id is None
    checks.append("real ChatKit thread attachment, title, ownership denial and detach replay")

    pdf_bytes = (
        Path(__file__).resolve().parents[1] / "frontend/e2e/assets/multipage.pdf"
    ).read_bytes()
    response = api.post(
        "/pdfs",
        params={"title": "Project PDF", "path": f"research/{uuid.uuid4()}.pdf"},
        headers={"Content-Type": "application/pdf", "Idempotency-Key": str(uuid.uuid4())},
        content=pdf_bytes,
    )
    assert response.status_code == 201, response.text
    pdf = Document.model_validate(response.json())
    call(
        "POST",
        f"{project_path}/documents",
        {"document_id": pdf.document_id, "role": "source", "pinned_page": 2},
        expected=201,
    )
    annotation = call(
        "POST",
        f"/pdfs/{pdf.document_id}/annotations",
        {"page_number": 2, "annotation_type": "comment", "note": "Useful passage", "geometry": []},
        expected=201,
    ).json()
    call(
        "POST",
        f"{project_path}/annotations",
        {"annotation_id": annotation["annotation_id"]},
        key="attach-passage",
        expected=201,
    )
    assert (
        ProjectDetail.model_validate(call("GET", project_path).json()).annotations[0].note
        == "Useful passage"
    )
    call(
        "DELETE", f"/documents/{pdf.document_id}", {"expected_revision_id": pdf.current_revision_id}
    )
    detail = ProjectDetail.model_validate(call("GET", project_path).json())
    assert detail.annotations == [] and all(
        d.document_id != pdf.document_id for d in detail.documents
    )
    call(
        "POST",
        f"{project_path}/annotations",
        {"annotation_id": annotation["annotation_id"]},
        key="attach-passage",
        expected=404,
    )
    checks.append(
        "PDF page and passage persist; trashed parent hides passages and rejects reattachment"
    )

    db.execute(
        "CREATE TRIGGER fail_project_audit BEFORE INSERT ON operation_events "
        "WHEN NEW.resource_type='project' BEGIN SELECT RAISE(ABORT,'proof audit failure'); END"
    )
    db.commit()
    before = db.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    response = api.post(
        "/projects", json={"name": "Must roll back"}, headers={"Idempotency-Key": "failed-create"}
    )
    assert response.status_code == 500, response.text
    assert db.execute("SELECT COUNT(*) FROM documents").fetchone()[0] == before
    assert (
        db.execute("SELECT COUNT(*) FROM projects WHERE name='Must roll back'").fetchone()[0] == 0
    )
    assert (
        db.execute(
            "SELECT COUNT(*) FROM mutation_idempotency_keys WHERE idempotency_key='failed-create'"
        ).fetchone()[0]
        == 0
    )
    db.execute("DROP TRIGGER fail_project_audit")
    db.commit()
    call("POST", "/projects", {"name": "Must roll back"}, key="failed-create", expected=201)
    checks.append(
        "forced commit-audit failure rolls back project, brief and replay key; retry succeeds"
    )

    call("DELETE", project_path, key="delete-project", expected=204)
    call("DELETE", project_path, key="delete-project", expected=204)
    call("GET", f"/documents/{draft.document_id}")
    assert (
        ProjectDetail.model_validate(
            call("GET", f"/projects/{shared.project_id}").json()
        ).document_count
        == 1
    )
    assert db.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    checks.append(
        "project deletion replay preserves documents and other project references; integrity ok"
    )
    evidence.write_text(
        json.dumps({"passed": len(checks), "failed": 0, "checks": checks}, indent=2) + "\n"
    )
    print(f"Projects empirical proof: {len(checks)} passed, 0 failed. {evidence}")
    api.close()
    db.close()


if __name__ == "__main__":
    main()
