from __future__ import annotations

import json

from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient

from sangam.chat import ChatRequestContext
from sangam.security import Principal


def chatkit_request(client: TestClient, body: dict, **request_headers: str):
    return client.post("/api/v1/chatkit", json=body, headers=request_headers)


def create_thread(client: TestClient, *, document_id: str | None = None) -> str:
    request_headers = {"X-Sangam-Document-ID": document_id} if document_id else {}
    response = chatkit_request(
        client,
        {
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": "Review this document"}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                }
            },
        },
        **request_headers,
    )
    assert response.status_code == 200
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    assert [event["type"] for event in events] == [
        "thread.created",
        "thread.item.done",
        "stream_options",
        "error",
    ]
    assert events[2]["stream_options"] == {"allow_cancel": True}
    assert events[3]["code"] == "custom"
    return events[0]["thread"]["id"]


def test_chatkit_runtime_config_and_supported_abstractions(client: TestClient) -> None:
    response = client.get("/api/v1/chat/config")

    assert response.status_code == 200
    assert response.json() == {
        "configured": False,
        "provider": "openrouter_openai_agents",
        "transport": "chatkit",
        "domain_key": "local-dev",
        "default_model": "openai/gpt-5.4-mini",
        "available_models": [
            "openai/gpt-5.4-mini",
            "openai/gpt-5.4-nano",
            "openai/gpt-5.6-terra",
        ],
        "reasoning_effort": "low",
    }
    assert "api_key" not in response.text
    assert {tool.name for tool in client.app.state.services.chat.tools} == {
        "get_editor_selection",
        "search_workspace",
        "read_document",
        "read_pdf_page",
        "propose_update",
        "create_document",
        "publish_document",
    }
    create_thread(client)


def test_chatkit_threads_are_durable_and_owner_scoped(client: TestClient) -> None:
    thread_id = create_thread(client)
    loaded = chatkit_request(
        client,
        {"type": "threads.get_by_id", "params": {"thread_id": thread_id}},
    )
    assert loaded.status_code == 200
    assert loaded.json()["id"] == thread_id
    assert loaded.json()["items"]["data"][0]["content"][0]["text"] == "Review this document"

    token = issue_agent_token(client, capabilities=("read", "search"))
    hidden = chatkit_request(
        client,
        {"type": "threads.get_by_id", "params": {"thread_id": thread_id}},
        Authorization=f"Bearer {token}",
    )
    assert hidden.status_code == 404


def test_reviewed_chat_proposal_uses_the_normal_document_update_path(
    client: TestClient,
) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Research", "content": "Original evidence", "path": "research.md"},
        headers=headers("phase-seven-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="proposal-test"
    )
    proposal = client.app.state.services.chat.create_proposal(
        ChatRequestContext(principal=principal, document_id=document["document_id"]),
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="Original evidence\n\nGrounded conclusion.",
        summary="Add grounded conclusion from workspace chat",
    )

    current = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert current["content"] == "Original evidence"
    listed = client.get(
        f"/api/v1/chat/proposals?document_id={document['document_id']}&thread_id={thread_id}"
    )
    assert listed.status_code == 200
    assert listed.json()[0]["proposal_id"] == proposal.proposal_id

    applied = client.post(
        f"/api/v1/chat/proposals/{proposal.proposal_id}/apply",
        json={"expected_revision_id": proposal.expected_revision_id},
        headers=headers("apply-chat-proposal"),
    )
    assert applied.status_code == 200
    assert applied.json()["status"] == "applied"
    updated = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert updated["content"].endswith("Grounded conclusion.")
    history = client.get(f"/api/v1/documents/{document['document_id']}/history").json()
    assert history[0]["actor_id"] == "human:jay"
    assert history[0]["summary"] == "Add grounded conclusion from workspace chat"


def test_chat_proposal_detects_a_concurrent_edit(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Concurrent", "content": "one"},
        headers=headers("phase-seven-concurrent"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="proposal-conflict"
    )
    proposal = client.app.state.services.chat.create_proposal(
        ChatRequestContext(principal=principal, document_id=document["document_id"]),
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="chat version",
        summary="Chat proposal",
    )
    changed = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={"expected_revision_id": document["current_revision_id"], "content": "human version"},
        headers=headers("phase-seven-human-edit"),
    )
    assert changed.status_code == 200

    conflict = client.post(
        f"/api/v1/chat/proposals/{proposal.proposal_id}/apply",
        json={"expected_revision_id": proposal.expected_revision_id},
        headers=headers("phase-seven-stale-apply"),
    )
    assert conflict.status_code == 409
    listed = client.get(
        f"/api/v1/chat/proposals?document_id={document['document_id']}&thread_id={thread_id}"
    ).json()
    assert listed[0]["status"] == "stale"
    current = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert current["content"] == "human version"
