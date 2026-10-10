"""Chat does what a user can do, through the same services, with the same authority."""

from __future__ import annotations

import json
from typing import Any

import pytest
from agents.tool_context import ToolContext as AgentsToolContext
from chatkit.agents import AgentContext
from conftest import headers, issue_agent_token, run_in_app
from fastapi.testclient import TestClient
from test_chat_capability_lifecycle import prepare_effect, prepare_run, set_chat_autonomy
from test_phase_five_pdf_research import import_pdf, text_pdf
from test_phase_seven_chat import create_thread

from sangam.chat import agent_instructions
from sangam.chat_capabilities import CreateDocumentInput
from sangam.chat_context import ChatRequestContext
from sangam.errors import AuthorizationError
from sangam.security import Principal


def human() -> Principal:
    return Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="chat-parity"
    )


def call_tool(client: TestClient, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Invoke one registered agent tool exactly as the Agents SDK would."""
    return call_tool_as(client, human(), name, arguments)


def call_tool_as(
    client: TestClient,
    principal: Principal,
    name: str,
    arguments: dict[str, Any],
    *,
    bearer: str | None = None,
) -> dict[str, Any]:
    chat = client.app.state.services.chat
    thread_id = (
        create_thread(client, Authorization=f"Bearer {bearer}") if bearer else create_thread(client)
    )
    request_context = ChatRequestContext(principal=principal)
    thread = run_in_app(client, chat.store_adapter.load_thread(thread_id, request_context))
    agent_context = AgentContext(
        thread=thread, store=chat.store_adapter, request_context=request_context
    )
    tool = next(tool for tool in chat.tools if tool.name == name)
    encoded = json.dumps(arguments)
    context = AgentsToolContext(
        context=agent_context, tool_name=name, tool_call_id=f"call-{name}", tool_arguments=encoded
    )
    return json.loads(run_in_app(client, tool.on_invoke_tool(context, encoded)))


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


def test_a_conversation_started_from_a_project_tells_the_model_about_it(
    client: TestClient,
) -> None:
    chat = client.app.state.services.chat
    source = create_document(client, "ctx-source", path="ctx/source.md")
    project = client.post(
        "/api/v1/projects",
        json={"name": "Open project", "description": "Size the market", "create_brief": False},
        headers=headers("ctx-project"),
    ).json()
    client.post(
        f"/api/v1/projects/{project['project_id']}/documents",
        json={"document_id": source["document_id"], "role": "source"},
        headers=headers("ctx-member"),
    )

    context = run_in_app(
        client,
        chat.app_context(
            ChatRequestContext(principal=human(), project_id=project["project_id"]), "thread-ctx"
        ),
    )
    missing = run_in_app(
        client,
        chat.app_context(
            ChatRequestContext(principal=human(), project_id="proj_gone"), "thread-ctx"
        ),
    )

    assert f"Open project id: {project['project_id']}" in context
    assert "Project purpose: Size the market" in context
    assert "This conversation's thread id: thread-ctx" in context
    assert f"- {source['document_id']} | ctx-source | source" in context
    assert "Open project" not in missing


def test_an_agent_is_not_told_about_projects(client: TestClient) -> None:
    services = client.app.state.services
    project = client.post(
        "/api/v1/projects",
        json={"name": "Hidden from agents", "create_brief": False},
        headers=headers("ctx-hidden"),
    ).json()
    token = issue_agent_token(client, actor_id="agent:nosy", capabilities=("read",))
    agent = services.identity.authenticate(token, operation_id="ctx-agent")

    context = run_in_app(
        client,
        services.chat.app_context(
            ChatRequestContext(principal=agent, project_id=project["project_id"]), "thread-ctx"
        ),
    )

    assert "Hidden from agents" not in context


def test_chat_edits_a_project_its_members_conversations_and_annotations(
    client: TestClient,
) -> None:
    document = create_document(client, "edit-member", path="edit/member.md")
    pdf = import_pdf(client, content=text_pdf(), key="edit-pdf", path="edit/paper.pdf").json()
    annotation = client.post(
        f"/api/v1/pdfs/{pdf['document_id']}/annotations",
        json={"page_number": 1, "annotation_type": "page_note", "note": "cite me"},
        headers=headers("edit-annotation"),
    ).json()
    project = client.post(
        "/api/v1/projects",
        json={"name": "Before", "create_brief": False},
        headers=headers("edit-project"),
    ).json()
    project_id = project["project_id"]
    thread_id = create_thread(client)
    client.post(
        f"/api/v1/projects/{project_id}/documents",
        json={"document_id": document["document_id"], "role": "source"},
        headers=headers("edit-add"),
    )
    client.post(
        f"/api/v1/projects/{project_id}/documents",
        json={"document_id": pdf["document_id"], "role": "source"},
        headers=headers("edit-add-pdf"),
    )

    changes = [
        {"kind": "update_details", "project_id": project_id, "name": "After", "description": "Why"},
        {
            "kind": "update_member",
            "project_id": project_id,
            "document_id": document["document_id"],
            "role": "draft",
            "pinned_page": 2,
            "notes": "Start here",
        },
        {"kind": "add_thread", "project_id": project_id, "thread_id": thread_id},
        {
            "kind": "add_annotation",
            "project_id": project_id,
            "annotation_id": annotation["annotation_id"],
        },
    ]
    for index, change in enumerate(changes):
        done = execute_project_change(client, f"call_edit_{index}", {"change": change})
        assert done.effect.status == "completed", change

    detail = client.get(f"/api/v1/projects/{project_id}").json()
    assert (detail["name"], detail["description"]) == ("After", "Why")
    member = next(m for m in detail["documents"] if m["document_id"] == document["document_id"])
    assert (member["role"], member["pinned_page"], member["notes"]) == ("draft", 2, "Start here")
    assert [t["thread_id"] for t in detail["threads"]] == [thread_id]
    assert [a["annotation_id"] for a in detail["annotations"]] == [annotation["annotation_id"]]

    for index, change in enumerate(
        [
            {"kind": "remove_thread", "project_id": project_id, "thread_id": thread_id},
            {
                "kind": "remove_annotation",
                "project_id": project_id,
                "annotation_id": annotation["annotation_id"],
            },
        ]
    ):
        done = execute_project_change(client, f"call_undo_{index}", {"change": change})
        assert done.effect.status == "completed", change
    detail = client.get(f"/api/v1/projects/{project_id}").json()
    assert detail["threads"] == [] and detail["annotations"] == []


def test_a_stale_project_version_is_refused_when_the_change_is_requested(
    client: TestClient,
) -> None:
    project = client.post(
        "/api/v1/projects",
        json={"name": "Versioned", "create_brief": False},
        headers=headers("stale-project"),
    ).json()
    with pytest.raises(Exception, match="changed since it was read"):
        execute_project_change(
            client,
            "call_stale_project",
            {
                "change": {
                    "kind": "update_details",
                    "project_id": project["project_id"],
                    "expected_version": project["version"] + 5,
                    "name": "Never",
                }
            },
        )


def run_plan(client: TestClient, call: str, *operations: dict[str, Any]):
    set_chat_autonomy(client, "workspace")
    return prepare_effect(
        client,
        capability_id="apply_workspace_organization_plan",
        arguments=plan(*operations),
        tool_call_id=call,
    )


def test_plan_creates_a_tag_and_a_second_plan_applies_it(client: TestClient) -> None:
    document = create_document(client, "tag-target", path="t/doc.md")

    created = run_plan(client, "call_tag_create", {"kind": "create_tag", "name": "q4-review"})

    assert created.effect.status == "completed"
    [tag] = [t for t in client.get("/api/v1/tags").json() if t["name"] == "q4-review"]
    applied = run_plan(
        client,
        "call_tag_apply",
        {
            "kind": "update_document_metadata",
            "document_id": document["document_id"],
            "expected_metadata_version": document["metadata_version"],
            "expected_category": None,
            "expected_tag_ids": [],
            "category": None,
            "tag_ids": [tag["tag_id"]],
        },
    )
    assert applied.effect.status == "completed"
    current = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert [t["name"] for t in current["tags"]] == ["q4-review"]


def test_a_plan_cannot_use_a_tag_it_creates_or_duplicate_an_existing_one(
    client: TestClient,
) -> None:
    from sangam.errors import ConflictError, ValidationError

    document = create_document(client, "tag-same-plan", path="t/same.md")
    services = client.app.state.services
    run_plan(client, "call_tag_first", {"kind": "create_tag", "name": "exists"})

    with pytest.raises(ValidationError, match="tags do not exist"):
        run_plan(
            client,
            "call_tag_same_plan",
            {"kind": "create_tag", "name": "fresh"},
            {
                "kind": "update_document_metadata",
                "document_id": document["document_id"],
                "expected_metadata_version": document["metadata_version"],
                "expected_category": None,
                "expected_tag_ids": [],
                "category": None,
                "tag_ids": ["guessed-id"],
            },
        )
    with pytest.raises(ConflictError, match="already exists"):
        run_plan(client, "call_tag_again", {"kind": "create_tag", "name": "Exists"})
    assert {t.name for t in services.organization.list_tags()} == {"exists"}


def test_only_an_administrator_can_plan_a_new_tag(client: TestClient) -> None:
    from sangam.schemas import ApplyOrganizationPlan

    token = issue_agent_token(client, actor_id="agent:tagger", capabilities=("read", "tag"))
    services = client.app.state.services
    agent = services.identity.authenticate(token, operation_id="tag-denied")

    with pytest.raises(AuthorizationError):
        services.workspace_access.preflight_organization_plan(
            agent,
            plan=ApplyOrganizationPlan.model_validate(
                plan({"kind": "create_tag", "name": "sneaky"})
            ),
        )


def publish(client: TestClient, document: dict[str, Any], slug: str) -> dict[str, Any]:
    response = client.post(
        "/api/v1/publications",
        json={"document_id": document["document_id"], "slug": slug, "access_policy": "public"},
        headers=headers(f"publish-{slug}"),
    )
    assert response.status_code == 201, response.text
    return response.json()


def change_publication(client: TestClient, call: str, change: dict[str, Any]):
    set_chat_autonomy(client, "workspace")
    return prepare_effect(
        client, capability_id="update_publication", arguments={"change": change}, tool_call_id=call
    )


def test_read_document_reports_its_publication_to_someone_who_may_publish(
    client: TestClient,
) -> None:
    document = create_document(client, "pub-read", path="pub/read.md")
    publication = publish(client, document, "pub-read")
    reader = issue_agent_token(client, actor_id="agent:reader", capabilities=("read",))
    publisher = issue_agent_token(
        client, actor_id="agent:publisher", capabilities=("read", "publish")
    )
    services = client.app.state.services

    as_human = call_tool(client, "read_document", {"document_id": document["document_id"]})
    assert as_human["publication"]["publication_id"] == publication["publication_id"]
    assert as_human["publication"]["version"] == publication["version"]
    assert as_human["publication"]["access_policy"] == "public"

    def read_as(token: str) -> dict[str, Any]:
        principal = services.identity.authenticate(token, operation_id="pub-read-as")
        return call_tool_as(
            client,
            principal,
            "read_document",
            {"document_id": document["document_id"]},
            bearer=token,
        )

    assert read_as(reader)["publication"] is None
    assert read_as(publisher)["publication"]["slug"] == "pub-read"


def test_chat_unpublishes_and_changes_how_a_publication_is_shared(client: TestClient) -> None:
    document = create_document(client, "pub-change", path="pub/change.md")
    publication = publish(client, document, "pub-change")

    updated = change_publication(
        client,
        "call_pub_update",
        {
            "kind": "update",
            "publication_id": publication["publication_id"],
            "expected_version": publication["version"],
            "slug": "pub-renamed",
            "access_policy": "private",
        },
    )
    assert updated.effect.status == "completed"
    now = client.get(f"/api/v1/publications/by-document/{document['document_id']}").json()
    assert (now["slug"], now["access_policy"]) == ("pub-renamed", "private")

    withdrawn = change_publication(
        client,
        "call_pub_withdraw",
        {
            "kind": "unpublish",
            "publication_id": publication["publication_id"],
            "expected_version": now["version"],
        },
    )
    assert withdrawn.effect.status == "completed"
    after = client.get(f"/api/v1/publications/by-document/{document['document_id']}").json()
    assert after["active"] is False


def test_a_stale_publication_version_or_missing_authority_is_refused_up_front(
    client: TestClient,
) -> None:
    from sangam.errors import ConflictError

    document = create_document(client, "pub-refuse", path="pub/refuse.md")
    publication = publish(client, document, "pub-refuse")

    with pytest.raises(ConflictError, match="changed since it was read"):
        change_publication(
            client,
            "call_pub_stale",
            {
                "kind": "unpublish",
                "publication_id": publication["publication_id"],
                "expected_version": publication["version"] + 3,
            },
        )

    token = issue_agent_token(client, actor_id="agent:no-publish", capabilities=("read",))
    services = client.app.state.services
    agent = services.identity.authenticate(token, operation_id="pub-no-authority")
    with pytest.raises(AuthorizationError):
        services.workspace_access.preflight_update_publication(
            agent,
            publication_id=publication["publication_id"],
            expected_version=publication["version"],
        )


def annotate(client: TestClient, call: str, change: dict[str, Any]):
    set_chat_autonomy(client, "workspace")
    return prepare_effect(
        client, capability_id="annotate_pdf", arguments={"change": change}, tool_call_id=call
    )


def test_chat_adds_edits_and_deletes_a_pdf_note(client: TestClient) -> None:
    pdf = import_pdf(client, content=text_pdf(), key="annotate-pdf", path="a/paper.pdf").json()
    page = call_tool(client, "read_pdf_page", {"document_id": pdf["document_id"], "page_number": 1})
    assert page["annotations"] == []

    created = annotate(
        client,
        "call_note_create",
        {
            "kind": "create",
            "document_id": pdf["document_id"],
            "page_number": 1,
            "annotation_type": "page_note",
            "note": "Check the method",
            "tags": ["method"],
        },
    )
    assert created.effect.status == "completed"
    [annotation] = client.get(f"/api/v1/pdfs/{pdf['document_id']}/annotations").json()
    assert (annotation["note"], annotation["tags"]) == ("Check the method", ["method"])
    seen = call_tool(
        client, "read_pdf_page", {"document_id": pdf["document_id"], "page_number": 1}
    )["annotations"]
    assert [(a["annotation_id"], a["version"]) for a in seen] == [
        (annotation["annotation_id"], annotation["version"])
    ]

    edited = annotate(
        client,
        "call_note_edit",
        {
            "kind": "update",
            "annotation_id": annotation["annotation_id"],
            "expected_version": annotation["version"],
            "note": "Check the method and the sample size",
        },
    )
    assert edited.effect.status == "completed"
    [current] = client.get(f"/api/v1/pdfs/{pdf['document_id']}/annotations").json()
    assert current["note"] == "Check the method and the sample size"
    assert current["tags"] == ["method"]

    deleted = annotate(
        client,
        "call_note_delete",
        {
            "kind": "delete",
            "annotation_id": annotation["annotation_id"],
            "expected_version": current["version"],
        },
    )
    assert deleted.effect.status == "completed"
    assert client.get(f"/api/v1/pdfs/{pdf['document_id']}/annotations").json() == []


def test_pdf_annotation_requests_that_cannot_run_are_refused_up_front(client: TestClient) -> None:
    from sangam.errors import ConflictError, ValidationError

    pdf = import_pdf(client, content=text_pdf(), key="annotate-refuse", path="a/refuse.pdf").json()
    text = create_document(client, "annotate-text", path="a/text.md")
    created = annotate(
        client,
        "call_refuse_create",
        {
            "kind": "create",
            "document_id": pdf["document_id"],
            "page_number": 1,
            "annotation_type": "comment",
            "note": "ok",
        },
    )
    assert created.effect.status == "completed"
    [annotation] = client.get(f"/api/v1/pdfs/{pdf['document_id']}/annotations").json()

    with pytest.raises(ValidationError, match="require text"):
        annotate(
            client,
            "call_empty_note",
            {
                "kind": "create",
                "document_id": pdf["document_id"],
                "page_number": 1,
                "annotation_type": "comment",
                "note": "  ",
            },
        )
    with pytest.raises(ValidationError, match="PDF"):
        annotate(
            client,
            "call_not_pdf",
            {
                "kind": "create",
                "document_id": text["document_id"],
                "page_number": 1,
                "annotation_type": "bookmark",
            },
        )
    with pytest.raises(ConflictError, match="changed since it was read"):
        annotate(
            client,
            "call_stale_note",
            {
                "kind": "update",
                "annotation_id": annotation["annotation_id"],
                "expected_version": annotation["version"] + 4,
                "note": "late",
            },
        )


def test_a_path_scoped_agent_can_create_inside_its_prefix_through_chat(client: TestClient) -> None:
    services = client.app.state.services
    chat = services.chat
    token = issue_agent_token(
        client, actor_id="agent:scoped", capabilities=("read", "create"), path_prefix="agent"
    )
    agent = services.identity.authenticate(token, operation_id="scoped-create")

    offered = {
        c.capability_id
        for c in chat.capabilities.resolve(
            principal=agent,
            policy=services.authorization,
            entry_point="workspace",
            document=None,
            model_supports_tools=True,
        )
    }
    told = run_in_app(
        client, chat.app_context(ChatRequestContext(principal=agent), "thread-scoped")
    )

    assert "create_document" in offered
    assert "Your create access is limited to paths under: agent" in told

    run = prepare_run(client, capability_id="create_document", tool_call_id="call_scoped")
    capability = run.capability

    def request(path: str | None, call: str):
        arguments = {"title": "Scoped", "content": "# Scoped", "content_type": "text/markdown"}
        if path:
            arguments["path"] = path
        return chat.effects.propose(
            agent,
            run_id=run.run_id,
            thread_id=run.thread_id,
            tool_call_id=call,
            capability=capability,
            arguments=arguments,
            preview=CreateDocumentInput.model_validate(arguments).model_dump(mode="json"),
        )

    assert request("agent/inside.md", "call_inside").status == "pending_approval"
    with pytest.raises(AuthorizationError):
        request("other/outside.md", "call_outside")
    with pytest.raises(AuthorizationError):
        request(None, "call_draft")
