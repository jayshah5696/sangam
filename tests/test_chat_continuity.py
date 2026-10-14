"""Continuity failures: lost steering, invented provenance, stale edits and history leakage."""

import json
from dataclasses import replace
from datetime import UTC, datetime

import pytest
from chatkit.types import UserMessageItem, UserMessageTextContent
from test_phase_seven_chat import create_thread

from sangam.chat_context import ChatRequestContext
from sangam.chat_continuity import HistorySearch, TaskDraft, TaskNote
from sangam.errors import ConflictError, NotFoundError, ValidationError
from sangam.security import Principal


def owner(actor="human:jay"):
    return Principal.trusted_human(actor_id=actor, display_name="Jay", operation_id="continuity")


def seed(client, thread, item, text):
    chat = client.app.state.services.chat
    client.portal.call(
        chat.store.save_item,
        thread,
        UserMessageItem(
            id=item,
            thread_id=thread,
            created_at=datetime.now(UTC),
            content=[UserMessageTextContent(type="input_text", text=text)],
            attachments=[],
            inference_options={},
        ),
        ChatRequestContext(principal=owner()),
    )


def test_task_versions_steering_and_source_validation(client):
    thread = create_thread(client)
    seed(client, thread, "early", "Build a report. Keep French and limit it to 300 words.")
    service = client.app.state.services.chat.continuity
    draft = TaskDraft(
        notes=[
            TaskNote(
                key="language", kind="constraint", text="Use French", source_item_ids=["early"]
            ),
            TaskNote(key="length", kind="constraint", text="300 words", source_item_ids=["early"]),
        ]
    )
    state = service.save_generated(owner(), thread, 0, draft, "early")
    assert state.version == 1
    corrected = client.put(
        f"/api/v1/chat/threads/{thread}/task",
        json={
            "thread_id": thread,
            "expected_version": 1,
            "key": "language",
            "text": "Use English",
        },
    )
    assert corrected.status_code == 200
    assert [note["text"] for note in corrected.json()["notes"]] == ["Use English", "300 words"]
    assert corrected.json()["notes"][0]["corrected"] is True
    assert (
        client.put(
            f"/api/v1/chat/threads/{thread}/task",
            json={
                "thread_id": thread,
                "expected_version": 1,
                "key": "length",
                "text": "100 words",
            },
        ).status_code
        == 409
    )
    with pytest.raises(ConflictError):
        service.save_generated(owner(), thread, 1, draft, "early")
    with pytest.raises(ValidationError):
        service.save_generated(
            owner(),
            thread,
            2,
            TaskDraft(
                notes=[
                    TaskNote(
                        key="fake", kind="objective", text="Invented", source_item_ids=["missing"]
                    ),
                ]
            ),
            "early",
        )
    client.portal.call(
        client.app.state.services.chat.store.delete_thread_item,
        thread,
        "early",
        ChatRequestContext(principal=owner()),
    )
    state = service.get(owner(), thread)
    assert state.stale and state.notes == []


def test_history_bounded_actor_project_scope_and_linked_sources(client):
    first, second = create_thread(client), create_thread(client)
    seed(client, first, "atlas", "Atlas launch constraint: use French")
    seed(client, second, "other", "Atlas unrelated conversation")
    project = client.post("/api/v1/projects", json={"name": "Atlas", "create_brief": False}).json()
    assert (
        client.post(
            f"/api/v1/projects/{project['project_id']}/threads", json={"thread_id": first}
        ).status_code
        == 201
    )
    service = client.app.state.services.chat.continuity
    page = service.search(owner(), HistorySearch(query="Atlas", project_id=project["project_id"]))
    assert [entry.item_id for entry in page.entries] == ["atlas"]
    assert f"thread_id={first}" in page.entries[0].citation
    assert service.search(owner("human:other"), HistorySearch(query="Atlas")).entries == []
    with pytest.raises(NotFoundError):
        service.read(owner("human:other"), first, "atlas")
    assert service.read(owner(), first, "atlas").entries[0].text.endswith("use French")
    with pytest.raises(NotFoundError):
        service.read(owner(), first, "other")
    assert client.get(f"/api/v1/chat/threads/{first}/task").status_code == 200


def test_task_context_never_reports_background_work_or_grants_authority(client):
    thread = create_thread(client)
    seed(client, thread, "request", "Write the report; await my decision before publishing")
    service = client.app.state.services.chat.continuity
    service.save_generated(
        owner(),
        thread,
        0,
        TaskDraft(
            notes=[
                TaskNote(
                    key="publish",
                    kind="decision",
                    text="Await publication decision",
                    source_item_ids=["request"],
                ),
            ]
        ),
        "request",
    )
    prompt = service.prompt(owner(), thread)
    assert "never authorization" in prompt
    assert "No work continues after a request ends" in prompt
    assert "Await publication decision" in prompt
    assert len(prompt.encode()) < 20000
    # A fresh service instance reads persisted state, rather than process-local memory.
    from sangam.chat_continuity import ChatContinuityService

    chat = client.app.state.services.chat
    restored = ChatContinuityService(chat.evidence.database, chat.workspace, chat.projects)
    assert restored.get(owner(), thread).version == 1


def test_production_turn_compacts_before_history_leaves_model_window(client):
    from test_phase_seven_chat import install_fake_model, send_user_message

    thread = create_thread(client)
    seed(client, thread, "objective", "Write an Atlas launch report in French, at most 300 words")
    for index in range(4):
        seed(client, thread, f"filler-{index}", f"Discuss detail {index}")
    chat = client.app.state.services.chat
    chat.config = replace(chat.config, max_context_messages=2)
    summary = TaskDraft(
        notes=[
            TaskNote(
                key="objective",
                kind="objective",
                text="Write an Atlas launch report",
                source_item_ids=["objective"],
            ),
            TaskNote(
                key="language", kind="constraint", text="Use French", source_item_ids=["objective"]
            ),
            TaskNote(
                key="length",
                kind="constraint",
                text="At most 300 words",
                source_item_ids=["objective"],
            ),
        ]
    )
    captured = install_fake_model(client, [summary.model_dump_json(), "Here is the report."])
    events = send_user_message(client, thread, "Continue")
    assert not [event for event in events if event["type"] == "error"]
    assert len(captured) == 2
    assert "Use French" in json.dumps(captured[-1])
    assert "At most 300 words" in json.dumps(captured[-1])
    assert chat.continuity.get(owner(), thread).version == 1


def test_summary_budget_and_duplicate_keys_are_rejected():
    from pydantic import ValidationError as SchemaError

    note = TaskNote(key="same", kind="objective", text="Task", source_item_ids=["source"])
    with pytest.raises(SchemaError):
        TaskDraft(notes=[note, note])
    with pytest.raises(SchemaError):
        TaskNote(key="large", kind="constraint", text="x" * 601, source_item_ids=["source"])
