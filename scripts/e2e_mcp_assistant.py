"""Script only the model boundary in the isolated browser server, never production."""

import asyncio
import json
from collections.abc import Callable
from uuid import uuid4

from agents.models.interface import Model, ModelProvider
from fastapi import FastAPI
from openai.types.responses import (
    Response,
    ResponseCompletedEvent,
    ResponseContentPartAddedEvent,
    ResponseContentPartDoneEvent,
    ResponseCreatedEvent,
    ResponseFunctionToolCall,
    ResponseOutputItemAddedEvent,
    ResponseOutputItemDoneEvent,
    ResponseOutputMessage,
    ResponseOutputText,
    ResponseTextDeltaEvent,
    ResponseTextDoneEvent,
)
from pydantic import BaseModel, ConfigDict


class FixtureInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: str
    expected_revision_id: str
    content: str
    summary: str
    answer: str
    hold: bool = False


class FixtureModel(Model):
    def __init__(self, fixture: FixtureInput, released: asyncio.Event):
        self.fixture, self.released = fixture, released

    async def get_response(self, *args, **kwargs):
        raise NotImplementedError("The browser fixture requires streaming ChatKit.")

    async def stream_response(self, system_instructions, input, *args, **kwargs):  # noqa: A002
        await self.released.wait()
        fixture = self.fixture
        should_propose = "function_call_output" not in json.dumps(input)
        item = (
            ResponseFunctionToolCall(
                id=f"fc_{uuid4().hex}",
                call_id=f"call_{uuid4().hex}",
                type="function_call",
                name="propose_update",
                arguments=json.dumps(
                    {
                        "document_id": fixture.document_id,
                        "expected_revision_id": fixture.expected_revision_id,
                        "content": fixture.content,
                        "summary": fixture.summary,
                    }
                ),
                status="completed",
            )
            if should_propose
            else ResponseOutputMessage(
                id=f"msg_{uuid4().hex}",
                type="message",
                role="assistant",
                status="completed",
                content=[
                    ResponseOutputText(type="output_text", text=fixture.answer, annotations=[])
                ],
            )
        )
        base = {
            "id": f"resp_{uuid4().hex}",
            "object": "response",
            "created_at": 0,
            "model": "browser-fixture",
            "parallel_tool_calls": False,
            "tool_choice": "auto",
            "tools": [],
            "instructions": None,
        }
        yield ResponseCreatedEvent(
            type="response.created",
            response=Response.model_validate({**base, "status": "in_progress", "output": []}),
            sequence_number=1,
        )
        yield ResponseOutputItemAddedEvent(
            type="response.output_item.added", output_index=0, item=item, sequence_number=2
        )
        if isinstance(item, ResponseOutputMessage):
            part = item.content[0]
            yield ResponseContentPartAddedEvent(
                type="response.content_part.added",
                item_id=item.id,
                output_index=0,
                content_index=0,
                part=ResponseOutputText(type="output_text", text="", annotations=[]),
                sequence_number=3,
            )
            yield ResponseTextDeltaEvent(
                type="response.output_text.delta",
                item_id=item.id,
                output_index=0,
                content_index=0,
                delta=fixture.answer,
                sequence_number=4,
                logprobs=[],
            )
            yield ResponseTextDoneEvent(
                type="response.output_text.done",
                item_id=item.id,
                output_index=0,
                content_index=0,
                text=fixture.answer,
                sequence_number=5,
                logprobs=[],
            )
            yield ResponseContentPartDoneEvent(
                type="response.content_part.done",
                item_id=item.id,
                output_index=0,
                content_index=0,
                part=part,
                sequence_number=6,
            )
        yield ResponseOutputItemDoneEvent(
            type="response.output_item.done", output_index=0, item=item, sequence_number=7
        )
        yield ResponseCompletedEvent(
            type="response.completed",
            response=Response.model_validate({**base, "status": "completed", "output": [item]}),
            sequence_number=8,
        )


def register(app: FastAPI) -> None:
    fixture: FixtureInput | None = None
    released: asyncio.Event | None = None
    original_provider: Callable[[str], ModelProvider] | None = None
    original_credential: str | None = None

    @app.post("/__e2e/mcp-assistant")
    async def configure(payload: FixtureInput) -> dict[str, bool]:
        nonlocal fixture, released, original_provider, original_credential
        fixture = payload
        released = asyncio.Event()
        if not payload.hold:
            released.set()
        event = released

        class Provider(ModelProvider):
            def get_model(self, model_name):
                return FixtureModel(payload, event)

        connections = app.state.services.provider_connections
        if original_provider is None:
            original_provider = connections.model_provider
            original_credential = connections._credential_overrides.get("openrouter")
        connections._credential_overrides["openrouter"] = "browser-fixture"
        connections.model_provider = lambda _connection_id: Provider()
        return {"configured": True}

    @app.post("/__e2e/mcp-assistant/reset")
    async def reset() -> dict[str, bool]:
        nonlocal fixture, released, original_provider
        if released is not None:
            released.set()
        if original_provider is not None:
            connections = app.state.services.provider_connections
            connections.model_provider = original_provider
            if original_credential is None:
                connections._credential_overrides.pop("openrouter", None)
            else:
                connections._credential_overrides["openrouter"] = original_credential
            original_provider = None
        fixture, released = None, None
        return {"reset": True}

    @app.post("/__e2e/mcp-assistant/release")
    async def release() -> dict[str, bool]:
        if released is None:
            raise RuntimeError("Configure the fixture before releasing it.")
        released.set()
        return {"released": True}

    @app.post("/__e2e/mcp-assistant/evidence")
    async def evidence() -> dict[str, int | str]:
        if fixture is None:
            raise RuntimeError("Configure the fixture before reading evidence.")
        with app.state.services.documents.database.connection() as connection:
            requests = connection.execute(
                "SELECT count(*) AS requests, count(DISTINCT conversation_id) AS conversations "
                "FROM assistant_requests WHERE document_id=?",
                (fixture.document_id,),
            ).fetchone()
            selected = connection.execute(
                "SELECT selection_text FROM chat_turn_contexts "
                "WHERE document_id=? AND selection_text != '' ORDER BY created_at LIMIT 1",
                (fixture.document_id,),
            ).fetchone()
        return {
            "request_count": requests["requests"],
            "conversation_count": requests["conversations"],
            "selected_text": selected["selection_text"] if selected else "",
        }
