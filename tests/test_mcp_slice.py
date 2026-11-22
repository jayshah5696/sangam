"""Exercise the real mounted protocol, Monty worker, and canonical write service.

Failure cases established before implementation: anonymous single-user access;
scope/ownership/revocation bypass; interpreter state leaking between calls;
lost/duplicate writes; failure after commit; stale saves erasing recoverable
drafts; and an old checkpoint acknowledgement clearing newer edits.
"""

import base64
import json
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from time import monotonic
from uuid import uuid4

import pytest
from conftest import issue_agent_token
from fastapi.testclient import TestClient
from test_phase_five_pdf_research import import_pdf, text_pdf

from sangam.api import create_app
from sangam.config import Settings
from sangam.db import Database


@pytest.fixture
def mcp_client(settings: Settings) -> Iterator[TestClient]:
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as client:
        yield client


def rpc(client: TestClient, token: str, name: str, arguments: dict) -> dict:
    response = client.post(
        "/mcp",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2025-11-25",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    assert "error" not in payload, payload
    return payload["result"]


def execute(client: TestClient, token: str, code: str, key: str | None = None) -> dict:
    return rpc(client, token, "execute", {"code": code, "execution_key": key or str(uuid4())})


def seed(client: TestClient, path: str = "mcp/guide.md") -> dict:
    response = client.post(
        "/api/v1/documents",
        headers={"Idempotency-Key": str(uuid4())},
        json={
            "title": "MCP slice guide",
            "path": path,
            "content_type": "text/markdown",
            "content": "# Original\n\nFindable sangamneedle.",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def app_action(client: TestClient, token: str, action: dict) -> dict:
    return rpc(client, token, "mcp_app", {"action": action})


def test_workspace_resource_uses_current_authority_and_preserves_dirty_state(
    mcp_client: TestClient,
) -> None:
    """Resource reads must not save drafts or reveal another actor's checkpoint."""
    document = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read", "search", "update"))
    opened = rpc(mcp_client, token, "present", {"document_id": document["document_id"]})[
        "structuredContent"
    ]
    workspace_id = opened["workspace_id"]
    app_action(
        mcp_client,
        token,
        {
            "type": "checkpoint",
            "workspace_id": workspace_id,
            "expected_version": opened["version"],
            "content": "# Unsaved resource draft",
        },
    )

    def read(key: str) -> dict:
        response = mcp_client.post(
            "/mcp",
            headers={
                "Authorization": f"Bearer {key}",
                "Accept": "application/json, text/event-stream",
            },
            json={
                "jsonrpc": "2.0",
                "id": 9,
                "method": "resources/read",
                "params": {"uri": f"sangam://workspace/{workspace_id}"},
            },
        )
        assert response.status_code == 200
        return response.json()

    resource = read(token)
    assert "error" not in resource, resource
    snapshot = json.loads(resource["result"]["contents"][0]["text"])
    assert snapshot["draft"] == "# Unsaved resource draft"
    assert snapshot["document"]["content"] == document["content"]
    other = issue_agent_token(mcp_client, actor_id="agent:other-resource-reader")
    assert "error" in read(other)


def test_private_mcp_has_no_single_user_fallback(mcp_client: TestClient) -> None:
    response = mcp_client.post(
        "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    )
    assert response.status_code == 401


def test_pdf_pages_bytes_notes_and_failure_recovery_share_existing_authority(
    mcp_client: TestClient,
) -> None:
    source = text_pdf("MCP PDF needle")
    imported = import_pdf(mcp_client, content=source, key="mcp-pdf", path="mcp/paper.pdf")
    assert imported.status_code == 201
    document = imported.json()
    identifier = document["document_id"]
    token = issue_agent_token(
        mcp_client, capabilities=("read", "search", "update"), path_prefix="mcp/"
    )
    contracts = []
    offset = 0
    while True:
        page = rpc(mcp_client, token, "search", {"query": "", "limit": 2, "offset": offset})[
            "structuredContent"
        ]
        contracts.extend(operation["operation_id"] for operation in page["operations"])
        if page["next_offset"] is None:
            break
        offset = page["next_offset"]
    assert len(contracts) == len(set(contracts)) and "pdf.pages.read" in contracts
    opened = rpc(mcp_client, token, "present", {"document_id": identifier})
    assert not opened.get("isError"), opened
    workspace = opened["structuredContent"]
    assert workspace["location"]["kind"] == "pdf" and workspace["can_update"] is False
    passage = execute(
        mcp_client, token, f"await pdf_pages_read(document_id='{identifier}', page_number=1)"
    )
    assert "MCP PDF needle" in passage["structuredContent"]["output"]["text"]
    data = app_action(
        mcp_client,
        token,
        {
            "type": "pdf_bytes",
            "document_id": identifier,
            "expected_revision_id": document["current_revision_id"],
            "offset": 0,
            "length": 64,
        },
    )
    assert base64.b64decode(data["structuredContent"]["bytes"]) == source[:64]
    assert data["structuredContent"]["next_offset"] == 64
    assert app_action(
        mcp_client,
        token,
        {
            "type": "pdf_bytes",
            "document_id": identifier,
            "expected_revision_id": "wrong",
            "offset": 0,
        },
    )["isError"]
    key = str(uuid4())
    program = (
        f"await pdf_annotations_create(document_id='{identifier}', "
        "page_number=1, note='MCP note', operation_key='pdf-note')\n1 / 0"
    )
    failed = execute(mcp_client, token, program, key)
    assert failed["isError"]
    evidence = failed["structuredContent"]["writes"][0]
    assert evidence["outcome"] == "committed" and evidence["resource_type"] == "annotation"
    assert evidence["resource_id"]
    assert (
        execute(mcp_client, token, program, key)["structuredContent"] == failed["structuredContent"]
    )
    notes = mcp_client.get(f"/api/v1/pdfs/{identifier}/annotations").json()
    assert len(notes) == 1 and notes[0]["note"] == "MCP note"
    readonly = issue_agent_token(mcp_client, capabilities=("read",), path_prefix="mcp/")
    denied = execute(mcp_client, readonly, program)
    assert denied["isError"]
    outside = issue_agent_token(mcp_client, actor_id="agent:outside-pdf", path_prefix="private/")
    assert execute(
        mcp_client, outside, f"await pdf_pages_read(document_id='{identifier}', page_number=1)"
    )["isError"]
    assert app_action(
        mcp_client,
        outside,
        {
            "type": "pdf_bytes",
            "document_id": identifier,
            "expected_revision_id": document["current_revision_id"],
        },
    )["isError"]
    refreshed = app_action(
        mcp_client, token, {"type": "refresh", "workspace_id": workspace["workspace_id"]}
    )["structuredContent"]
    assert refreshed["document"]["annotation_version"] > workspace["document"]["annotation_version"]
    assert mcp_client.get(f"/api/v1/pdfs/{identifier}/content").content == source
    database = mcp_client.app.state.services.documents.database
    with database.transaction() as connection:
        connection.execute(
            "UPDATE pdf_documents SET extraction_status = 'processing' WHERE document_id = ?",
            (identifier,),
        )
    pending = execute(mcp_client, token, f"await pdf_status(document_id='{identifier}')\nTrue")[
        "structuredContent"
    ]
    assert pending["output"] is True
    assert pending["pending_jobs"][0]["resource_uri"] == f"sangam://document/{identifier}"
    with database.transaction() as connection:
        connection.execute(
            "UPDATE pdf_documents SET extraction_status = 'ready' WHERE document_id = ?",
            (identifier,),
        )


def test_comparison_and_location_restore_without_touching_content(mcp_client: TestClient) -> None:
    """View writes need read access; stale views and foreign references must fail."""
    first, second = seed(mcp_client, "mcp/first.md"), seed(mcp_client, "mcp/second.md")
    token = issue_agent_token(mcp_client, path_prefix="mcp/")
    opened = rpc(
        mcp_client,
        token,
        "present",
        {
            "document_id": first["document_id"],
            "additional_document_ids": [second["document_id"]],
        },
    )["structuredContent"]
    first_id, second_id = [tab["workspace_id"] for tab in opened["layout"]["tabs"]]
    compared = app_action(
        mcp_client,
        token,
        {
            "type": "compare",
            "workspace_id": first_id,
            "target_workspace_id": second_id,
            "expected_layout_version": opened["layout"]["version"],
        },
    )
    assert not compared.get("isError"), compared
    view = compared["structuredContent"]
    assert view["comparison"]["document"]["document_id"] == second["document_id"]
    location = {"kind": "text", "anchor": 4, "head": 12, "scroll_top": 96}
    changed = app_action(
        mcp_client,
        token,
        {
            "type": "view",
            "workspace_id": first_id,
            "expected_view_version": view["view_version"],
            "location": location,
        },
    )
    assert not changed.get("isError"), changed
    assert changed["structuredContent"]["version"] == opened["version"]
    stale = app_action(
        mcp_client,
        token,
        {
            "type": "view",
            "workspace_id": first_id,
            "expected_view_version": view["view_version"],
            "location": location,
        },
    )
    assert stale["isError"]
    restored = rpc(mcp_client, token, "present", {"layout_id": view["layout"]["layout_id"]})[
        "structuredContent"
    ]
    assert restored["location"] == location
    assert restored["comparison"]["workspace_id"] == second_id
    other = rpc(mcp_client, token, "present", {"document_id": second["document_id"]})[
        "structuredContent"
    ]
    assert app_action(
        mcp_client,
        token,
        {
            "type": "compare",
            "workspace_id": first_id,
            "target_workspace_id": other["workspace_id"],
            "expected_layout_version": restored["layout"]["version"],
        },
    )["isError"]
    closed = app_action(
        mcp_client,
        token,
        {
            "type": "close",
            "workspace_id": first_id,
            "target_workspace_id": second_id,
            "expected_layout_version": restored["layout"]["version"],
        },
    )
    assert not closed.get("isError"), closed
    assert closed["structuredContent"]["comparison"] is None
    assert (
        mcp_client.get(f"/api/v1/documents/{first['document_id']}").json()["current_revision_id"]
        == first["current_revision_id"]
    )


@pytest.mark.parametrize("built_frontend", [False, True])
def test_both_mcp_paths_authenticate_with_production_route_topology(
    settings: Settings, tmp_path: Path, built_frontend: bool
) -> None:
    settings.mcp_enabled = True
    if built_frontend:
        settings.frontend_dist = tmp_path / "frontend"
        settings.frontend_dist.mkdir()
        (settings.frontend_dist / "index.html").write_text("<!doctype html><title>Sangam</title>")
    with TestClient(create_app(settings), root_path="/prefix") as client:
        token = issue_agent_token(client)
        for path in ("/prefix/mcp", "/prefix/mcp/"):
            assert client.get(path).status_code == 401
            assert client.post(path, json={}).status_code == 401
            response = client.post(
                path,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json, text/event-stream",
                },
                json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
            )
            assert response.status_code == 200
            assert {tool["name"] for tool in response.json()["result"]["tools"]} == {
                "search",
                "execute",
                "present",
                "mcp_app",
            }


def test_trashed_dependency_keeps_authorized_write_recovery(mcp_client: TestClient) -> None:
    dependency = seed(mcp_client)
    target = seed(mcp_client, "mcp/write-target.md")
    token = issue_agent_token(mcp_client, capabilities=("read", "update"), path_prefix="mcp/")
    code = (
        f"await documents_read(document_id='{dependency['document_id']}')\n"
        f"await documents_update(document_id='{target['document_id']}', "
        f"expected_revision_id='{target['current_revision_id']}', "
        "content='# Preserved write', operation_key='trash-recovery-write')\n1 / 0"
    )
    original = execute(mcp_client, token, code, "trash-recovery")["structuredContent"]
    deleted = mcp_client.request(
        "DELETE",
        f"/api/v1/documents/{dependency['document_id']}",
        headers={"Idempotency-Key": str(uuid4())},
        json={"expected_revision_id": dependency["current_revision_id"]},
    )
    assert deleted.status_code == 200
    repeated = execute(mcp_client, token, code, "trash-recovery")["structuredContent"]
    assert repeated["writes"] == original["writes"]
    recovered = execute(mcp_client, token, "await executions_get(execution_key='trash-recovery')")
    assert recovered["structuredContent"]["output"]["writes"][0]["outcome"] == "committed"
    resource = mcp_client.post(
        "/mcp/",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "resources/read",
            "params": {"uri": "sangam://execution/trash-recovery"},
        },
    )
    assert "error" not in resource.json()
    assert '"outcome": "committed"' in resource.json()["result"]["contents"][0]["text"]
    narrowed = issue_agent_token(mcp_client, capabilities=("read",), path_prefix="elsewhere/")
    assert execute(mcp_client, narrowed, code, "trash-recovery")["isError"] is True


def test_python_can_handle_callback_failure_and_reports_later_error(mcp_client: TestClient) -> None:
    token = issue_agent_token(mcp_client)
    handled = "try:\n    await documents_read(document_id='missing')\nexcept Exception:\n    pass\n"
    assert execute(mcp_client, token, handled + "42")["structuredContent"] == {"output": 42}
    later = execute(mcp_client, token, handled + "1 / 0")
    assert later["isError"] is True
    assert later["structuredContent"]["error"]["code"] == "execution_failed"
    assert "ZeroDivisionError" in later["structuredContent"]["error"]["message"]
    uncaught = execute(mcp_client, token, "await documents_read(document_id='missing')")
    assert uncaught["structuredContent"]["error"]["code"] == "not_found"


def test_present_rejects_mismatched_document_and_workspace(mcp_client: TestClient) -> None:
    first = seed(mcp_client)
    second = seed(mcp_client, "mcp/second.md")
    token = issue_agent_token(mcp_client, capabilities=("read",), path_prefix="mcp/")
    opened = rpc(mcp_client, token, "present", {"document_id": second["document_id"]})[
        "structuredContent"
    ]
    mismatch = rpc(
        mcp_client,
        token,
        "present",
        {"document_id": first["document_id"], "workspace_id": opened["workspace_id"]},
    )
    assert mismatch["isError"] is True
    assert mismatch["structuredContent"]["error"]["code"] == "validation_error"


def test_inflight_duplicate_returns_explicit_incomplete_receipt(mcp_client: TestClient) -> None:
    document = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("update",), path_prefix="mcp/")
    services = mcp_client.app.state.services
    code = (
        f"await documents_update(document_id='{document['document_id']}', "
        f"expected_revision_id='{document['current_revision_id']}', "
        "content='# Once', operation_key='blocked-once')"
    )
    with ThreadPoolExecutor(max_workers=1) as pool:
        with services.documents.mutations.documents(document["document_id"]):
            first = pool.submit(execute, mcp_client, token, code, "blocked")
            deadline = monotonic() + 5
            while monotonic() < deadline:
                with services.documents.database.connection() as connection:
                    admitted = connection.execute(
                        "SELECT 1 FROM mcp_execution_writes WHERE execution_key = 'blocked'"
                    ).fetchone()
                if admitted:
                    break
                Event().wait(0.01)
            assert admitted is not None
            pending = execute(mcp_client, token, code, "blocked")
            assert pending["isError"] is False
            assert pending["structuredContent"]["status"] == "running"
            assert pending["structuredContent"]["output_available"] is False
            assert pending["structuredContent"]["reason"] == "in_progress"
        assert first.result()["isError"] is False
    assert (
        mcp_client.get(f"/api/v1/documents/{document['document_id']}").json()["content"] == "# Once"
    )


def test_cancelled_wait_keeps_write_evidence_when_the_commit_finishes(
    mcp_client: TestClient,
) -> None:
    document = seed(mcp_client)
    second_document = seed(mcp_client, "mcp/second-cancelled.md")
    token = issue_agent_token(mcp_client, capabilities=("read", "update"), path_prefix="mcp/")
    services = mcp_client.app.state.services
    runtime = mcp_client.app.state.mcp_runtime
    portal = mcp_client.portal
    assert portal is not None
    code = (
        f"await documents_update(document_id='{document['document_id']}', "
        f"expected_revision_id='{document['current_revision_id']}', "
        "content='# Commit after cancellation', operation_key='cancelled-write')"
    )
    with services.documents.mutations.documents(
        document["document_id"], second_document["document_id"]
    ):
        waiting = portal.start_task_soon(runtime.execute, token, code, "cancelled-execution")
        second_code = (
            code.replace(document["document_id"], second_document["document_id"])
            .replace(document["current_revision_id"], second_document["current_revision_id"])
            .replace("cancelled-write", "cancelled-write-two")
        )
        second_waiting = portal.start_task_soon(
            runtime.execute, token, second_code, "cancelled-execution-two"
        )
        deadline = monotonic() + 5
        admitted = None
        while monotonic() < deadline:
            with services.documents.database.connection() as connection:
                admitted = connection.execute(
                    "SELECT count(*) FROM mcp_execution_writes "
                    "WHERE execution_key IN ('cancelled-execution', 'cancelled-execution-two')"
                ).fetchone()[0]
            if admitted == 2:
                break
            Event().wait(0.01)
        assert admitted == 2
        waiting.cancel()
        second_waiting.cancel()
        assert waiting.cancelled()
        assert second_waiting.cancelled()
        saturated = execute(mcp_client, token, "42", "no-unbounded-host-queue")
        assert saturated["isError"] is True
        assert "capacity is full" in saturated["structuredContent"]["error"]["message"]
    deadline = monotonic() + 5
    while monotonic() < deadline:
        saved = mcp_client.get(f"/api/v1/documents/{document['document_id']}").json()
        if saved["content"] == "# Commit after cancellation":
            break
        Event().wait(0.01)
    assert saved["content"] == "# Commit after cancellation"
    recovered = mcp_client.post(
        "/mcp/",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "resources/read",
            "params": {"uri": "sangam://execution/cancelled-execution"},
        },
    )
    assert recovered.status_code == 200
    evidence = json.loads(recovered.json()["result"]["contents"][0]["text"])
    assert evidence["status"] == "interrupted"
    assert evidence["output_available"] is False
    assert evidence["writes"][0]["outcome"] == "committed"
    assert evidence["writes"][0]["revision_id"] == saved["current_revision_id"]


