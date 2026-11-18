"""Inspect real revisions and owned proposals through Monty.

Failures include wrong revisions, wrong owners, lost source grants,
unbounded content/evidence, and confusing proposed wording with applied wording.
"""

import json
from collections.abc import Iterator
from uuid import uuid4

import pytest
from conftest import issue_agent_token
from fastapi.testclient import TestClient
from test_mcp_assistant import output
from test_mcp_slice import execute, seed
from test_phase_seven_chat import install_fake_model

from sangam.api import create_app
from sangam.config import Settings


@pytest.fixture
def mcp_client(settings: Settings) -> Iterator[TestClient]:
    settings.mcp_enabled = True
    with TestClient(create_app(settings)) as client:
        yield client


def proposal(client: TestClient, source: dict, *, citations: list | None = None):
    install_fake_model(client, ["Review this suggestion"])
    token = issue_agent_token(client, capabilities=("read", "update", "inference"))
    request = output(
        client,
        token,
        f"await assistant_submit(request_key='{uuid4()}', message='Review source', "
        f"document_id='{source['document_id']}', wait_seconds=2)",
    )
    services = client.app.state.services
    principal = services.identity.authenticate(token, operation_id="inspection-proof")
    proposed = services.chat.proposals.create(
        principal,
        thread_id=request["conversation_id"],
        document_id=source["document_id"],
        expected_revision_id=source["current_revision_id"],
        content="# Suggested\n\nHéllo review.\n",
        summary="Suggested introduction",
        rationale="Make the introduction clear.",
        citations=citations,
    )
    return token, principal, proposed


def resource(client: TestClient, token: str, uri: str) -> dict:
    reply = client.post(
        "/mcp",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json, text/event-stream",
        },
        json={"jsonrpc": "2.0", "id": 1, "method": "resources/read", "params": {"uri": uri}},
    ).json()
    assert "error" not in reply, reply
    return json.loads(reply["result"]["contents"][0]["text"])


def test_exact_revision_reads_paginated_history_and_bounded_diff(mcp_client: TestClient) -> None:
    original = seed(mcp_client)
    changed = mcp_client.patch(
        f"/api/v1/documents/{original['document_id']}",
        headers={"Idempotency-Key": str(uuid4())},
        json={
            "expected_revision_id": original["current_revision_id"],
            "content": "# Updated\n\nHéllo revision.\n",
        },
    ).json()
    token = issue_agent_token(mcp_client, capabilities=("read",))
    identifier = original["document_id"]
    first = output(
        mcp_client, token, f"await documents_history(document_id='{identifier}', limit=1)"
    )
    assert first["items"][0]["revision_id"] == changed["current_revision_id"]
    assert "content" not in first["items"][0] and first["next_cursor"]
    second = output(
        mcp_client,
        token,
        f"await documents_history(document_id='{identifier}', "
        f"limit=1, cursor='{first['next_cursor']}')",
    )
    assert second["items"][0]["revision_id"] == original["current_revision_id"]
    assert second["next_cursor"] is None
    old = output(
        mcp_client,
        token,
        f"await documents_read(document_id='{identifier}', "
        f"revision_id='{original['current_revision_id']}')",
    )
    assert old["content"] == original["content"]
    assert old["revision_id"] == original["current_revision_id"]
    assert old["current_revision_id"] == changed["current_revision_id"]
    query = (
        f"document_id='{identifier}', from_revision_id='{original['current_revision_id']}', "
        f"to_revision_id='{changed['current_revision_id']}'"
    )
    chunks = []
    offset = 0
    while True:
        part = output(
            mcp_client, token, f"await documents_diff({query}, offset={offset}, length=12)"
        )
        chunks.append(part["unified_diff"])
        if part["next_offset"] is None:
            break
        offset = part["next_offset"]
    diff = "".join(chunks)
    assert "-# Original" in diff and "+# Updated" in diff and "+Héllo revision." in diff
    other = seed(mcp_client, "other/source.md")
    bad = execute(
        mcp_client,
        token,
        f"await documents_read(document_id='{identifier}', "
        f"revision_id='{other['current_revision_id']}')",
    )
    assert bad.get("isError")
    wrong = query.replace(original["current_revision_id"], other["current_revision_id"])
    assert execute(mcp_client, token, f"await documents_diff({wrong})").get("isError")
    html = mcp_client.post(
        "/api/v1/documents",
        headers={"Idempotency-Key": str(uuid4())},
        json={
            "title": "HTML source",
            "content_type": "text/html",
            "content": "<h1>Source only</h1>",
        },
    ).json()
    text = output(mcp_client, token, f"await documents_read(document_id='{html['document_id']}')")
    assert text["content_type"] == "text/html" and text["content"] == html["content"]


