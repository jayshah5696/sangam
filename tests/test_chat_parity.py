"""Chat does what a user can do, through the same services, with the same authority."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from agents.tool_context import ToolContext as AgentsToolContext
from chatkit.agents import AgentContext
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient
from test_chat_capability_lifecycle import prepare_effect, set_chat_autonomy
from test_phase_seven_chat import create_thread

from sangam.chat import agent_instructions
from sangam.chat_context import ChatRequestContext
from sangam.errors import AuthorizationError
from sangam.security import Principal


def human() -> Principal:
    return Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="chat-parity"
    )


def call_tool(client: TestClient, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Invoke one registered agent tool exactly as the Agents SDK would."""
    chat = client.app.state.services.chat
    principal = human()
    thread_id = create_thread(client)
    request_context = ChatRequestContext(principal=principal)
    thread = asyncio.run(chat.store_adapter.load_thread(thread_id, request_context))
    agent_context = AgentContext(
        thread=thread, store=chat.store_adapter, request_context=request_context
    )
    tool = next(tool for tool in chat.tools if tool.name == name)
    encoded = json.dumps(arguments)
    context = AgentsToolContext(
        context=agent_context, tool_name=name, tool_call_id=f"call-{name}", tool_arguments=encoded
    )
    return json.loads(asyncio.run(tool.on_invoke_tool(context, encoded)))


def create_document(client: TestClient, key: str, **fields: Any) -> dict[str, Any]:
    body = {"title": key, "content": f"content of {key}", **fields}
    response = client.post("/api/v1/documents", json=body, headers=headers(key))
    assert response.status_code == 201, response.text
    return response.json()


def test_search_tool_passes_the_filters_the_search_page_offers(client: TestClient) -> None:
    kept = create_document(client, "filter-kept", content="shared term", path="a/kept.md")
    other = create_document(client, "filter-other", content="shared term", path="a/other.md")
    for document, category in ((kept, "reports"), (other, "notes")):
        response = client.patch(
            f"/api/v1/documents/{document['document_id']}/metadata",
            json={"expected_metadata_version": 0, "category": category, "tag_ids": []},
            headers=headers(f"category-{category}"),
        )
        assert response.status_code == 200, response.text

    unfiltered = call_tool(client, "search_workspace", {"query": "shared"})
    filtered = call_tool(client, "search_workspace", {"query": "shared", "category": "reports"})

    assert len(unfiltered["results"]) == 2
    assert [item["document_id"] for item in filtered["results"]] == [kept["document_id"]]


def test_read_document_reports_what_the_ui_shows_beside_the_text(client: TestClient) -> None:
    document = create_document(client, "metadata-read", path="meta/read.md")
    client.patch(
        f"/api/v1/documents/{document['document_id']}/metadata",
        json={"expected_metadata_version": 0, "category": "reports", "tag_ids": []},
        headers=headers("read-metadata"),
    )
    linking = create_document(
        client, "backlink-source", content=f"see sangam://document/{document['document_id']}"
    )

    payload = call_tool(client, "read_document", {"document_id": document["document_id"]})

    assert payload["source"]["category"] == "reports"
    assert payload["source"]["trust_level"] == "untrusted"
    assert [item["document_id"] for item in payload["backlinks"]] == [linking["document_id"]]


def test_revision_history_tool_lists_revisions_and_diffs_two_of_them(client: TestClient) -> None:
    first = create_document(client, "history-doc", content="one\n", path="h/doc.md")
    second = client.patch(
        f"/api/v1/documents/{first['document_id']}",
        json={"expected_revision_id": first["current_revision_id"], "content": "one\ntwo\n"},
        headers=headers("history-update"),
    ).json()

    history = call_tool(client, "read_revision_history", {"document_id": first["document_id"]})
    diff = call_tool(
        client,
        "read_revision_history",
        {
            "document_id": first["document_id"],
            "from_revision_id": first["current_revision_id"],
            "to_revision_id": second["current_revision_id"],
        },
    )

    assert [item["revision_id"] for item in history["revisions"]] == [
        second["current_revision_id"],
        first["current_revision_id"],
    ]
    assert "+two" in diff["diff"]["unified_diff"]


def test_projects_are_readable_by_chat(client: TestClient) -> None:
    source = create_document(client, "project-source", path="p/source.md")
    project = client.post(
        "/api/v1/projects",
        json={"name": "Chat visible", "create_brief": False},
        headers=headers("project-read"),
    ).json()
    client.post(
        f"/api/v1/projects/{project['project_id']}/documents",
        json={"document_id": source["document_id"], "role": "source"},
        headers=headers("project-read-member"),
    )

    listing = call_tool(client, "inspect_projects", {})
    detail = call_tool(client, "inspect_projects", {"project_id": project["project_id"]})

    assert [item["name"] for item in listing["projects"]] == ["Chat visible"]
    assert [item["document_id"] for item in detail["project"]["documents"]] == [
        source["document_id"]
    ]


def plan(*operations: dict[str, Any]) -> dict[str, Any]:
    return {"operations": list(operations)}