def test_discovery_and_real_monty_are_scoped_and_fresh(mcp_client: TestClient) -> None:
    document = seed(mcp_client)
    private = seed(mcp_client, "private/secret.md")
    token = issue_agent_token(mcp_client, capabilities=("read", "search"), path_prefix="mcp/")
    discovery = rpc(mcp_client, token, "search", {"query": "documents.read"})
    assert "documents_read" in str(discovery)
    result = execute(
        mcp_client,
        token,
        "hits = await documents_search(query='sangamneedle')\n"
        "[h['document_id'] for h in hits['items']]",
    )
    assert result["structuredContent"]["output"] == [document["document_id"]]
    denied = execute(
        mcp_client, token, f"await documents_read(document_id='{private['document_id']}')"
    )
    assert denied["isError"] is True
    assert "Findable" not in str(denied)
    assert (
        execute(mcp_client, token, "hidden_value = 42\nhidden_value")["structuredContent"]["output"]
        == 42
    )
    assert execute(mcp_client, token, "hidden_value")["isError"] is True
    assert execute(mcp_client, token, "open('/etc/passwd').read()")["isError"] is True


def test_failure_after_write_and_duplicate_delivery_do_not_repeat_commit(
    mcp_client: TestClient,
) -> None:
    document = seed(mcp_client)
    token = issue_agent_token(
        mcp_client, capabilities=("read", "search", "update"), path_prefix="mcp/"
    )
    key = str(uuid4())
    code = (
        f"await documents_update(document_id='{document['document_id']}', "
        f"expected_revision_id='{document['current_revision_id']}', "
        "content='# Committed', operation_key='write-once')\n1 / 0"
    )
    failed = execute(mcp_client, token, code, key)
    assert failed["isError"] is True
    committed = failed["structuredContent"]["writes"][0]
    assert committed["outcome"] == "committed"
    assert committed["revision_id"] != document["current_revision_id"]
    before = mcp_client.get(f"/api/v1/documents/{document['document_id']}/history").json()
    replay = execute(mcp_client, token, code, key)
    assert replay["structuredContent"]["writes"] == failed["structuredContent"]["writes"]
    assert mcp_client.get(f"/api/v1/documents/{document['document_id']}/history").json() == before
    assert execute(mcp_client, token, "42", key)["isError"] is True


