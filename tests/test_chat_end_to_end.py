"""The chat loop from tool call to applied effect, with a model that scripts its own tool calls.

The fake model in test_phase_seven_chat.py only returns text. This one can also call a tool, so
these tests cover what that one cannot: the run stops at a durable effect, the browser decides,
and the run resumes with the stored result.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from typing import Any, Literal, cast

import pytest
from agents.models.interface import Model, ModelProvider
from fastapi.testclient import TestClient
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseContentPartAddedEvent,
    ResponseContentPartDoneEvent,
    ResponseCreatedEvent,
    ResponseFunctionCallArgumentsDeltaEvent,
    ResponseFunctionCallArgumentsDoneEvent,
    ResponseFunctionToolCall,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseTextDeltaEvent,
    ResponseTextDoneEvent,
)
from test_chat_capability_lifecycle import set_chat_autonomy
from test_phase_seven_chat import chatkit_request, create_thread_with_model


class Say:
    def __init__(self, text: str) -> None:
        self.text = text


class Call:
    def __init__(self, name: str, arguments: dict[str, Any]) -> None:
        self.name = name
        self.arguments = arguments


Step = Say | Call


def _response(output: list[Any], status: Literal["completed", "in_progress"] = "completed"):
    return Response(
        id="resp_scripted",
        object="response",
        created_at=0,
        model="scripted",
        output=output,
        parallel_tool_calls=False,
        tool_choice="auto",
        tools=[],
        instructions=None,
        status=status,
    )


class ScriptedModel(Model):
    """Plays the next step of a shared script each time the agent asks for a response."""

    def __init__(self, steps: list[Step], seen: list[Any]) -> None:
        self.steps = steps
        self.seen = seen

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError

    async def stream_response(  # type: ignore[override]
        self, system_instructions: str | None, input: str | list[Any], *args: Any, **kwargs: Any
    ) -> AsyncIterator[Any]:
        self.seen.append(input)
        step = self.steps.pop(0)
        sequence = 0

        def seq() -> int:
            nonlocal sequence
            sequence += 1
            return sequence

        yield ResponseCreatedEvent(
            type="response.created", response=_response([], "in_progress"), sequence_number=seq()
        )
        if isinstance(step, Call):
            encoded = json.dumps(step.arguments)
            pending = ResponseFunctionToolCall(
                type="function_call",
                id="fc_1",
                call_id=f"call_{step.name}",
                name=step.name,
                arguments="",
                status="in_progress",
            )
            yield ResponseOutputItemAddedEvent(
                type="response.output_item.added",
                output_index=0,
                item=pending,
                sequence_number=seq(),
            )
            yield ResponseFunctionCallArgumentsDeltaEvent(
                type="response.function_call_arguments.delta",
                item_id="fc_1",
                output_index=0,
                delta=encoded,
                sequence_number=seq(),
            )
            yield ResponseFunctionCallArgumentsDoneEvent(
                type="response.function_call_arguments.done",
                item_id="fc_1",
                output_index=0,
                name=step.name,
                arguments=encoded,
                sequence_number=seq(),
            )
            done = pending.model_copy(update={"arguments": encoded, "status": "completed"})
            yield ResponseOutputItemDoneEvent(
                type="response.output_item.done",
                output_index=0,
                item=done,
                sequence_number=seq(),
            )
            yield ResponseCompletedEvent(
                type="response.completed", response=_response([done]), sequence_number=seq()
            )
            return
        text = step.text
        part = ResponseOutputText(type="output_text", text=text, annotations=[])
        message = ResponseOutputMessage(
            id="msg_1", type="message", role="assistant", status="completed", content=[part]
        )
        yield ResponseOutputItemAddedEvent(
            type="response.output_item.added",
            output_index=0,
            item=message.model_copy(update={"status": "in_progress", "content": []}),
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
            part=part,
            sequence_number=seq(),
        )
        yield ResponseOutputItemDoneEvent(
            type="response.output_item.done",
            output_index=0,
            item=message,
            sequence_number=seq(),
        )
        yield ResponseCompletedEvent(
            type="response.completed", response=_response([message]), sequence_number=seq()
        )


def script_model(client: TestClient, steps: Sequence[Step]) -> list[Any]:
    """Give the chat server a model that plays `steps`. Returns the inputs it was handed."""
    remaining = list(steps)
    seen: list[Any] = []

    class Provider(ModelProvider):
        def get_model(self, model_name: str | None) -> Model:
            return ScriptedModel(remaining, seen)

    connections = client.app.state.services.provider_connections
    connections._credential_overrides["openrouter"] = "sk-test"
    connections.model_provider = lambda _connection_id: Provider()
    return seen


def events_of(response_text: str) -> list[dict[str, Any]]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in response_text.splitlines()
        if line.startswith("data: ")
    ]


def review_request(events: list[dict[str, Any]]) -> dict[str, Any]:
    """The `review_chat_effect` call the browser is asked to answer."""
    calls = [
        event["item"]
        for event in events
        if event["type"] == "thread.item.done" and event["item"]["type"] == "client_tool_call"
    ]
    assert len(calls) == 1, [event["type"] for event in events]
    assert calls[0]["name"] == "review_chat_effect"
    return cast(dict[str, Any], calls[0]["arguments"])


def resume_with(client: TestClient, thread_id: str, result: dict[str, Any]) -> list[dict[str, Any]]:
    response = chatkit_request(
        client,
        {
            "type": "threads.add_client_tool_output",
            "params": {"thread_id": thread_id, "result": result},
        },
    )
    assert response.status_code == 200
    return events_of(response.text)


def assistant_text(events: list[dict[str, Any]]) -> str:
    return "".join(
        part["text"]
        for event in events
        if event["type"] == "thread.item.done" and event["item"]["type"] == "assistant_message"
        for part in event["item"]["content"]
    )


CREATE_ATLAS = {
    "change": {"kind": "create_project", "name": "Atlas", "create_brief": False},
}


def test_an_approved_effect_resumes_the_run_with_its_stored_result(client: TestClient) -> None:
    set_chat_autonomy(client, "review")
    seen = script_model(client, [Call("update_project", CREATE_ATLAS), Say("Atlas is ready.")])

    thread_id, first = create_thread_with_model(client, "Create a project called Atlas")
    review = review_request(first)

    # The run is parked at the effect: the model was asked once, and nothing was created.
    assert len(seen) == 1
    assert client.get("/api/v1/projects").json() == []
    effect = client.get(f"/api/v1/chat/effects/{review['effect_id']}").json()
    assert effect["status"] == "pending_approval"

    decision = client.post(
        f"/api/v1/chat/effects/{review['effect_id']}/decision",
        json={"verdict": "approve", "argument_digest": review["argument_digest"]},
    )
    assert decision.status_code == 200, decision.text
    result = decision.json()["client_result"]
    assert result["status"] == "created"

    resumed = resume_with(client, thread_id, result)

    assert assistant_text(resumed) == "Atlas is ready."
    assert [p["name"] for p in client.get("/api/v1/projects").json()] == ["Atlas"]
    # The model saw the stored result as the tool's output before it answered.
    assert len(seen) == 2
    outputs = [
        item
        for item in seen[1]
        if isinstance(item, dict) and item.get("type") == "function_call_output"
    ]
    assert outputs and "created" in json.dumps(outputs[-1])


def test_a_denied_effect_changes_nothing_and_the_run_still_finishes(client: TestClient) -> None:
    set_chat_autonomy(client, "review")
    script_model(client, [Call("update_project", CREATE_ATLAS), Say("I did not create it.")])

    thread_id, first = create_thread_with_model(client, "Create a project called Atlas")
    review = review_request(first)
    decision = client.post(
        f"/api/v1/chat/effects/{review['effect_id']}/decision",
        json={"verdict": "deny", "argument_digest": review["argument_digest"]},
    )
    assert decision.status_code == 200, decision.text
    assert decision.json()["client_result"]["approved"] is False

    resumed = resume_with(client, thread_id, decision.json()["client_result"])

    assert assistant_text(resumed) == "I did not create it."
    assert client.get("/api/v1/projects").json() == []
    assert client.get(f"/api/v1/chat/effects/{review['effect_id']}").json()["status"] == "denied"


def test_yolo_mode_applies_the_effect_before_the_run_resumes(client: TestClient) -> None:
    set_chat_autonomy(client, "workspace")
    script_model(client, [Call("update_project", CREATE_ATLAS), Say("Atlas is ready.")])

    thread_id, first = create_thread_with_model(client, "Create a project called Atlas")
    review = review_request(first)

    effect = client.get(f"/api/v1/chat/effects/{review['effect_id']}").json()
    assert effect["status"] == "completed"
    assert [p["name"] for p in client.get("/api/v1/projects").json()] == ["Atlas"]
    resumed = resume_with(client, thread_id, effect["result"])
    assert assistant_text(resumed) == "Atlas is ready."


def test_a_tool_the_run_was_not_given_cannot_be_called(client: TestClient) -> None:
    from conftest import issue_agent_token

    token = issue_agent_token(
        client, actor_id="agent:caller", capabilities=("read", "search", "inference")
    )
    script_model(client, [Call("update_project", CREATE_ATLAS), Say("Could not do that.")])

    response = chatkit_request(
        client,
        {
            "type": "threads.create",
            "params": {
                "input": {
                    "content": [{"type": "input_text", "text": "Create a project"}],
                    "attachments": [],
                    "inference_options": {"model": "openai/gpt-5.4-nano"},
                }
            },
        },
        Authorization=f"Bearer {token}",
    )

    assert response.status_code == 200
    with pytest.raises(AssertionError):
        review_request(events_of(response.text))
    assert client.get("/api/v1/projects").json() == []
