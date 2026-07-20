from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Sequence
from types import SimpleNamespace
from typing import Any, cast

import pytest
from agents.models.interface import Model, ModelProvider
from agents.tool_context import ToolContext as AgentsToolContext
from chatkit.agents import AgentContext
from chatkit.types import CustomTask
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseContentPartAddedEvent,
    ResponseContentPartDoneEvent,
    ResponseCreatedEvent,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseTextDeltaEvent,
    ResponseTextDoneEvent,
)

from sangam.chat_context import ChatRequestContext
from sangam.errors import ValidationError
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
    proposal = client.app.state.services.chat.proposals.create(
        principal,
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
    proposal = client.app.state.services.chat.proposals.create(
        principal,
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


def test_stale_chat_proposal_can_be_dismissed_with_a_reason(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Dismiss stale", "content": "one"},
        headers=headers("phase-seven-stale-dismiss-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="stale-dismiss"
    )
    proposal = client.app.state.services.chat.proposals.create(
        principal,
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="chat version",
        summary="Chat proposal",
    )
    client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={"expected_revision_id": document["current_revision_id"], "content": "human version"},
        headers=headers("phase-seven-stale-dismiss-edit"),
    )
    conflict = client.post(
        f"/api/v1/chat/proposals/{proposal.proposal_id}/apply",
        json={"expected_revision_id": proposal.expected_revision_id},
        headers=headers("phase-seven-stale-dismiss-apply"),
    )
    assert conflict.status_code == 409

    # A stale proposal offers a Dismiss button in the review UI, so dismissing it
    # must succeed and clear it from the reviewable list rather than deadlocking on
    # the spent apply reservation.
    dismissed = client.post(
        f"/api/v1/chat/proposals/{proposal.proposal_id}/dismiss",
        json={"reason": "Wrong section for this edit"},
    )
    assert dismissed.status_code == 200
    assert dismissed.json()["status"] == "dismissed"
    assert dismissed.json()["summary"].endswith("Wrong section for this edit")

    listed = client.get(
        f"/api/v1/chat/proposals?document_id={document['document_id']}&thread_id={thread_id}"
    ).json()
    assert [proposal_row["status"] for proposal_row in listed] == ["dismissed"]


def test_chat_proposal_apply_recovers_after_status_write_failure(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Recoverable", "content": "before"},
        headers=headers("phase-seven-recovery-source"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="proposal-recovery"
    )
    proposals = client.app.state.services.chat.proposals
    proposal = proposals.create(
        principal,
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="after",
        summary="Recover interrupted apply",
    )
    original_mark_applied = proposals.repository.mark_applied
    calls = 0

    def fail_once(apply_principal: Principal, proposal_id: str, applied_revision_id: str):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("simulated interruption after document commit")
        return original_mark_applied(apply_principal, proposal_id, applied_revision_id)

    monkeypatch.setattr(proposals.repository, "mark_applied", fail_once)
    with pytest.raises(RuntimeError, match="simulated interruption"):
        proposals.apply(
            principal,
            proposal_id=proposal.proposal_id,
            expected_revision_id=proposal.expected_revision_id,
            idempotency_key="first-apply-key",
        )

    pending = proposals.repository.get_owned(principal, proposal.proposal_id)
    assert pending.status == "pending"
    retry_principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="proposal-recovery-retry"
    )
    recovered = proposals.apply(
        retry_principal,
        proposal_id=proposal.proposal_id,
        expected_revision_id=proposal.expected_revision_id,
        idempotency_key="different-retry-key",
    )

    assert recovered.status == "applied"
    assert recovered.applied_revision_id is not None
    history = client.get(f"/api/v1/documents/{document['document_id']}/history").json()
    assert [revision["content"] for revision in history] == ["after", "before"]


def test_chat_tool_wrapper_tracks_task_identity_and_serializes_failures(client: TestClient) -> None:
    toolset = client.app.state.services.chat.toolset

    class FakeAgentContext:
        def __init__(self) -> None:
            existing = CustomTask(title="Earlier task", content="done", status_indicator="complete")
            workflow = SimpleNamespace(tasks=[existing])
            self.workflow_item = SimpleNamespace(workflow=workflow)
            self.updated_index: int | None = None

        async def add_workflow_task(self, task: CustomTask) -> None:
            self.workflow_item.workflow.tasks.append(task)

        async def update_workflow_task(self, task: CustomTask, task_index: int) -> None:
            self.updated_index = task_index
            self.workflow_item.workflow.tasks[task_index] = task

    agent_context = FakeAgentContext()
    ctx = cast(Any, SimpleNamespace(context=agent_context))

    result = asyncio.run(
        toolset._run_tool(
            ctx,
            "Read document",
            "missing",
            lambda: (_ for _ in ()).throw(ValidationError("cannot read document")),
        )
    )

    assert agent_context.updated_index == 1
    assert json.loads(result)["error"]["code"] == "validation_error"
    assert agent_context.workflow_item.workflow.tasks[1].content == "Failed: cannot read document"


def test_agents_sdk_function_tool_invokes_authorized_workspace_read(
    client: TestClient,
) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Tool invocation", "content": "orchid-compass-93"},
        headers=headers("phase-seven-tool-invocation"),
    ).json()
    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="tool-invocation"
    )
    request_context = ChatRequestContext(principal=principal, document_id=document["document_id"])
    chat = client.app.state.services.chat
    thread = asyncio.run(chat.store_adapter.load_thread(thread_id, request_context))
    agent_context = AgentContext(
        thread=thread,
        store=chat.store_adapter,
        request_context=request_context,
    )
    read_tool = next(tool for tool in chat.tools if tool.name == "read_document")
    arguments = json.dumps({"document_id": document["document_id"]})
    run_context = AgentsToolContext(
        context=agent_context,
        tool_name=read_tool.name,
        tool_call_id="call-read-document",
        tool_arguments=arguments,
    )

    result = asyncio.run(
        read_tool.on_invoke_tool(
            run_context,
            arguments,
        )
    )

    payload = json.loads(result)
    assert payload["content"] == "orchid-compass-93"
    assert payload["source"]["revision_id"] == document["current_revision_id"]
    assert agent_context.workflow_item is not None
    assert agent_context.workflow_item.workflow.tasks[0].status_indicator == "complete"