def test_reused_write_key_cannot_report_an_unrelated_commit(mcp_client: TestClient) -> None:
    first = seed(mcp_client)
    second = seed(mcp_client, "mcp/second.md")
    token = issue_agent_token(mcp_client, capabilities=("update",), path_prefix="mcp/")

    def program(document: dict, content: str) -> str:
        return (
            f"await documents_update(document_id='{document['document_id']}', "
            f"expected_revision_id='{document['current_revision_id']}', "
            f"content='{content}', operation_key='shared-write-key')"
        )

    committed = execute(mcp_client, token, program(first, "# First commit"))
    assert committed["isError"] is False
    for document in (first, second):
        rejected = execute(mcp_client, token, program(document, "# Different request"))
        assert rejected["isError"] is True
        assert rejected["structuredContent"]["error"]["code"] == "idempotency_conflict"
        assert rejected["structuredContent"]["writes"][0]["outcome"] == "rejected"
        assert rejected["structuredContent"]["writes"][0]["revision_id"] is None
    assert (
        mcp_client.get(f"/api/v1/documents/{first['document_id']}").json()["content"]
        == "# First commit"
    )
    assert (
        mcp_client.get(f"/api/v1/documents/{second['document_id']}").json()["content"]
        == second["content"]
    )
    same_program = execute(
        mcp_client,
        token,
        program(first, "# First commit") + "\n" + program(second, "# Different request"),
    )
    assert same_program["isError"] is True
    assert same_program["structuredContent"]["writes"][0]["outcome"] == "committed"
    assert same_program["structuredContent"]["writes"][0]["document_id"] == first["document_id"]