def test_proposal_inspection_is_owned_bounded_and_independent_of_inference(
    mcp_client: TestClient,
) -> None:
    source = seed(mcp_client, "public/source.md")
    _, _, suggested = proposal(mcp_client, source)
    reader = issue_agent_token(mcp_client, capabilities=("read",), path_prefix="public/")
    listed = output(
        mcp_client, reader, f"await proposals_list(document_id='{source['document_id']}', limit=1)"
    )
    assert listed["items"][0]["proposal_id"] == suggested.proposal_id
    assert "content" not in listed["items"][0]
    part = output(
        mcp_client, reader, f"await proposals_get(proposal_id='{suggested.proposal_id}', length=9)"
    )
    assert part["content"] == suggested.content[:9] and part["next_offset"] == 9
    assert part["content_kind"] == "proposed" and not part["evidence_included"]
    assert part["expected_revision_id"] == source["current_revision_id"]
    assert resource(mcp_client, reader, part["resource_uri"])["content"] == suggested.content
    other = issue_agent_token(mcp_client, actor_id="agent:other-inspector", capabilities=("read",))
    assert output(mcp_client, other, "await proposals_list()")["items"] == []
    assert execute(
        mcp_client, other, f"await proposals_get(proposal_id='{suggested.proposal_id}')"
    ).get("isError")


def test_proposal_root_and_cached_history_use_current_read_grants(mcp_client: TestClient) -> None:
    source = seed(mcp_client, "private/source.md")
    token, _, suggested = proposal(mcp_client, source)
    key = str(uuid4())
    code = f"await proposals_get(proposal_id='{suggested.proposal_id}')"
    assert not execute(mcp_client, token, code, key).get("isError")
    narrow = issue_agent_token(mcp_client, capabilities=("read",), path_prefix="public/")
    assert execute(mcp_client, narrow, code).get("isError")
    assert execute(mcp_client, narrow, code, key).get("isError")
    assert output(mcp_client, narrow, "await proposals_list()")["items"] == []
    # The REST and MCP entry points must use the same read rule.
    reply = mcp_client.get("/api/v1/chat/proposals", headers={"Authorization": f"Bearer {narrow}"})
    assert reply.status_code == 200 and reply.json() == []
    history_key = str(uuid4())
    history_code = f"await documents_history(document_id='{source['document_id']}')"
    assert not execute(mcp_client, token, history_code, history_key).get("isError")
    assert execute(mcp_client, narrow, history_code, history_key).get("isError")


def test_proposal_evidence_redacts_fresh_reads_and_denies_cached_private_evidence(
    mcp_client: TestClient,
) -> None:
    source = seed(mcp_client, "public/source.md")
    helper = seed(mcp_client, "private/citation.md")
    token, _, suggested = proposal(
        mcp_client,
        source,
        citations=[
            {
                "document_id": helper["document_id"],
                "revision_id": helper["current_revision_id"],
                "snippet": "Original",
            }
        ],
    )
    key = str(uuid4())
    code = f"await proposals_get(proposal_id='{suggested.proposal_id}', include_evidence=True)"
    full = execute(mcp_client, token, code, key)
    assert full["structuredContent"]["output"]["citations"][0]["snippet"] == "Original"
    narrow = issue_agent_token(mcp_client, capabilities=("read",), path_prefix="public/")
    redacted = output(mcp_client, narrow, code)
    assert redacted["citations"][0]["snippet"] == "" and not redacted["citations"][0]["available"]
    assert redacted["evidence_status"] == "unavailable"
    assert execute(mcp_client, narrow, code, key).get("isError")


def test_applied_wording_and_revision_are_distinct_from_the_original_proposal(
    mcp_client: TestClient,
) -> None:
    source = seed(mcp_client)
    token, _, suggested = proposal(mcp_client, source)
    applied = mcp_client.post(
        f"/api/v1/chat/proposals/{suggested.proposal_id}/apply",
        headers={"Idempotency-Key": str(uuid4())},
        json={
            "expected_revision_id": source["current_revision_id"],
            "content": "# Human reviewed wording\n",
        },
    ).json()
    original = output(
        mcp_client, token, f"await proposals_get(proposal_id='{suggested.proposal_id}')"
    )
    reviewed = output(
        mcp_client,
        token,
        f"await proposals_get(proposal_id='{suggested.proposal_id}', content_kind='applied')",
    )
    assert original["content"] == suggested.content
    assert reviewed["content"] == "# Human reviewed wording\n"
    assert reviewed["applied_revision_id"] == applied["applied_revision_id"]
    assert reviewed["content_kind"] == "applied" and reviewed["status"] == "applied"


def test_proposal_pages_filter_literal_read_prefixes_before_pagination(
    mcp_client: TestClient,
) -> None:
    hidden = seed(mcp_client, "teamX/private.md")
    visible = seed(mcp_client, "team_/visible.md")
    another = seed(mcp_client, "team_/another.md")
    proposal(mcp_client, hidden)
    _, _, suggested = proposal(mcp_client, visible)
    _, _, later = proposal(mcp_client, another)
    token = issue_agent_token(mcp_client, capabilities=("read",), path_prefix="team_")
    page = output(mcp_client, token, "await proposals_list(limit=1)")
    assert [item["proposal_id"] for item in page["items"]] == [later.proposal_id]
    assert page["next_offset"] == 1
    page = output(mcp_client, token, "await proposals_list(limit=1, offset=1)")
    assert [item["proposal_id"] for item in page["items"]] == [suggested.proposal_id]
    assert page["next_offset"] is None
