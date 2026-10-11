"""Memory failures: stale correction, replay duplication, scope leakage and resurrection."""

from fastapi.testclient import TestClient

from sangam.chat_profiles import MemorySearch
from sangam.security import Principal


def change(client: TestClient, **kwargs):
    return client.put(
        "/api/v1/chat/memory",
        json={
            "memory_id": "headset",
            "content": "My headset is Quest 3",
            "expected_version": 0,
            **kwargs,
        },
    )


def test_memory_replay_correction_and_content_free_forget(client: TestClient):
    body = {"memory_id": "headset", "content": "My headset is Quest 3", "expected_version": 0}
    first = client.put("/api/v1/chat/memory", json=body, headers={"Idempotency-Key": "save"})
    assert first.status_code == 200
    assert (
        client.put("/api/v1/chat/memory", json=body, headers={"Idempotency-Key": "save"}).json()
        == first.json()
    )
    assert change(client).status_code == 409
    assert (
        change(client, content="My headset is Quest Pro", expected_version=1).json()["version"] == 2
    )
    forgotten = change(client, action="forget", content="", expected_version=2).json()
    assert forgotten["state"] == "forgotten" and forgotten["content"] == ""
    assert change(client, expected_version=3).status_code == 409
    assert client.get("/api/v1/chat/memory").json()["entries"] == []
    with client.app.state.services.chat.evidence.database.connection() as conn:
        row = conn.execute("SELECT content, source_thread_id FROM chat_profile_facts").fetchone()
        assert row["content"] == "" and row["source_thread_id"] is None


def test_suggestions_are_not_recalled_until_accepted_and_dismiss_stays_forgotten(
    client: TestClient,
):
    assert change(client, action="suggest").json()["state"] == "suggested"
    service = client.app.state.services.chat.profiles
    owner = Principal.trusted_human(actor_id="human:jay", display_name="Jay", operation_id="test")
    assert service.search_memory(owner, MemorySearch(query="headset")).entries == []
    assert change(client, action="accept", expected_version=1).json()["state"] == "active"
    assert (
        service.search_memory(owner, MemorySearch(query="headset")).entries[0].memory_id
        == "headset"
    )
    assert change(client, action="forget", expected_version=2, content="").status_code == 200
    assert service.search_memory(owner, MemorySearch(query="headset")).entries == []


def test_memory_actor_project_relevance_and_revision_checks(client: TestClient):
    project = client.post("/api/v1/projects", json={"name": "Atlas", "create_brief": False}).json()[
        "project_id"
    ]
    assert change(client, project_id=project).status_code == 200
    assert client.get("/api/v1/chat/memory").json()["entries"] == []
    service = client.app.state.services.chat.profiles
    owner = Principal.trusted_human(actor_id="human:jay", display_name="Jay", operation_id="test")
    other = Principal.trusted_human(
        actor_id="human:other", display_name="Other", operation_id="test"
    )
    assert service.search_memory(owner, MemorySearch(query="headset")).entries == []
    assert (
        len(service.search_memory(owner, MemorySearch(query="headset", project_id=project)).entries)
        == 1
    )
    assert (
        service.search_memory(owner, MemorySearch(query="unrelated", project_id=project)).entries
        == []
    )
    assert (
        service.search_memory(other, MemorySearch(query="headset", project_id=project)).entries
        == []
    )
    assert change(client, content="x" * 2001).status_code == 422
    assert change(client, source_thread_id="someone-elses-thread").status_code == 404
    assert change(client, project_id="missing").status_code == 404


def test_used_memory_is_current_and_forgetting_does_not_delete_transcript(client: TestClient):
    from sangam.chat_context import ChatRequestContext

    owner = Principal.trusted_human(actor_id="human:jay", display_name="Jay", operation_id="test")
    chat = client.app.state.services.chat
    assert change(client).status_code == 200
    turn = chat.evidence.create_turn_context(
        owner, entry_point="workspace", document_id=None, revision_id=None, selected_text=""
    )
    context = ChatRequestContext(principal=owner, context_snapshot_id=turn.context_id)
    chat.profiles.resolve(context)
    found = chat.profiles.search_memory(
        owner, MemorySearch(query="headset"), context.context_snapshot_id
    )
    assert found.entries[0].content == "My headset is Quest 3"
    assert chat.profiles.resolve(context).memories[0].memory_id == "headset"
    assert change(client, content="My headset is Quest Pro", expected_version=1).status_code == 200
    assert chat.profiles.resolve(context).memories == []
    assert change(client, action="forget", content="", expected_version=2).status_code == 200
    assert chat.profiles.resolve(context).memories == []
    assert "Quest" not in chat.profiles.resolve(context).prompt()