def test_execution_resource_recovers_at_receipt_quota(settings: Settings) -> None:
    settings.mcp_enabled = True
    settings.mcp_max_executions_per_actor = 1
    with TestClient(create_app(settings)) as client:
        token = issue_agent_token(client)
        assert execute(client, token, "42", "retained")["isError"] is False
        assert execute(client, token, "43", "new")["isError"] is True
        recovered = client.post(
            "/mcp/",
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json, text/event-stream",
            },
            json={
                "jsonrpc": "2.0",
                "id": 1,
                "method": "resources/read",
                "params": {"uri": "sangam://execution/retained"},
            },
        )
        assert recovered.status_code == 200
        assert '"output": 42' in recovered.json()["result"]["contents"][0]["text"]


def test_app_checkpoint_conflict_recovery_and_save(mcp_client: TestClient) -> None:
    document = seed(mcp_client)
    token = issue_agent_token(
        mcp_client, capabilities=("read", "search", "update"), path_prefix="mcp/"
    )
    opened = rpc(mcp_client, token, "present", {"document_id": document["document_id"]})[
        "structuredContent"
    ]
    workspace_id = opened["workspace_id"]
    checkpoint = app_action(
        mcp_client,
        token,
        {
            "type": "checkpoint",
            "workspace_id": workspace_id,
            "expected_version": opened["version"],
            "content": "# My recoverable draft",
        },
    )["structuredContent"]
    recovered = app_action(mcp_client, token, {"type": "refresh", "workspace_id": workspace_id})[
        "structuredContent"
    ]
    assert recovered["draft"] == "# My recoverable draft"
    assert (
        mcp_client.get(f"/api/v1/documents/{document['document_id']}").json()["content"]
        == document["content"]
    )
    changed = mcp_client.patch(
        f"/api/v1/documents/{document['document_id']}",
        headers={"Idempotency-Key": str(uuid4())},
        json={
            "content": "# Changed elsewhere",
            "expected_revision_id": document["current_revision_id"],
        },
    )
    assert changed.status_code == 200
    stale = app_action(
        mcp_client,
        token,
        {
            "type": "save",
            "workspace_id": workspace_id,
            "expected_version": checkpoint["version"],
            "operation_key": "stale-save",
        },
    )
    assert stale["isError"] is True
    assert (
        app_action(mcp_client, token, {"type": "refresh", "workspace_id": workspace_id})[
            "structuredContent"
        ]["draft"]
        == "# My recoverable draft"
    )
    discarded = app_action(
        mcp_client,
        token,
        {
            "type": "discard",
            "workspace_id": workspace_id,
            "expected_version": checkpoint["version"],
        },
    )["structuredContent"]
    checkpoint = app_action(
        mcp_client,
        token,
        {
            "type": "checkpoint",
            "workspace_id": workspace_id,
            "expected_version": discarded["version"],
            "content": "# Final edit",
        },
    )["structuredContent"]
    saved = app_action(
        mcp_client,
        token,
        {
            "type": "save",
            "workspace_id": workspace_id,
            "expected_version": checkpoint["version"],
            "operation_key": "final-save",
        },
    )["structuredContent"]
    assert saved["draft"] is None
    actual = mcp_client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert actual["content"] == "# Final edit"
    assert actual["current_revision_id"] == saved["document"]["current_revision_id"]