def _make_response(text: str, *, status: str = "completed", with_output: bool = True) -> Response:
    message = ResponseOutputMessage(
        id="msg_1",
        type="message",
        role="assistant",
        status="completed",
        content=[ResponseOutputText(type="output_text", text=text, annotations=[])],
    )
    return Response(
        id="resp_1",
        object="response",
        created_at=0,
        model="fake",
        output=[message] if with_output else [],
        parallel_tool_calls=False,
        tool_choice="auto",
        tools=[],
        instructions=None,
        status=cast(Any, status),
    )


class _RecordingResponsesModel(Model):
    """Minimal streaming Responses model that records the input it is handed.

    It emits the same event sequence OpenAI's Responses streaming API produces so
    ChatKit builds and persists a real assistant message, and it rejects any
    replayed assistant content that carries output-only fields (e.g. ``logprobs``)
    the way OpenRouter's stateless Responses API does.
    """

    def __init__(self, text: str, captured: list[Any]) -> None:
        self.text = text
        self.captured = captured

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def stream_response(  # type: ignore[override]
        self,
        system_instructions: str | None,
        input: str | list[Any],
        *args: Any,
        **kwargs: Any,
    ) -> AsyncIterator[Any]:
        self.captured.append(input)
        if isinstance(input, list):
            for item in input:
                if not isinstance(item, dict) or item.get("role") != "assistant":
                    continue
                for part in item.get("content") or []:
                    if isinstance(part, dict) and "logprobs" in part:
                        raise RuntimeError(
                            "400 invalid_prompt: Unknown parameter: input[].content[].logprobs"
                        )
        text = self.text
        counter = 0

        def seq() -> int:
            nonlocal counter
            counter += 1
            return counter

        yield ResponseCreatedEvent(
            type="response.created",
            response=_make_response("", status="in_progress", with_output=False),
            sequence_number=seq(),
        )
        yield ResponseOutputItemAddedEvent(
            type="response.output_item.added",
            output_index=0,
            item=ResponseOutputMessage(
                id="msg_1", type="message", role="assistant", status="in_progress", content=[]
            ),
            sequence_number=seq(),
        )
        yield ResponseContentPartAddedEvent(
            type="response.content_part.added",
            item_id="msg_1",
            output_index=0,
            content_index=0,
            part=ResponseOutputText(type="output_text", text="", annotations=[]),
            sequence_number=seq(),
        )
        yield ResponseTextDeltaEvent(
            type="response.output_text.delta",
            item_id="msg_1",
            output_index=0,
            content_index=0,
            delta=text,
            sequence_number=seq(),
            logprobs=[],
        )
        done_part = ResponseOutputText(type="output_text", text=text, annotations=[])
        yield ResponseTextDoneEvent(
            type="response.output_text.done",
            item_id="msg_1",
            output_index=0,
            content_index=0,
            text=text,
            sequence_number=seq(),
            logprobs=[],
        )
        yield ResponseContentPartDoneEvent(
            type="response.content_part.done",
            item_id="msg_1",
            output_index=0,
            content_index=0,
            part=done_part,
            sequence_number=seq(),
        )
        yield ResponseOutputItemDoneEvent(
            type="response.output_item.done",
            output_index=0,
            item=ResponseOutputMessage(
                id="msg_1",
                type="message",
                role="assistant",
                status="completed",
                content=[done_part],
            ),
            sequence_number=seq(),
        )
        yield ResponseCompletedEvent(
            type="response.completed",
            response=_make_response(text),
            sequence_number=seq(),
        )


