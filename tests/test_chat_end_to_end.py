"""The chat loop from tool call to applied effect, with a model that scripts its own tool calls.

The fake model in test_phase_seven_chat.py only returns text. This one can also call a tool, so
these tests cover what that one cannot: the run stops at a durable effect, the browser decides,
and the run resumes with the stored result.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any, cast

import pytest
from fastapi.testclient import TestClient
from test_chat_capability_lifecycle import set_chat_autonomy
from test_phase_seven_chat import chatkit_request, create_thread_with_model

from sangam.chat_models import Call, Say, ScriptedModelProvider, Step


def script_model(client: TestClient, steps: Sequence[Step]) -> list[Any]:
    remaining = list(steps)
    seen: list[Any] = []

    provider = ScriptedModelProvider(remaining, seen)
    connections = client.app.state.services.provider_connections
    connections._credential_overrides["openrouter"] = "sk-test"
    client.app.state.services.chat._model_provider = provider
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


def test_constructor_injected_model_provider(client: TestClient) -> None:
    seen: list[Any] = []
    provider = ScriptedModelProvider([Say("Constructor injected answer.")], seen)
    connections = client.app.state.services.provider_connections
    connections._credential_overrides["openrouter"] = "sk-test"
    client.app.state.services.chat._model_provider = provider
    thread_id, events = create_thread_with_model(client, "Hello constructor model")
    assert assistant_text(events) == "Constructor injected answer."