def test_workspace_cannot_be_read_by_another_actor_or_revoked_key(mcp_client: TestClient) -> None:
    document = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read", "update"), path_prefix="mcp/")
    other = issue_agent_token(
        mcp_client, actor_id="agent:other", capabilities=("read", "update"), path_prefix="mcp/"
    )
    workspace = rpc(mcp_client, token, "present", {"document_id": document["document_id"]})[
        "structuredContent"
    ]
    assert (
        app_action(
            mcp_client, other, {"type": "refresh", "workspace_id": workspace["workspace_id"]}
        )["isError"]
        is True
    )
    readonly = issue_agent_token(mcp_client, capabilities=("read", "search"), path_prefix="mcp/")
    result = app_action(
        mcp_client,
        readonly,
        {
            "type": "checkpoint",
            "workspace_id": workspace["workspace_id"],
            "expected_version": workspace["version"],
            "content": "denied",
        },
    )
    assert result["isError"] is True
    issued = mcp_client.get("/api/v1/agent-tokens").json()
    token_id = next(item["token_id"] for item in issued if item["actor_id"] == "agent:other")
    assert mcp_client.delete(f"/api/v1/agent-tokens/{token_id}").status_code == 200
    assert (
        mcp_client.post("/mcp/", headers={"Authorization": f"Bearer {other}"}, json={}).status_code
        == 401
    )