def install_fake_model(client: TestClient, replies: Sequence[str]) -> list[Any]:
    """Point the chat server at a scripted fake model. Returns captured inputs."""
    captured: list[Any] = []
    replies = list(replies)
    index = {"value": 0}

    class Provider(ModelProvider):
        def get_model(self, model_name: str | None) -> Model:
            reply = replies[min(index["value"], len(replies) - 1)]
            index["value"] += 1
            return _RecordingResponsesModel(reply, captured)

    client.app.state.services.chat.model_provider = Provider()
    return captured


def send_user_message(client: TestClient, thread_id: str, text: str) -> list[dict[str, Any]]:
    response = chatkit_request(
        client,
        {
            "type": "threads.add_user_message",
            "params": {
                "thread_id": thread_id,
                "input": {
                    "content": [{"type": "input_text", "text": text}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                },
            },
        },
    )
    assert response.status_code == 200
    return [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]


def create_thread_with_model(client: TestClient, text: str) -> tuple[str, list[dict[str, Any]]]:
    response = chatkit_request(
        client,
        {
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": text}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                }
            },
        },
    )
    assert response.status_code == 200
    events = [
        json.loads(line.removeprefix("data: "))
        for line in response.text.splitlines()
        if line.startswith("data: ")
    ]
    thread_id = next(event["thread"]["id"] for event in events if event["type"] == "thread.created")
    return thread_id, events


def test_follow_on_request_replays_assistant_history_as_plain_text(client: TestClient) -> None:
    captured = install_fake_model(client, ["First answer", "Second answer"])

    thread_id, first_events = create_thread_with_model(client, "hi")
    assert "error" not in {event["type"] for event in first_events}

    follow_on = send_user_message(client, thread_id, "what can you do")

    # The follow-on turn must succeed — this is the regression the user reported.
    assert "error" not in {event["type"] for event in follow_on}

    # The prior assistant turn is replayed to the model as provider-safe input_text
    # (no fabricated output-only fields such as ``logprobs``) so OpenRouter accepts it.
    follow_on_input = captured[1]
    assistant_items = [item for item in follow_on_input if item.get("role") == "assistant"]
    assert assistant_items, "prior assistant turn should be replayed as context"
    for item in assistant_items:
        for part in item["content"]:
            assert part["type"] == "input_text"
            assert "logprobs" not in part
            assert "annotations" not in part
    assert [item["content"][0]["text"] for item in assistant_items] == ["First answer"]


def test_thread_title_is_derived_from_the_first_user_message(client: TestClient) -> None:
    install_fake_model(client, ["Answer"])

    thread_id, events = create_thread_with_model(
        client, "Explain how the authentication module handles refresh tokens"
    )

    assert "thread.updated" in {event["type"] for event in events}
    loaded = chatkit_request(
        client,
        {"type": "threads.get_by_id", "params": {"thread_id": thread_id}},
    )
    title = loaded.json()["title"]
    assert title is not None
    assert title != "New thread"
    assert title.startswith("Explain how the authentication")
    assert len(title) <= 48


def test_long_first_message_title_is_truncated_with_ellipsis(client: TestClient) -> None:
    install_fake_model(client, ["Answer"])
    long_prompt = "Summarize " + "the quarterly revenue analysis " * 5
    thread_id, _ = create_thread_with_model(client, long_prompt)

    loaded = chatkit_request(
        client,
        {"type": "threads.get_by_id", "params": {"thread_id": thread_id}},
    )
    title = loaded.json()["title"]
    assert len(title) <= 48
    assert title.endswith("\u2026")
