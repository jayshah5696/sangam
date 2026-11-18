"""Real protocol and Monty checks for registered, immutable skill exports.

Failure cases: owner impersonation, unregistered discovery, private helpers,
mixed source revisions, changed bytes under an old digest, path traversal,
expiry extended by reads, restart loss, and cached execution authority bypass.
"""

import base64
import hashlib
import json
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from conftest import issue_agent_token
from fastapi.testclient import TestClient
from test_mcp_slice import execute
from test_phase_five_pdf_research import import_pdf, text_pdf

from sangam.api import create_app
from sangam.config import Settings
from sangam.db import Database


@pytest.fixture
def mcp_client(settings: Settings) -> Iterator[TestClient]:
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as client:
        yield client


def document(client: TestClient, path: str, content: str) -> dict:
    response = client.post(
        "/api/v1/documents",
        headers={"Idempotency-Key": str(uuid4())},
        json={"title": path, "path": path, "content_type": "text/markdown", "content": content},
    )
    assert response.status_code == 201, response.text
    return response.json()


def register(client: TestClient, source: dict) -> None:
    response = client.post("/api/v1/chat/skills", json={"document_id": source["document_id"]})
    assert response.status_code == 201, response.text


def protocol(client: TestClient, token: str, method: str, params: dict) -> dict:
    response = client.post(
        "/mcp",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
            **({"Mcp-Name": params["uri"]} if method == "resources/read" else {}),
        },
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": {
                **params,
                "_meta": {
                    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                    "io.modelcontextprotocol/clientCapabilities": {
                        "extensions": {"io.modelcontextprotocol/skills": {}}
                    },
                },
            },
        },
    )
    payload = response.json()
    assert response.status_code == 200 or response.status_code == 400 and "error" in payload, (
        response.text
    )
    return payload


def get(client: TestClient, token: str, identifier: str) -> dict:
    reply = execute(client, token, f"await skills_get(skill_id='{identifier}')")
    assert not reply.get("isError"), reply
    return reply["structuredContent"]["output"]


def bytes_at(client: TestClient, token: str, uri: str) -> bytes:
    reply = protocol(client, token, "resources/read", {"uri": uri})
    assert "error" not in reply, reply
    assert reply["result"]["resultType"] == "complete"
    assert reply["result"]["cacheScope"] == "private"
    content = reply["result"]["contents"][0]
    return content["text"].encode() if "text" in content else base64.b64decode(content["blob"])


def test_registered_skills_share_native_and_code_mode_snapshots(mcp_client: TestClient) -> None:
    helper = document(mcp_client, "skills/checklist.md", "# Check héllo\n")
    pdf_source = text_pdf("Skill PDF reference")
    pdf = import_pdf(
        mcp_client, content=pdf_source, key="skill-pdf", path="skills/paper.pdf"
    ).json()
    content = (
        "---\nname: review-guide\ndescription: Review the architecture\nlicense: Apache-2.0\n"
        "metadata:\n  owner: central\nsangam:\n  files:\n"
        f"    references/checklist.md: {helper['document_id']}\n"
        f"    references/paper.pdf: {pdf['document_id']}\n---\n"
        "Read [checklist](references/checklist.md) and [paper](references/paper.pdf).\n"
    )
    source = document(mcp_client, "skills/review.md", content)
    register(mcp_client, source)
    document(mcp_client, "skills/unregistered.md", content.replace("review-guide", "unregistered"))
    private = document(
        mcp_client, "private/hidden.md", content.replace("review-guide", "private-guide")
    )
    register(mcp_client, private)
    token = issue_agent_token(
        mcp_client, actor_id="agent:external-skills", capabilities=("read",), path_prefix="skills/"
    )
    catalog = execute(mcp_client, token, "await skills_list()")
    assert not catalog.get("isError"), catalog
    items = catalog["structuredContent"]["output"]["items"]
    assert {item["frontmatter"]["name"] for item in items} == {"sangam", "review-guide"}
    entry = get(mcp_client, token, source["document_id"])
    assert entry["frontmatter"]["license"] == "Apache-2.0"
    assert entry["frontmatter"]["metadata"] == {"owner": "central"}
    assert "/review-guide/SKILL.md" in entry["uri"]
    assert (
        protocol(mcp_client, token, "skills/get", {"uri": entry["uri"]})["result"]["skill"] == entry
    )
    listed = protocol(mcp_client, token, "skills/list", {})["result"]
    assert listed["resultType"] == "complete" and entry in listed["skills"]
    for resource in entry["resources"]:
        data = bytes_at(mcp_client, token, resource["uri"])
        assert len(data) == resource["size"]
        assert "sha256:" + hashlib.sha256(data).hexdigest() == resource["digest"]
    assert bytes_at(mcp_client, token, entry["uri"]) == content.encode()
    old_helper = next(
        item["uri"] for item in entry["resources"] if item["uri"].endswith("checklist.md")
    )
    mcp_client.patch(
        f"/api/v1/documents/{helper['document_id']}",
        headers={"Idempotency-Key": "skill-helper-update"},
        json={
            "expected_revision_id": helper["current_revision_id"],
            "content": "# New checklist\n",
        },
    ).raise_for_status()
    next_entry = get(mcp_client, token, source["document_id"])
    assert next_entry["uri"] != entry["uri"]
    assert bytes_at(mcp_client, token, old_helper) == helper["content"].encode()
    fallback = execute(mcp_client, token, f"await skills_read(uri='{old_helper}', length=5)")[
        "structuredContent"
    ]["output"]
    assert fallback["text"] == helper["content"][:5] and fallback["next_offset"] == 5
    cached_key = str(uuid4())
    cached_code = f"await skills_read(uri='{old_helper}')"
    assert not execute(mcp_client, token, cached_code, cached_key).get("isError")
    narrower = issue_agent_token(
        mcp_client,
        actor_id="agent:external-skills",
        capabilities=("read",),
        path_prefix="skills/review.md",
    )
    assert execute(mcp_client, narrower, cached_code, cached_key).get("isError")
    denied = issue_agent_token(
        mcp_client,
        actor_id="agent:only-root",
        capabilities=("read",),
        path_prefix="skills/review.md",
    )
    assert "error" in protocol(mcp_client, denied, "skills/get", {"uri": entry["uri"]})
    assert "error" in protocol(mcp_client, denied, "resources/read", {"uri": old_helper})
    assert "private-guide" not in json.dumps(protocol(mcp_client, token, "skills/list", {}))
    capabilities = protocol(mcp_client, token, "server/discover", {})["result"]["capabilities"]
    assert "io.modelcontextprotocol/skills" in capabilities["extensions"]
    assert (
        capabilities["extensions"]["io.modelcontextprotocol/skills"].get("directoryRead", False)
        is False
    )


