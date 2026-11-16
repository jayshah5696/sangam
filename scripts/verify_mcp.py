"""Prove the slice over real HTTP with the official Python MCP client and SQLite."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
from pathlib import Path
from uuid import uuid4

import httpx
import httpx2
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp_demo import seed_demo


async def verify() -> None:
    base = os.environ["SANGAM_API_URL"]
    document, companion, issued = await asyncio.to_thread(seed_demo, base)
    async with httpx.AsyncClient(base_url=base, timeout=30) as rest:
        for path in ("/mcp", "/mcp/"):
            assert (await rest.post(path, json={})).status_code == 401
            assert (await rest.get(path)).status_code == 401
        async with (
            httpx2.AsyncClient(headers={"Authorization": f"Bearer {issued.token}"}) as http,
            streamable_http_client(base + "/mcp", http_client=http) as streams,
            ClientSession(streams[0], streams[1]) as session,
        ):
            await session.initialize()
            tools = await session.list_tools()
            assert {tool.name for tool in tools.tools} == {
                "search",
                "execute",
                "present",
                "mcp_app",
            }
            discovery = await session.call_tool("search", {"query": "documents.read"})
            assert not discovery.is_error
            result = await session.call_tool(
                "execute",
                {
                    "code": "await documents_search(query='walkthrough')",
                    "execution_key": str(uuid4()),
                },
            )
            assert not result.is_error
            assert document.document_id in str(result.structured_content)
            opened = await session.call_tool(
                "present",
                {
                    "document_id": document.document_id,
                    "additional_document_ids": [companion.document_id],
                },
            )
            assert opened.structured_content is not None
            workspace = opened.structured_content
            assert len(workspace["layout"]["tabs"]) == 2
            app_search = await session.call_tool(
                "mcp_app",
                {"action": {"type": "search", "query": "companion", "limit": 10, "offset": 0}},
            )
            assert app_search.structured_content is not None
            assert companion.document_id in str(app_search.structured_content)
            checkpointed = await session.call_tool(
                "mcp_app",
                {
                    "action": {
                        "type": "checkpoint",
                        "workspace_id": workspace["workspace_id"],
                        "expected_version": workspace["version"],
                        "content": "# Recoverable local draft",
                    }
                },
            )
            assert not checkpointed.is_error
            activated = await session.call_tool(
                "mcp_app",
                {
                    "action": {
                        "type": "activate",
                        "workspace_id": workspace["workspace_id"],
                        "target_workspace_id": workspace["layout"]["tabs"][1]["workspace_id"],
                        "expected_layout_version": workspace["layout"]["version"],
                    }
                },
            )
            assert not activated.is_error
            restored = await session.call_tool(
                "present", {"layout_id": workspace["layout"]["layout_id"]}
            )
            assert restored.structured_content is not None
            assert restored.structured_content["document"]["document_id"] == companion.document_id
            key = str(uuid4())
            code = (
                f"await documents_read(document_id='{companion.document_id}')\n"
                f"await documents_update(document_id='{document.document_id}', "
                f"expected_revision_id='{document.current_revision_id}', "
                "content='# Committed before failure', operation_key='mcp-live-write')\n1 / 0"
            )
            failed = await session.call_tool("execute", {"code": code, "execution_key": key})
            assert failed.is_error and failed.structured_content is not None
            revision = (await rest.get(f"/api/v1/documents/{document.document_id}")).json()
            assert revision["content"] == "# Committed before failure"
            before = (await rest.get(f"/api/v1/documents/{document.document_id}/history")).json()
            trashed = await rest.request(
                "DELETE",
                f"/api/v1/documents/{companion.document_id}",
                headers={"Idempotency-Key": str(uuid4())},
                json={"expected_revision_id": companion.current_revision_id},
            )
            trashed.raise_for_status()
            repeated = await session.call_tool("execute", {"code": code, "execution_key": key})
            assert repeated.structured_content == failed.structured_content
            assert (
                await rest.get(f"/api/v1/documents/{document.document_id}/history")
            ).json() == before
            refreshed = await session.call_tool(
                "mcp_app",
                {
                    "action": {
                        "type": "refresh",
                        "workspace_id": workspace["workspace_id"],
                    }
                },
            )
            assert refreshed.structured_content is not None
            assert refreshed.structured_content["draft"] == "# Recoverable local draft"
            assert refreshed.structured_content["conflict"] is True
            assert refreshed.structured_content["layout"]["unavailable_count"] == 1
            resource = await session.read_resource("ui://sangam/document-workspace.html")
            assert resource.contents and "<html" in str(resource.contents)
        assert (await rest.delete(f"/api/v1/agent-tokens/{issued.token_id}")).status_code == 200
        assert (
            await rest.post("/mcp/", headers={"Authorization": f"Bearer {issued.token}"}, json={})
        ).status_code == 401
    with sqlite3.connect(os.environ["SANGAM_DATABASE_PATH"]) as database:
        assert database.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        count = database.execute(
            "SELECT count(*) FROM idempotency_keys WHERE idempotency_key = 'mcp-live-write'"
        ).fetchone()[0]
        assert count == 1
    report = {
        "result": "passed",
        "protocol_client": "official Python SDK over Streamable HTTP",
        "document_id": document.document_id,
        "committed_revision_id": revision["current_revision_id"],
        "verified": [
            "explicit authentication",
            "bare and slash endpoints with built frontend",
            "catalog discovery",
            "real Monty search",
            "App resource",
            "draft checkpoint",
            "App search and multiple-document restoration",
            "write-before-failure evidence",
            "duplicate delivery without a second commit",
            "recovery after a dependency is trashed",
            "conflict preserves draft",
            "revocation",
            "SQLite integrity and one committed operation key",
        ],
    }
    target = Path(os.environ["SANGAM_ARTIFACTS_DIR"]) / "mcp-slice.json"
    target.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"Evidence: {target}")


if __name__ == "__main__":
    asyncio.run(verify())
