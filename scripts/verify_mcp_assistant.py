"""Prove server-owned assistant requests through real MCP, ChatKit, inference, and SQLite."""

import asyncio
import json
import os
import sqlite3
from pathlib import Path
from time import monotonic
from uuid import uuid4

import httpx
import httpx2
from mcp.client.session import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp_demo import seed_demo


async def verify() -> None:
    base = os.environ["SANGAM_API_URL"]
    document, companion, _, _ = await asyncio.to_thread(seed_demo, base)
    async with httpx.AsyncClient(base_url=base, timeout=30) as rest:
        config = (await rest.get("/api/v1/chat/config")).raise_for_status().json()
        assert config["inference_enabled"], config["message"]
        assert config["autonomy_mode"] == "review"
        scopes = [{"capability": "inference"}] + [
            {"capability": capability, "path_prefix": "mcp-demo/"}
            for capability in ("read", "search", "create", "update")
        ]
        key = (
            (
                await rest.post(
                    "/api/v1/agent-tokens",
                    json={
                        "actor_id": "agent:mcp-assistant-proof",
                        "display_name": "MCP assistant proof",
                        "label": "Disposable inference proof",
                        "scopes": scopes,
                    },
                )
            )
            .raise_for_status()
            .json()
        )
        async with (
            httpx2.AsyncClient(headers={"Authorization": f"Bearer {key['token']}"}) as http,
            streamable_http_client(base + "/mcp", http_client=http) as streams,
            ClientSession(streams[0], streams[1]) as session,
        ):
            await session.initialize()

            async def execute(code: str) -> dict:
                reply = await session.call_tool(
                    "execute", {"execution_key": str(uuid4()), "code": code}
                )
                assert not reply.is_error and reply.structured_content is not None, reply
                return reply.structured_content

            async def app_action(action: dict) -> dict:
                reply = await session.call_tool("mcp_app", {"action": action})
                assert not reply.is_error and reply.structured_content is not None, reply
                return reply.structured_content

            async def finished(request_key: str) -> dict:
                deadline = monotonic() + 150
                while monotonic() < deadline:
                    value = (
                        await execute(
                            f"await assistant_wait(request_key='{request_key}', wait_seconds=2)"
                        )
                    )["output"]
                    if value["status"] != "running":
                        return value
                raise AssertionError("Assistant request did not reach a terminal outcome")

            request_key = str(uuid4())
            arguments = (
                f"request_key='{request_key}', document_id='{document.document_id}', "
                "message='Reply exactly SANGAM_ASSISTANT_PROOF. "
                "Do not call tools or change documents.'"
            )
            submitted = await execute(f"await assistant_submit({arguments}); 'submitted'")
            assert submitted["output"] == "submitted"
            if "pending_jobs" in submitted:
                assert submitted["pending_jobs"][0]["request_key"] == request_key
            # The submitted execute has ended. A fresh program observes the owned model run.
            first = await finished(request_key)
            assert first["status"] == "completed", first
            assert "SANGAM_ASSISTANT_PROOF" in first["answer"]
            assert first["run_id"]
            replay = (await execute(f"await assistant_submit({arguments})"))["output"]
            assert replay == first
            resource = await session.read_resource(first["resource_uri"])
            assert json.loads(resource.contents[0].text) == first
            follow_key = str(uuid4())
            await execute(
                f"await assistant_submit(request_key='{follow_key}', "
                f"conversation_id='{first['conversation_id']}', "
                "message='What exact marker did you return before? "
                "Reply with only that marker. Do not call tools.')"
            )
            follow = await finished(follow_key)
            assert (
                follow["status"] == "completed" and "SANGAM_ASSISTANT_PROOF" in follow["answer"]
            ), follow
            review_key = str(uuid4())
            opened = await session.call_tool(
                "present",
                {
                    "document_id": document.document_id,
                    "additional_document_ids": [companion.document_id],
                },
            )
            assert not opened.is_error and opened.structured_content is not None
            workspace = opened.structured_content
            create_action = {
                "type": "document_create",
                "workspace_id": workspace["workspace_id"],
                "title": "Live App assistant proof",
                "path": "mcp-demo/app-assistant-proof.md",
                "content": "# App assistant proof\n\nSaved passage for assistant review.",
                "operation_key": str(uuid4()),
            }
            create_arguments = ", ".join(
                f"{name}={value!r}"
                for name, value in create_action.items()
                if name not in {"type", "workspace_id"}
            )
            created = (await execute(f"await documents_create({create_arguments})"))["output"]
            assert await app_action(create_action) == created
            workspace = await app_action(
                {
                    "type": "open",
                    "workspace_id": workspace["workspace_id"],
                    "document_id": created["document_id"],
                    "expected_layout_version": workspace["layout"]["version"],
                }
            )
            review_action = {
                "type": "assistant_submit",
                "workspace_id": workspace["workspace_id"],
                "request_key": review_key,
                "document_id": created["document_id"],
                "revision_id": created["created_revision_id"],
                "selection_text": "Saved passage for assistant review.",
                "context_documents": [
                    {
                        "document_id": companion.document_id,
                        "revision_id": companion.current_revision_id,
                    }
                ],
                "message": "Read this active document and prepare a proposal to append "
                "the sentence: MCP review proof. Use propose_update. "
                "Do not apply the proposal or publish anything.",
            }
            await app_action(review_action)
            reviewed = await finished(review_key)
            assert await app_action(review_action) == reviewed
            recorded_workspace = await app_action(
                {"type": "refresh", "workspace_id": workspace["workspace_id"]}
            )
            assert recorded_workspace["assistant_request_key"] == review_key
            assert reviewed["status"] == "needs_review" and reviewed["proposals"], reviewed
            assert reviewed["proposals"][0]["applied_revision_id"] is None
            saved = (
                (await rest.get(f"/api/v1/documents/{created['document_id']}"))
                .raise_for_status()
                .json()
            )
            assert saved["current_revision_id"] == created["created_revision_id"]
            proposal_id = reviewed["proposals"][0]["proposal_id"]
            proposed = (
                await execute(
                    f"await proposals_get(proposal_id='{proposal_id}', include_evidence=True)"
                )
            )["output"]
            assert proposed["content_kind"] == "proposed"
            assert proposed["expected_revision_id"] == created["created_revision_id"]
            assert "MCP review proof." in proposed["content"]
            listed = (
                await execute(f"await proposals_list(document_id='{created['document_id']}')")
            )["output"]
            assert any(item["proposal_id"] == proposal_id for item in listed["items"])
            uri = proposed["resource_uri"]
            snapshot = json.loads((await session.read_resource(uri)).contents[0].text)
            assert snapshot["status"] == "pending"
            applied_response = await app_action(
                {
                    "type": "proposal_apply",
                    "workspace_id": workspace["workspace_id"],
                    "proposal_id": proposal_id,
                    "expected_revision_id": created["created_revision_id"],
                    "content": proposed["content"],
                    "operation_key": str(uuid4()),
                }
            )
            applied = (
                await execute(
                    f"await proposals_get(proposal_id='{proposal_id}', content_kind='applied')"
                )
            )["output"]
            assert applied["content"] == proposed["content"]
            assert applied["applied_revision_id"] == applied_response["applied_revision_id"]
            saved = (
                (await rest.get(f"/api/v1/documents/{created['document_id']}"))
                .raise_for_status()
                .json()
            )
            assert saved["content"] == proposed["content"]
            assert saved["current_revision_id"] == applied["applied_revision_id"]
            snapshot = json.loads((await session.read_resource(uri)).contents[0].text)
            assert (
                snapshot["status"] == "applied"
                and snapshot["applied_revision_id"] == applied["applied_revision_id"]
            )
        narrow = (
            (
                await rest.post(
                    "/api/v1/agent-tokens",
                    json={
                        "actor_id": "agent:mcp-assistant-proof",
                        "display_name": "MCP assistant proof",
                        "label": "Narrowed proof",
                        "scopes": [
                            {"capability": "inference"},
                            {"capability": "read", "path_prefix": "unrelated/"},
                        ],
                    },
                )
            )
            .raise_for_status()
            .json()
        )
        denied = (
            (
                await rest.post(
                    "/mcp",
                    headers={
                        "Authorization": f"Bearer {narrow['token']}",
                        "Accept": "application/json, text/event-stream",
                    },
                    json={
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "tools/call",
                        "params": {
                            "name": "execute",
                            "arguments": {
                                "execution_key": str(uuid4()),
                                "code": f"await assistant_get(request_key='{request_key}')",
                            },
                        },
                    },
                )
            )
            .raise_for_status()
            .json()
        )
        assert denied["result"]["isError"]
    with sqlite3.connect(os.environ["SANGAM_DATABASE_PATH"]) as database:
        assert database.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert (
            database.execute(
                "SELECT count(*) FROM assistant_requests WHERE request_key=?", (request_key,)
            ).fetchone()[0]
            == 1
        )
        assert (
            database.execute(
                "SELECT count(*) FROM chat_runs WHERE thread_id=?", (first["conversation_id"],)
            ).fetchone()[0]
            == 2
        )
        origin = database.execute(
            "SELECT workspace_id,context_json FROM assistant_requests WHERE request_key=?",
            (review_key,),
        ).fetchone()
        assert origin[0] == workspace["workspace_id"] and companion.document_id in origin[1]
        selection = database.execute(
            "SELECT selection_text FROM chat_turn_contexts WHERE thread_id=?",
            (reviewed["conversation_id"],),
        ).fetchone()
        assert selection[0] == "Saved passage for assistant review."
    report = {
        "result": "passed",
        "model": config["default_model"],
        "first": first,
        "follow_up": follow,
        "review": reviewed,
        "app_creation": created,
        "proposal_inspection": {"proposed": proposed, "applied": applied},
        "verified": [
            "real official MCP client, Monty and configured inference",
            "server-owned work after the submitting execute ends",
            "stable key replay with no duplicate inference",
            "known owned conversation continuation",
            "resource status parity and narrowed source access denial",
            "pending review distinct from a saved revision",
            "App creation replay, saved selection/tab context and accepted request restoration",
            "proposal inspection and native resource refresh after an authorized App apply",
            "SQLite integrity and expected request/run counts",
        ],
    }
    target = Path(os.environ["SANGAM_ARTIFACTS_DIR"]) / "mcp-assistant.json"
    target.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"Evidence: {target}")


if __name__ == "__main__":
    asyncio.run(verify())
