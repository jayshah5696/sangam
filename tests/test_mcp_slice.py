"""Exercise the real mounted protocol, Monty worker, and canonical write service.

Failure cases established before implementation: anonymous single-user access;
scope/ownership/revocation bypass; interpreter state leaking between calls;
lost/duplicate writes; failure after commit; stale saves erasing recoverable
drafts; and an old checkpoint acknowledgement clearing newer edits.
"""

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from conftest import issue_agent_token
from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings


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


def test_private_mcp_has_no_single_user_fallback(mcp_client: TestClient) -> None:
    response = mcp_client.post(
        "/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
    )
    assert response.status_code == 401


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
    # A deliberate discard adopts the new saved base; a new checkpoint can then save.
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
