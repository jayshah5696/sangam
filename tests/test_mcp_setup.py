from conftest import issue_agent_token
from fastapi.testclient import TestClient
from test_mcp_slice import rpc

from sangam.api import create_app


def test_mcp_status_reports_environment_opt_out(settings):
    settings.mcp_enabled = False
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/settings/mcp").json() == {"enabled": False}
        assert client.post("/mcp").status_code == 404
        assert "[MCP endpoint]" not in client.get("/llms.txt").text


def test_default_mcp_and_activity_filter(client):
    assert client.get("/api/v1/settings/mcp").json() == {"enabled": True}
    assert client.post("/mcp").status_code == 401
    token = issue_agent_token(client, capabilities=("read", "search", "create"))
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/v1/settings/mcp", headers=headers).status_code == 403
    assert client.get("/api/v1/search?q=setup-proof", headers=headers).status_code == 200
    result = rpc(
        client,
        token,
        "execute",
        {
            "code": "await documents_search(query='setup-proof')",
            "execution_key": "setup-proof",
        },
    )
    assert not result.get("isError"), result
    events = client.get("/api/v1/activity?via=mcp").json()
    assert len(events) == 1
    assert events[0]["operation_id"].startswith("mcp:")
    assert events[0]["details"]["via"] == "mcp"
    created = rpc(
        client,
        token,
        "execute",
        {
            "code": "await documents_create(title='MCP setup proof', content='# Proof', "
            "path='agents/proof.md', operation_key='setup-write')",
            "execution_key": "setup-write",
        },
    )
    assert not created.get("isError"), created
    events = client.get("/api/v1/activity?via=mcp").json()
    assert {event["action"] for event in events} == {"create", "search"}
    assert all(event["details"]["via"] == "mcp" for event in events)