@pytest.mark.parametrize(
    "path",
    ["../secret.md", "/absolute.md", "a/../b.md", "SKILL.md", "a//b.md", "a%2fb.md", "a\\b.md"],
)
def test_skill_mapping_rejects_unsafe_paths(mcp_client: TestClient, path: str) -> None:
    helper = document(mcp_client, "skills/helper.md", "Helper")
    content = (
        "---\nname: unsafe\ndescription: Unsafe mapping\nsangam:\n  files:\n"
        f"    '{path}': {helper['document_id']}\n---\nInstructions\n"
    )
    source = document(mcp_client, "skills/unsafe.md", content)
    register(mcp_client, source)
    token = issue_agent_token(mcp_client, capabilities=("read",))
    assert execute(mcp_client, token, f"await skills_get(skill_id='{source['document_id']}')").get(
        "isError"
    )


def test_skill_snapshots_survive_restart_and_expire_from_supersession(settings: Settings) -> None:
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as client:
        source = document(
            client,
            "skills/stable.md",
            "---\nname: stable\ndescription: Stable guidance\n---\nOriginal\n",
        )
        register(client, source)
        token = issue_agent_token(client, capabilities=("read",))
        entry = get(client, token, source["document_id"])
        client.patch(
            f"/api/v1/documents/{source['document_id']}",
            headers={"Idempotency-Key": "skill-root-update"},
            json={
                "expected_revision_id": source["current_revision_id"],
                "content": source["content"].replace("Original", "Changed"),
            },
        ).raise_for_status()
        current = get(client, token, source["document_id"])
    with TestClient(create_app(settings)) as client:
        assert bytes_at(client, token, entry["uri"]) == source["content"].encode()
        assert get(client, token, source["document_id"])["uri"] == current["uri"]
        old_time = (datetime.now(UTC) - timedelta(days=8)).isoformat()
        database = Database(settings.database_path)
        with database.transaction() as connection:
            connection.execute(
                "UPDATE mcp_skill_snapshots SET superseded_at = ? WHERE snapshot_id = ?",
                (old_time, entry["uri"].split("/")[3]),
            )
        assert "error" in protocol(client, token, "resources/read", {"uri": entry["uri"]})
        assert b"Changed" in bytes_at(client, token, current["uri"])


def test_reregistered_unchanged_skill_becomes_current_again(
    mcp_client: TestClient, settings: Settings
) -> None:
    source = document(
        mcp_client,
        "skills/returned.md",
        "---\nname: returned\ndescription: Registered again\n---\nInstructions\n",
    )
    registration = mcp_client.post(
        "/api/v1/chat/skills", json={"document_id": source["document_id"]}
    ).json()
    token = issue_agent_token(mcp_client, capabilities=("read",))
    entry = get(mcp_client, token, source["document_id"])
    mcp_client.delete(f"/api/v1/chat/skills/{registration['skill_id']}").raise_for_status()
    assert "error" in protocol(mcp_client, token, "skills/get", {"uri": entry["uri"]})
    # Discovery observes the removal and starts retention of the old manifest.
    assert not execute(mcp_client, token, "await skills_list()").get("isError")
    register(mcp_client, source)
    restored = get(mcp_client, token, source["document_id"])
    assert restored["uri"] == entry["uri"]
    database = Database(settings.database_path)
    with database.connection() as connection:
        row = connection.execute(
            "SELECT superseded_at FROM mcp_skill_snapshots WHERE snapshot_id = ?",
            (entry["uri"].split("/")[3],),
        ).fetchone()
    assert row["superseded_at"] is None
    assert bytes_at(mcp_client, token, restored["uri"]) == source["content"].encode()
