"""Drive continuity through a disposable live server and inspect committed provenance."""

from __future__ import annotations

import json
import os
import re
import sqlite3
import uuid
from pathlib import Path

import httpx

from sangam.chat_continuity import HistoryPage, TaskState


def main() -> None:
    checks: list[str] = []
    api = httpx.Client(base_url=os.environ["SANGAM_API_URL"] + "/api/v1", timeout=180)
    db = sqlite3.connect(os.environ["SANGAM_DATABASE_PATH"])
    config = api.get("/chat/config").raise_for_status().json()
    model = config["default_model"]
    assert config["autonomy_mode"] == "review", config["autonomy_mode"]
    turn_number = 0

    def turn(
        text: str, thread_id: str | None = None, project_id: str | None = None
    ) -> tuple[str, str]:
        nonlocal turn_number
        turn_number += 1
        params = {
            "input": {
                "content": [{"type": "input_text", "text": text}],
                "attachments": [],
                "inference_options": {"model": model},
            }
        }
        if thread_id:
            params["thread_id"] = thread_id
        request_headers = {"X-Sangam-Workspace-Context": "1"}
        if project_id:
            request_headers["X-Sangam-Project-ID"] = project_id
        response = api.post(
            "/chatkit",
            headers=request_headers,
            json={
                "type": "threads.add_user_message" if thread_id else "threads.create",
                "params": params,
            },
        ).raise_for_status()
        events = [
            json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
        ]
        (
            Path(os.environ["SANGAM_ARTIFACTS_DIR"]) / f"continuity-turn-{turn_number}.json"
        ).write_text(json.dumps(events, indent=2), encoding="utf-8")
        errors = [event for event in events if event["type"] == "error"]
        assert not errors, errors
        if thread_id is None:
            thread_id = next(
                event["thread"]["id"] for event in events if event["type"] == "thread.created"
            )
        return thread_id, response.text

    def state(thread: str) -> TaskState:
        return TaskState.model_validate(
            api.get(f"/chat/threads/{thread}/task").raise_for_status().json()
        )

    thread, _ = turn(
        "Plan a fictional Atlas launch brief. The objective is a launch brief. "
        "Use French and keep it under 300 words. Reply in chat only, do not create "
        "documents or publish. Acknowledge these constraints without drafting yet."
    )
    thread, _ = turn("Draft the brief now. Keep the original requirements.", thread)
    first = state(thread)
    assert first.version > 0, first
    assert any(re.search(r"french|français", note.text, re.I) for note in first.notes), first
    assert any("300" in note.text for note in first.notes), first
    for note in first.notes:
        for item in note.source_item_ids:
            assert db.execute(
                "SELECT 1 FROM chat_thread_items WHERE thread_id=? AND item_id=?", (thread, item)
            ).fetchone(), item
    checks.append("production compaction retains early constraints beyond a two-message window")

    turn(
        "Change the language to English. Keep all other requirements. Reply in chat.",
        thread,
    )
    steered = state(thread)
    assert any(re.search(r"english|anglais", note.text, re.I) for note in steered.notes), steered
    assert any("300" in note.text for note in steered.notes), steered
    assert not any(
        re.search(r"french|français", note.text, re.I) and note.kind == "constraint"
        for note in steered.notes
    ), steered
    checks.append(
        "latest steering replaces language while preserving the independent length constraint"
    )

    length = next(note for note in steered.notes if "300" in note.text)
    body = {
        "thread_id": thread,
        "key": length.key,
        "text": "At most 120 words",
        "expected_version": steered.version,
    }
    key = str(uuid.uuid4())
    corrected = TaskState.model_validate(
        api.put(f"/chat/threads/{thread}/task", json=body, headers={"Idempotency-Key": key})
        .raise_for_status()
        .json()
    )
    replay = (
        api.put(f"/chat/threads/{thread}/task", json=body, headers={"Idempotency-Key": key})
        .raise_for_status()
        .json()
    )
    assert replay == corrected.model_dump(mode="json")
    assert api.put(f"/chat/threads/{thread}/task", json=body).status_code == 409
    assert state(thread).version == corrected.version
    turn("Continue with the current task constraints. Reply in chat only.", thread)
    continued = state(thread)
    assert any("120" in note.text for note in continued.notes), continued
    assert not any("300" in note.text for note in continued.notes), continued
    checks.append("manual correction replays once, rejects stale edits and survives the next turn")

    turn(
        f"Request an exact summary-editor correction for field {length.key}: "
        "set its text to 'At most 200 words'. Use correct_task_state after inspecting "
        "the current version. This is a summary editor request, not ordinary task steering.",
        thread,
    )
    pending = (
        api.get("/chat/effects", params={"thread_id": thread, "status": "pending_approval"})
        .raise_for_status()
        .json()
    )
    candidates = [entry for entry in pending if entry["capability_id"] == "correct_task_state"]
    assert candidates, api.get("/chat/effects", params={"thread_id": thread}).json()
    effect = candidates[0]
    assert any("120" in note.text for note in state(thread).notes), state(thread)
    api.post(
        f"/chat/effects/{effect['effect_id']}/decision",
        json={
            "verdict": "deny",
            "argument_digest": effect["argument_digest"],
            "reason": "Continuity denial proof",
        },
    ).raise_for_status()
    turn(
        "That summary correction was denied. Keep the existing 120-word constraint. "
        "Reply with the current constraint; do not request another effect.",
        thread,
    )
    denied_state = state(thread)
    assert any("120" in note.text for note in denied_state.notes), denied_state
    assert not any(
        "200" in note.text and note.kind == "constraint" for note in denied_state.notes
    ), denied_state
    assert any(
        entry["effect_id"] == effect["effect_id"] and entry["status"] == "denied"
        for entry in denied_state.effects
    )
    checks.append(
        "pending correction stays unapplied; denial remains authoritative after compaction"
    )

    turn(
        f"Request an exact summary-editor correction for field {length.key}: "
        "set its text to 'At most 150 words'. Inspect the current version, then call "
        "correct_task_state. This is a summary editor request, not ordinary task steering.",
        thread,
    )
    pending = (
        api.get("/chat/effects", params={"thread_id": thread, "status": "pending_approval"})
        .raise_for_status()
        .json()
    )
    candidates = [entry for entry in pending if entry["capability_id"] == "correct_task_state"]
    assert candidates, pending
    approved = candidates[0]
    decision = {"verdict": "approve", "argument_digest": approved["argument_digest"]}
    result = (
        api.post(f"/chat/effects/{approved['effect_id']}/decision", json=decision)
        .raise_for_status()
        .json()
    )
    assert result["effect"]["status"] == "completed", result
    approved_state = state(thread)
    assert any("150" in note.text for note in approved_state.notes), approved_state
    api.post(f"/chat/effects/{approved['effect_id']}/decision", json=decision).raise_for_status()
    assert state(thread).version == approved_state.version
    checks.append("approved exact correction executes once through the canonical audited service")

    project = (
        api.post(
            "/projects",
            json={"name": "Continuity proof", "create_brief": False},
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )
        .raise_for_status()
        .json()
    )
    api.post(
        f"/projects/{project['project_id']}/threads", json={"thread_id": thread}
    ).raise_for_status()
    unrelated, _ = turn("Atlas is a fictional name. Reply only with acknowledged.")
    found = HistoryPage.model_validate(
        api.get("/chat/history", params={"query": "Atlas", "project_id": project["project_id"]})
        .raise_for_status()
        .json()
    )
    assert found.entries and all(entry.thread_id == thread for entry in found.entries), found
    assert unrelated not in {entry.thread_id for entry in found.entries}
    source = found.entries[0]
    read = HistoryPage.model_validate(
        api.get(f"/chat/threads/{thread}/messages/{source.item_id}").raise_for_status().json()
    )
    assert read.entries[0].citation.endswith(source.item_id)
    assert len(read.entries[0].text) <= 1200
    checks.append("bounded original history uses stable project membership and linked source IDs")

    agent = (
        api.post(
            "/agent-tokens",
            json={
                "actor_id": "agent:continuity-proof",
                "display_name": "Proof",
                "label": "Disposable proof",
                "scopes": [{"capability": "read"}, {"capability": "search"}],
            },
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )
        .raise_for_status()
        .json()
    )
    headers = {"Authorization": "Bearer " + agent["token"]}
    assert api.get(f"/chat/threads/{thread}/task", headers=headers).status_code == 404
    assert (
        api.get(f"/chat/threads/{thread}/messages/{source.item_id}", headers=headers).status_code
        == 404
    )
    assert (
        api.get("/chat/history", params={"query": "Atlas"}, headers=headers)
        .raise_for_status()
        .json()["entries"]
        == []
    )
    checks.append("another actor cannot inspect task state or read/search the owner's transcript")

    born, _ = turn(
        "Atlas binding probe. Reply only with acknowledged.", project_id=project["project_id"]
    )
    api.post(
        f"/projects/{project['project_id']}/threads", json={"thread_id": born}
    ).raise_for_status()
    scoped = {"query": "binding", "project_id": project["project_id"]}
    assert api.get("/chat/history", params=scoped).raise_for_status().json()["entries"]
    api.delete(
        f"/projects/{project['project_id']}/threads/{born}",
        headers={"Idempotency-Key": str(uuid.uuid4())},
    ).raise_for_status()
    assert api.get("/chat/history", params=scoped).raise_for_status().json()["entries"] == []
    checks.append("removing a conversation also clears its initial project binding from recall")

    evidence = {
        "checks": checks,
        "thread_id": thread,
        "state": approved_state.model_dump(mode="json"),
        "project_id": project["project_id"],
        "source_item_id": source.item_id,
    }
    path = Path(os.environ["SANGAM_ARTIFACTS_DIR"]) / "chat-continuity.json"
    path.write_text(json.dumps(evidence, indent=2), encoding="utf-8")
    print(json.dumps({"passed": len(checks), "evidence": str(path), "thread_id": thread}))


if __name__ == "__main__":
    main()
