"""Prove the slice over real HTTP with the official Python MCP client and SQLite."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import httpx
import httpx2
from mcp.client.client import Client
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.client.subscriptions import ResourceUpdated
from mcp.shared.exceptions import MCPError
from mcp.types import TextResourceContents
from mcp_demo import seed_demo


async def verify_events(base: str, token: str, workspace: dict) -> dict:
    """Check wire acknowledgement, draft invalidation, refetch and cancellation."""
    async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"}) as http:

        @asynccontextmanager
        async def transport():
            async with streamable_http_client(base + "/mcp", http_client=http) as streams:
                yield streams[0], streams[1]

        async with Client(transport(), cache=None) as client:
            uri = f"sangam://workspace/{workspace['workspace_id']}"
            try:
                async with client.listen(resource_subscriptions=["sangam://workspace/not-owned"]):
                    raise AssertionError("Unauthorized subscription was acknowledged")
            except MCPError:
                pass
            async with client.listen(resource_subscriptions=[uri]) as subscription:
                assert subscription.honored.resource_subscriptions == [uri]
                reply = await client.call_tool(
                    "mcp_app",
                    {
                        "action": {
                            "type": "checkpoint",
                            "workspace_id": workspace["workspace_id"],
                            "expected_version": workspace["version"],
                            "content": "# Event draft",
                        }
                    },
                )
                assert not reply.is_error
                event = await asyncio.wait_for(anext(subscription), 5)
                assert isinstance(event, ResourceUpdated) and event.uri == uri
                resource = await client.read_resource(uri)
                snapshot = json.loads(resource.contents[0].text)
                assert snapshot["draft"] == "# Event draft"
                assert snapshot["document"]["content"] == workspace["document"]["content"]
            async with client.listen(resource_subscriptions=[uri]):
                restored = json.loads((await client.read_resource(uri)).contents[0].text)
                reply = await client.call_tool(
                    "mcp_app",
                    {
                        "action": {
                            "type": "discard",
                            "workspace_id": workspace["workspace_id"],
                            "expected_version": restored["version"],
                        }
                    },
                )
                assert not reply.is_error and reply.structured_content is not None
                return reply.structured_content


async def verify_event_revocation(base: str, rest: httpx.AsyncClient, document_id: str) -> None:
    issued = await rest.post(
        "/api/v1/agent-tokens",
        json={
            "actor_id": "agent:resource-events",
            "display_name": "Event verification",
            "label": "Disposable event key",
            "scopes": [{"capability": "read", "path_prefix": "mcp-demo/"}],
        },
    )
    issued.raise_for_status()
    key = issued.json()
    async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {key['token']}"}) as http:

        @asynccontextmanager
        async def transport():
            async with streamable_http_client(base + "/mcp", http_client=http) as streams:
                yield streams[0], streams[1]

        async with (
            Client(transport(), cache=None) as client,
            client.listen(
                resource_subscriptions=[f"sangam://document/{document_id}"]
            ) as subscription,
        ):
            (await rest.delete(f"/api/v1/agent-tokens/{key['token_id']}")).raise_for_status()
            try:
                await asyncio.wait_for(anext(subscription), 5)
                raise AssertionError("Revoked stream delivered an event")
            except StopAsyncIteration:
                pass


async def verify_skill_events(base: str, token: str, rest: httpx.AsyncClient, skill: dict) -> None:
    """A canonical source edit invalidates the logical skill resource, not old bytes."""
    info = skill["_meta"]["sangam"]
    uri = info["resource_uri"]
    async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"}) as http:

        @asynccontextmanager
        async def transport():
            async with streamable_http_client(base + "/mcp", http_client=http) as streams:
                yield streams[0], streams[1]

        async with (
            Client(transport(), cache=None) as client,
            client.listen(resource_subscriptions=[uri]) as subscription,
        ):
            source = (await rest.get(f"/api/v1/documents/{info['skill_id']}")).json()
            changed = await rest.patch(
                f"/api/v1/documents/{info['skill_id']}",
                headers={"Idempotency-Key": str(uuid4())},
                json={
                    "expected_revision_id": source["current_revision_id"],
                    "content": source["content"] + "\nReport the observed revision.\n",
                },
            )
            changed.raise_for_status()
            event = await asyncio.wait_for(anext(subscription), 5)
            assert isinstance(event, ResourceUpdated) and event.uri == uri
            current = json.loads((await client.read_resource(uri)).contents[0].text)
            assert current["uri"] != skill["uri"]
            old = (await client.read_resource(skill["uri"])).contents[0].text
            assert old == source["content"]


async def verify_proposals(base: str, token: str, rest: httpx.AsyncClient) -> dict:
    """Prove canonical proposals, document commits and native resource invalidations."""
    created = await rest.post(
        "/api/v1/documents",
        headers={"Idempotency-Key": str(uuid4())},
        json={
            "title": "MCP proposal proof",
            "path": "mcp-demo/proposal-proof.md",
            "content_type": "text/markdown",
            "content": "# Original proposal source",
        },
    )
    created.raise_for_status()
    document = created.json()
    async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"}) as http:

        @asynccontextmanager
        async def transport():
            async with streamable_http_client(base + "/mcp", http_client=http) as streams:
                yield streams[0], streams[1]

        async with Client(transport(), cache=None) as client:

            async def program(code: str) -> dict:
                reply = await client.call_tool(
                    "execute", {"code": code, "execution_key": str(uuid4())}
                )
                assert not reply.is_error and reply.structured_content is not None, reply
                return reply.structured_content["output"]

            opened = await client.call_tool("present", {"document_id": document["document_id"]})
            assert not opened.is_error and opened.structured_content is not None
            workspace = opened.structured_content
            uri = f"sangam://workspace/{workspace['workspace_id']}"
            creation_key = str(uuid4())
            create_code = (
                f"await proposals_create(document_id='{document['document_id']}', "
                f"expected_revision_id='{document['current_revision_id']}', "
                f"summary='Proposal proof', content='# Suggested', operation_key='{creation_key}')"
            )
            async with client.listen(resource_subscriptions=[uri]) as subscription:
                proposal = await program(create_code)
                assert proposal["status"] == "pending" and proposal["conversation_id"] is None
                event = await asyncio.wait_for(anext(subscription), 5)
                assert isinstance(event, ResourceUpdated) and event.uri == uri
                observed = json.loads((await client.read_resource(uri)).contents[0].text)
                assert observed["proposal_version"] != workspace["proposal_version"]
                assert (
                    observed["document"]["current_revision_id"] == document["current_revision_id"]
                )
            proposal_uri = proposal["resource_uri"]
            async with client.listen(resource_subscriptions=[uri, proposal_uri]) as subscription:
                apply_code = (
                    f"await proposals_apply(proposal_id='{proposal['proposal_id']}', "
                    f"expected_revision_id='{document['current_revision_id']}', "
                    f"content='# Reviewed by MCP', operation_key='{uuid4()}')"
                )
                applied = await program(apply_code)
                observed_uris = set()
                for _ in range(2):
                    event = await asyncio.wait_for(anext(subscription), 5)
                    assert isinstance(event, ResourceUpdated)
                    observed_uris.add(event.uri)
                assert observed_uris == {uri, proposal_uri}
                recorded = json.loads((await client.read_resource(proposal_uri)).contents[0].text)
                assert recorded["applied_revision_id"] == applied["applied_revision_id"]
                assert (await program(apply_code))["applied_revision_id"] == applied[
                    "applied_revision_id"
                ]
            saved = (await rest.get(f"/api/v1/documents/{document['document_id']}")).json()
            assert saved["content"] == "# Reviewed by MCP"
            assert saved["current_revision_id"] == applied["applied_revision_id"]
            assert (
                len((await rest.get(f"/api/v1/documents/{document['document_id']}/history")).json())
                == 2
            )
            assert (await program(create_code))["proposal_id"] == proposal["proposal_id"]
            second = await program(
                f"await proposals_create(document_id='{document['document_id']}', "
                f"expected_revision_id='{saved['current_revision_id']}', "
                "content='# Dismissed wording', summary='Dismiss proof', "
                f"operation_key='{uuid4()}')"
            )
            dismiss_code = (
                f"await proposals_dismiss(proposal_id='{second['proposal_id']}', "
                f"reason='Keep reviewed wording', operation_key='{uuid4()}')"
            )
            assert (await program(dismiss_code))["status"] == "dismissed"
            assert (await program(dismiss_code))["status"] == "dismissed"
            assert (await rest.get(f"/api/v1/documents/{document['document_id']}")).json()[
                "current_revision_id"
            ] == applied["applied_revision_id"]
    with sqlite3.connect(os.environ["SANGAM_DATABASE_PATH"]) as database:
        row = database.execute(
            "SELECT owner_actor_id, thread_id, execution_key FROM chat_proposals "
            "WHERE proposal_id=?",
            (proposal["proposal_id"],),
        ).fetchone()
        assert row[0] == "agent:mcp-demo" and row[1] is None and row[2]
        assert database.execute("PRAGMA foreign_key_check").fetchall() == []
    return {
        "proposal_id": proposal["proposal_id"],
        "applied_revision_id": applied["applied_revision_id"],
        "dismissed_proposal_id": second["proposal_id"],
        "native_events": "workspace and proposal",
    }


async def verify() -> None:
    base = os.environ["SANGAM_API_URL"]
    document, companion, pdf, issued = await asyncio.to_thread(seed_demo, base)
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
            guidance = await session.call_tool(
                "execute",
                {
                    "code": "await skills_list(query='walkthrough')",
                    "execution_key": str(uuid4()),
                },
            )
            assert guidance.structured_content is not None and not guidance.is_error
            skill = guidance.structured_content["output"]["items"][0]
            for file in skill["resources"]:
                content = (await session.read_resource(file["uri"])).contents[0]
                data = (
                    content.text.encode()
                    if isinstance(content, TextResourceContents)
                    else base64.b64decode(content.blob)
                )
                assert len(data) == file["size"]
                assert "sha256:" + hashlib.sha256(data).hexdigest() == file["digest"]
            native = await rest.post(
                "/mcp",
                headers={
                    "Authorization": f"Bearer {issued.token}",
                    "Accept": "application/json, text/event-stream",
                    "MCP-Protocol-Version": "2026-07-28",
                    "Mcp-Method": "skills/get",
                },
                json={
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "skills/get",
                    "params": {
                        "uri": skill["uri"],
                        "_meta": {
                            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                            "io.modelcontextprotocol/clientCapabilities": {
                                "extensions": {"io.modelcontextprotocol/skills": {}}
                            },
                        },
                    },
                },
            )
            native.raise_for_status()
            assert native.json()["result"]["skill"] == skill
            await verify_skill_events(base, issued.token, rest, skill)
            for _ in range(100):
                status = await session.call_tool(
                    "execute",
                    {
                        "code": f"await pdf_status(document_id='{pdf.document_id}')",
                        "execution_key": str(uuid4()),
                    },
                )
                assert status.structured_content is not None
                if status.structured_content["output"]["status"] == "ready":
                    break
                await asyncio.sleep(0.05)
            else:
                raise AssertionError("PDF extraction did not finish")
            page = await session.call_tool(
                "execute",
                {
                    "code": f"await pdf_pages_read(document_id='{pdf.document_id}', page_number=1)",
                    "execution_key": str(uuid4()),
                },
            )
            assert page.structured_content is not None and page.structured_content["output"]["text"]
            note_key = str(uuid4())
            note_code = (
                f"await pdf_annotations_create(document_id='{pdf.document_id}', "
                "page_number=1, note='HTTP PDF note', operation_key='mcp-http-pdf-note')\n1 / 0"
            )
            noted = await session.call_tool(
                "execute", {"code": note_code, "execution_key": note_key}
            )
            assert noted.is_error and noted.structured_content is not None
            assert noted.structured_content["writes"][0]["resource_type"] == "annotation"
            assert noted.structured_content["writes"][0]["outcome"] == "committed"
            replayed = await session.call_tool(
                "execute", {"code": note_code, "execution_key": note_key}
            )
            assert replayed.structured_content == noted.structured_content
            assert len((await rest.get(f"/api/v1/pdfs/{pdf.document_id}/annotations")).json()) == 1
            assert (
                hashlib.sha256(
                    (await rest.get(f"/api/v1/pdfs/{pdf.document_id}/content")).content
                ).hexdigest()
                == pdf.content_hash
            )
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
            workspace = await verify_events(base, issued.token, workspace)
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
            inspected = await session.call_tool(
                "execute",
                {
                    "execution_key": str(uuid4()),
                    "code": (
                        f"old = await documents_read(document_id='{document.document_id}', "
                        f"revision_id='{document.current_revision_id}')\n"
                        f"history = await documents_history(document_id='{document.document_id}', "
                        "limit=1)\n"
                        f"diff = await documents_diff(document_id='{document.document_id}', "
                        f"from_revision_id='{document.current_revision_id}', "
                        f"to_revision_id='{revision['current_revision_id']}')\n"
                        "{'old': old, 'history': history, 'diff': diff}"
                    ),
                },
            )
            assert not inspected.is_error and inspected.structured_content is not None
            inspected_data = inspected.structured_content["output"]
            assert inspected_data["old"]["revision_id"] == document.current_revision_id
            assert inspected_data["old"]["current_revision_id"] == revision["current_revision_id"]
            assert inspected_data["old"]["content"] == document.content
            assert (
                inspected_data["history"]["items"][0]["revision_id"]
                == revision["current_revision_id"]
            )
            assert inspected_data["history"]["next_cursor"]
            assert "+# Committed before failure" in inspected_data["diff"]["unified_diff"]
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
            assert len(resource.contents[0].text.encode()) < 6_000_000
        proposal_proof = await verify_proposals(base, issued.token, rest)
        assert (await rest.delete(f"/api/v1/agent-tokens/{issued.token_id}")).status_code == 200
        assert (
            await rest.post("/mcp/", headers={"Authorization": f"Bearer {issued.token}"}, json={})
        ).status_code == 401
        await verify_event_revocation(base, rest, document.document_id)
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
        "proposals": proposal_proof,
        "verified": [
            "explicit authentication",
            "bare and slash endpoints with built frontend",
            "catalog discovery",
            "real Monty search",
            "exact revision reads, history pagination and canonical revision diff",
            "App resource",
            "registered guidance through Code Mode and native Skills, exact text/PDF digests",
            "skill source invalidation with pinned older bytes preserved",
            "PDF page reads, annotation commit recovery, duplicate prevention and immutable bytes",
            "draft checkpoint",
            "App search and multiple-document restoration",
            "native subscription acknowledgement, draft invalidation and reconnect refetch",
            "write-before-failure evidence",
            "duplicate delivery without a second commit",
            "recovery after a dependency is trashed",
            "conflict preserves draft",
            "revocation",
            "owned external proposal creation, exact apply recovery and idempotent dismissal",
            "native workspace and proposal invalidation for canonical proposal changes",
            "SQLite integrity and one committed operation key",
        ],
    }
    target = Path(os.environ["SANGAM_ARTIFACTS_DIR"]) / "mcp-slice.json"
    target.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"Evidence: {target}")


if __name__ == "__main__":
    asyncio.run(verify())