def test_plan_restores_a_revision_and_an_un_trashed_document(client: TestClient) -> None:
    set_chat_autonomy(client, "workspace")
    document = create_document(client, "restore-doc", content="original\n", path="r/doc.md")
    edited = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={"expected_revision_id": document["current_revision_id"], "content": "edited\n"},
        headers=headers("restore-edit"),
    ).json()

    restored = prepare_effect(
        client,
        capability_id="apply_workspace_organization_plan",
        arguments=plan(
            {
                "kind": "restore_document",
                "document_id": document["document_id"],
                "expected_revision_id": edited["current_revision_id"],
                "revision_id": document["current_revision_id"],
            }
        ),
        tool_call_id="call_restore_revision",
    )

    assert restored.effect.status == "completed"
    current = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert current["content"] == "original\n"
    events = client.get(
        "/api/v1/activity",
        params={"actor_kind": "human", "resource_id": document["document_id"]},
    ).json()
    assert ("restore", "accepted") in {(e["action"], e["outcome"]) for e in events}

    trashed = client.request(
        "DELETE",
        f"/api/v1/documents/{document['document_id']}",
        json={"expected_revision_id": current["current_revision_id"]},
        headers=headers("restore-trash"),
    ).json()
    back = prepare_effect(
        client,
        capability_id="apply_workspace_organization_plan",
        arguments=plan(
            {
                "kind": "restore_document",
                "document_id": document["document_id"],
                "expected_revision_id": trashed["current_revision_id"],
                "revision_id": current["current_revision_id"],
            }
        ),
        tool_call_id="call_restore_trash",
    )
    assert back.effect.status == "completed"
    assert client.get(f"/api/v1/documents/{document['document_id']}").json()["deleted"] is False


def test_plan_duplicates_a_document_at_a_new_path(client: TestClient) -> None:
    set_chat_autonomy(client, "workspace")
    source = create_document(client, "dup-doc", content="copy me\n", path="d/source.md")

    duplicated = prepare_effect(
        client,
        capability_id="apply_workspace_organization_plan",
        arguments=plan(
            {
                "kind": "duplicate_document",
                "document_id": source["document_id"],
                "expected_revision_id": source["current_revision_id"],
                "title": "Copy of dup",
                "destination_path": "d/copy.md",
            }
        ),
        tool_call_id="call_duplicate",
    )

    assert duplicated.effect.status == "completed"
    documents = {d["path"]: d for d in client.get("/api/v1/documents").json()}
    assert documents["d/copy.md"]["title"] == "Copy of dup"
    copy = client.get(f"/api/v1/documents/{documents['d/copy.md']['document_id']}").json()
    assert copy["content"] == "copy me\n"


def test_plan_restore_and_duplicate_are_refused_without_their_authority(
    client: TestClient,
) -> None:
    token = issue_agent_token(client, actor_id="agent:reader", capabilities=("read", "create"))
    source = create_document(client, "no-restore", path="n/doc.md")
    services = client.app.state.services
    agent = services.identity.authenticate(token, operation_id="restore-denied")
    from sangam.schemas import ApplyOrganizationPlan

    restore = ApplyOrganizationPlan.model_validate(
        plan(
            {
                "kind": "restore_document",
                "document_id": source["document_id"],
                "expected_revision_id": source["current_revision_id"],
                "revision_id": source["current_revision_id"],
            }
        )
    )
    with pytest.raises(AuthorizationError):
        services.workspace_access.preflight_organization_plan(agent, plan=restore)


def execute_project_change(client: TestClient, tool_call: str, arguments: dict[str, Any]):
    set_chat_autonomy(client, "workspace")
    return prepare_effect(
        client, capability_id="update_project", arguments=arguments, tool_call_id=tool_call
    )


def test_chat_creates_a_project_and_manages_its_documents(client: TestClient) -> None:
    source = create_document(client, "member-doc", path="m/doc.md")

    created = execute_project_change(
        client,
        "call_project_create",
        {"change": {"kind": "create_project", "name": "From chat", "create_brief": False}},
    )
    assert created.effect.status == "completed"
    project_id = created.effect.resource_id
    assert client.get(f"/api/v1/projects/{project_id}").json()["name"] == "From chat"

    added = execute_project_change(
        client,
        "call_project_add",
        {
            "change": {
                "kind": "add_document",
                "project_id": project_id,
                "document_id": source["document_id"],
                "role": "source",
            }
        },
    )
    assert added.effect.status == "completed"
    members = client.get(f"/api/v1/projects/{project_id}").json()["documents"]
    assert [m["document_id"] for m in members] == [source["document_id"]]

    removed = execute_project_change(
        client,
        "call_project_remove",
        {
            "change": {
                "kind": "remove_document",
                "project_id": project_id,
                "document_id": source["document_id"],
            }
        },
    )
    assert removed.effect.status == "completed"
    assert client.get(f"/api/v1/projects/{project_id}").json()["documents"] == []
    actions = {
        e["action"]
        for e in client.get(
            "/api/v1/activity",
            params={"actor_kind": "human", "resource_type": "project", "limit": 200},
        ).json()
    }
    assert {"create", "add_document", "remove_document"} <= actions


def test_project_tools_are_offered_only_to_administrators(client: TestClient) -> None:
    services = client.app.state.services
    chat = services.chat
    token = issue_agent_token(
        client,
        actor_id="agent:everything",
        capabilities=("read", "search", "create", "update", "move", "tag", "restore", "delete"),
    )
    agent = services.identity.authenticate(token, operation_id="project-scope")

    def offered(principal: Principal) -> set[str]:
        return {
            capability.capability_id
            for capability in chat.capabilities.resolve(
                principal=principal,
                policy=services.authorization,
                entry_point="workspace",
                document=None,
                model_supports_tools=True,
            )
        }

    assert {"inspect_projects", "update_project"} <= offered(human())
    assert not {"inspect_projects", "update_project"} & offered(agent)


def test_instructions_describe_exactly_the_tools_the_run_has(client: TestClient) -> None:
    chat = client.app.state.services.chat
    everything = chat.capabilities.capabilities
    read_only = tuple(c for c in everything if c.effect_class.value == "read")

    full = agent_instructions(everything)
    narrow = agent_instructions(read_only)

    assert "publish_document" in full and "publish_document" not in narrow
    assert "update_project" in full and "update_project" not in narrow
    # Trash is a real plan operation, so the prompt must not forbid it.
    assert "Do not add delete" not in full
    assert "trash_document" in full