def test_cached_and_nested_execution_results_recheck_source_authority(
    mcp_client: TestClient,
) -> None:
    document = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read",), path_prefix="mcp/")
    source_key, derived_key = str(uuid4()), str(uuid4())
    source = execute(
        mcp_client,
        token,
        f"await documents_read(document_id='{document['document_id']}')",
        source_key,
    )
    assert source["structuredContent"]["output"]["content"] == document["content"]
    derived_code = f"await executions_get(execution_key='{source_key}')"
    assert execute(mcp_client, token, derived_code, derived_key)["isError"] is False
    restricted = issue_agent_token(mcp_client, capabilities=("read",), path_prefix="elsewhere/")
    denied = execute(mcp_client, restricted, derived_code, derived_key)
    assert denied["isError"] is True
    assert "Findable sangamneedle" not in str(denied)


@pytest.mark.parametrize("code", ["while True:\n    pass", "'x' * 100_000_000"])
def test_monty_budgets_stop_code_and_the_next_fresh_call_still_works(
    mcp_client: TestClient, code: str
) -> None:
    token = issue_agent_token(mcp_client)
    assert execute(mcp_client, token, code)["isError"] is True
    assert execute(mcp_client, token, "6 * 7")["structuredContent"]["output"] == 42


def test_concurrent_duplicate_execution_and_app_save_replay_preserve_newer_drafts(
    mcp_client: TestClient,
) -> None:
    document = seed(mcp_client)
    token = issue_agent_token(mcp_client, capabilities=("read", "update"), path_prefix="mcp/")
    key = str(uuid4())
    code = (
        f"await documents_update(document_id='{document['document_id']}', "
        f"expected_revision_id='{document['current_revision_id']}', "
        "content='# Once', operation_key='concurrent-once')"
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(lambda _: execute(mcp_client, token, code, key), range(2)))
    assert all(reply.get("isError") is False for reply in replies)
    saved_revision = mcp_client.get(f"/api/v1/documents/{document['document_id']}").json()[
        "current_revision_id"
    ]
    assert (
        execute(mcp_client, token, code, key)["structuredContent"]["output"]["current_revision_id"]
        == saved_revision
    )
    workspace = rpc(mcp_client, token, "present", {"document_id": document["document_id"]})[
        "structuredContent"
    ]
    checkpoint = app_action(
        mcp_client,
        token,
        {
            "type": "checkpoint",
            "workspace_id": workspace["workspace_id"],
            "expected_version": workspace["version"],
            "content": "# Save me",
        },
    )["structuredContent"]
    save = {
        "type": "save",
        "workspace_id": workspace["workspace_id"],
        "expected_version": checkpoint["version"],
        "operation_key": "save-retry",
    }
    first = app_action(mcp_client, token, save)["structuredContent"]
    newer = app_action(
        mcp_client,
        token,
        {
            "type": "checkpoint",
            "workspace_id": workspace["workspace_id"],
            "expected_version": first["version"],
            "content": "# Newer unsaved work",
        },
    )["structuredContent"]
    replay = app_action(mcp_client, token, save)["structuredContent"]
    assert replay["draft"] == newer["draft"]
    assert replay["version"] == newer["version"]
    assert (
        mcp_client.get(f"/api/v1/documents/{document['document_id']}").json()["content"]
        == "# Save me"
    )


def test_draft_and_execution_receipts_survive_application_restart(settings: Settings) -> None:
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as first:
        document = seed(first)
        token = issue_agent_token(first, capabilities=("read", "update"), path_prefix="mcp/")
        workspace = rpc(first, token, "present", {"document_id": document["document_id"]})[
            "structuredContent"
        ]
        app_action(
            first,
            token,
            {
                "type": "checkpoint",
                "workspace_id": workspace["workspace_id"],
                "expected_version": workspace["version"],
                "content": "# Survives restart",
            },
        )
        key = str(uuid4())
        assert execute(first, token, "42", key)["structuredContent"]["output"] == 42
    with TestClient(create_app(settings)) as restarted:
        assert (
            app_action(
                restarted, token, {"type": "refresh", "workspace_id": workspace["workspace_id"]}
            )["structuredContent"]["draft"]
            == "# Survives restart"
        )
        assert execute(restarted, token, "42", key)["structuredContent"]["output"] == 42
        assert execute(restarted, token, "43", key)["isError"] is True


def test_multi_document_layout_keeps_drafts_active_tab_and_current_authority(
    settings: Settings,
) -> None:
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as client:
        first = seed(client)
        second = seed(client, "mcp/second.md")
        private = seed(client, "private/secret.md")
        token = issue_agent_token(
            client, capabilities=("read", "search", "update"), path_prefix="mcp/"
        )
        opened = rpc(
            client,
            token,
            "present",
            {
                "document_id": first["document_id"],
                "additional_document_ids": [second["document_id"]],
            },
        )["structuredContent"]
        tabs = opened["layout"]["tabs"]
        assert [tab["document_id"] for tab in tabs] == [first["document_id"], second["document_id"]]
        checkpoint = app_action(
            client,
            token,
            {
                "type": "checkpoint",
                "workspace_id": opened["workspace_id"],
                "expected_version": opened["version"],
                "content": "# First draft",
            },
        )["structuredContent"]
        denied = app_action(
            client,
            token,
            {
                "type": "open",
                "workspace_id": opened["workspace_id"],
                "expected_layout_version": checkpoint["layout"]["version"],
                "document_id": private["document_id"],
            },
        )
        assert denied["isError"] is True
        assert "secret.md" not in str(denied)
        second_view = app_action(
            client,
            token,
            {
                "type": "activate",
                "workspace_id": opened["workspace_id"],
                "target_workspace_id": tabs[1]["workspace_id"],
                "expected_layout_version": checkpoint["layout"]["version"],
            },
        )["structuredContent"]
        assert second_view["document"]["document_id"] == second["document_id"]
        assert second_view["layout"]["tabs"][0]["has_draft"] is True
        compared = app_action(
            client,
            token,
            {
                "type": "compare",
                "workspace_id": second_view["workspace_id"],
                "target_workspace_id": tabs[0]["workspace_id"],
                "expected_layout_version": second_view["layout"]["version"],
            },
        )
        assert not compared.get("isError"), compared
        position = {"kind": "text", "anchor": 2, "head": 6, "scroll_top": 40}
        located = app_action(
            client,
            token,
            {
                "type": "view",
                "workspace_id": second_view["workspace_id"],
                "expected_view_version": second_view["view_version"],
                "location": position,
            },
        )
        assert not located.get("isError"), located
        assert (
            client.get(f"/api/v1/documents/{first['document_id']}").json()["content"]
            == first["content"]
        )
    with TestClient(create_app(settings)) as restarted:
        recovered = rpc(
            restarted,
            token,
            "present",
            {"document_id": second["document_id"], "workspace_id": second_view["workspace_id"]},
        )["structuredContent"]
        assert recovered["layout"]["active_workspace_id"] == second_view["workspace_id"]
        assert len(recovered["layout"]["tabs"]) == 2
        assert recovered["comparison"]["draft"] == "# First draft"
        assert recovered["location"] == position
        first_view = app_action(
            restarted,
            token,
            {
                "type": "activate",
                "workspace_id": recovered["workspace_id"],
                "target_workspace_id": tabs[0]["workspace_id"],
                "expected_layout_version": recovered["layout"]["version"],
            },
        )["structuredContent"]
        assert first_view["draft"] == "# First draft"
        narrowed = issue_agent_token(restarted, capabilities=("read",), path_prefix="mcp/second.md")
        filtered = app_action(
            restarted, narrowed, {"type": "refresh", "workspace_id": second_view["workspace_id"]}
        )["structuredContent"]
        assert [tab["document_id"] for tab in filtered["layout"]["tabs"]] == [second["document_id"]]
        assert filtered["layout"]["unavailable_count"] == 1
        assert filtered["comparison"] is None
        assert filtered["layout"]["comparison_workspace_id"] is None
        assert "guide.md" not in str(filtered)
        restored = rpc(
            restarted, narrowed, "present", {"layout_id": recovered["layout"]["layout_id"]}
        )["structuredContent"]
        assert restored["document"]["document_id"] == second["document_id"]
        assert len(restored["layout"]["tabs"]) == 1


def test_layout_changes_preserve_dirty_tabs_and_reuse_quota(settings: Settings) -> None:
    settings.mcp_enabled = True
    settings.mcp_max_workspaces_per_actor = 2
    with TestClient(create_app(settings)) as client:
        first = seed(client)
        second = seed(client, "mcp/second.md")
        third = seed(client, "mcp/third.md")
        token = issue_agent_token(client, capabilities=("read", "update"), path_prefix="mcp/")
        opened = rpc(
            client,
            token,
            "present",
            {
                "document_id": first["document_id"],
                "additional_document_ids": [second["document_id"]],
            },
        )["structuredContent"]
        checkpoint = app_action(
            client,
            token,
            {
                "type": "checkpoint",
                "workspace_id": opened["workspace_id"],
                "expected_version": opened["version"],
                "content": "# Must survive",
            },
        )["structuredContent"]
        version = checkpoint["layout"]["version"]
        close_dirty = app_action(
            client,
            token,
            {
                "type": "close",
                "workspace_id": opened["workspace_id"],
                "target_workspace_id": opened["workspace_id"],
                "expected_layout_version": version,
            },
        )
        assert close_dirty["isError"] is True
        over_quota = app_action(
            client,
            token,
            {
                "type": "open",
                "workspace_id": opened["workspace_id"],
                "document_id": third["document_id"],
                "expected_layout_version": version,
            },
        )
        assert over_quota["isError"] is True
        closed = app_action(
            client,
            token,
            {
                "type": "close",
                "workspace_id": opened["workspace_id"],
                "target_workspace_id": opened["layout"]["tabs"][1]["workspace_id"],
                "expected_layout_version": version,
            },
        )["structuredContent"]
        stale = app_action(
            client,
            token,
            {
                "type": "open",
                "workspace_id": opened["workspace_id"],
                "document_id": third["document_id"],
                "expected_layout_version": version,
            },
        )
        assert stale["isError"] is True
        added = app_action(
            client,
            token,
            {
                "type": "open",
                "workspace_id": opened["workspace_id"],
                "document_id": third["document_id"],
                "expected_layout_version": closed["layout"]["version"],
            },
        )["structuredContent"]
        assert len(added["layout"]["tabs"]) == 2
        assert added["layout"]["tabs"][0]["has_draft"] is True
        with client.app.state.services.documents.database.transaction() as connection:
            connection.execute("UPDATE mcp_layouts SET updated_at = '2000-01-01T00:00:00+00:00'")
        preserved = rpc(
            client,
            token,
            "present",
            {"document_id": third["document_id"], "workspace_id": added["workspace_id"]},
        )
        assert preserved["isError"] is False
        assert (
            app_action(client, token, {"type": "refresh", "workspace_id": opened["workspace_id"]})[
                "structuredContent"
            ]["draft"]
            == "# Must survive"
        )
        discarded = app_action(
            client,
            token,
            {
                "type": "discard",
                "workspace_id": opened["workspace_id"],
                "expected_version": checkpoint["version"],
            },
        )
        assert discarded["isError"] is False
        with client.app.state.services.documents.database.transaction() as connection:
            connection.execute("UPDATE mcp_layouts SET updated_at = '2000-01-01T00:00:00+00:00'")
        expired = rpc(client, token, "present", {"layout_id": added["layout"]["layout_id"]})
        assert expired["isError"] is True
        assert "expired" in expired["structuredContent"]["error"]["message"]
        assert (
            client.get(f"/api/v1/documents/{first['document_id']}").json()["content"]
            == first["content"]
        )


def test_legacy_workspace_migrates_without_changing_its_draft(settings: Settings) -> None:
    with TestClient(create_app(settings)) as client:
        document = seed(client)
        token = issue_agent_token(client, capabilities=("read", "update"), path_prefix="mcp/")
    database = Database(settings.database_path)
    with database.transaction() as connection:
        connection.execute("DROP TABLE mcp_layout_documents")
        connection.execute("DROP TABLE mcp_layouts")
        connection.execute("DELETE FROM schema_migrations WHERE version = '039'")
        connection.execute(
            "INSERT INTO mcp_workspaces VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                "legacy-workspace",
                "agent:cli",
                document["document_id"],
                document["current_revision_id"],
                9,
                "# Legacy unfinished draft",
                "2000-01-01T00:00:00+00:00",
            ),
        )
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as client:
        restored = rpc(
            client,
            token,
            "present",
            {"document_id": document["document_id"], "workspace_id": "legacy-workspace"},
        )["structuredContent"]
        assert restored["workspace_id"] == "legacy-workspace"
        assert restored["version"] == 9
        assert restored["draft"] == "# Legacy unfinished draft"
        assert len(restored["layout"]["tabs"]) == 1
        with database.connection() as connection:
            assert connection.execute("PRAGMA foreign_key_check").fetchall() == []
