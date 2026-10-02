"""Who may approve a chat effect, whose authority it runs with, and what the ledger names."""

from __future__ import annotations

import pytest
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient
from test_chat_capability_lifecycle import prepare_effect, prepare_run, set_chat_autonomy

from sangam.chat_capabilities import CreateDocumentInput
from sangam.errors import AuthenticationError, AuthorizationError
from sangam.security import Principal

ARGUMENTS = {"title": "Agent note", "content": "# Agent note", "content_type": "text/markdown"}


def agent_effect(client: TestClient, *, path: str, scopes: tuple[str, ...] = ("read", "create")):
    """An effect requested by a path-scoped agent token, waiting for human review."""
    token = issue_agent_token(
        client, actor_id="agent:scribe", capabilities=scopes, path_prefix="agent"
    )
    services = client.app.state.services
    agent = services.identity.authenticate(token, operation_id="agent-request")
    run = prepare_run(client, capability_id="create_document", tool_call_id=f"call_{path}")
    arguments = {**ARGUMENTS, "path": path}
    effect = run.chat.effects.propose(
        agent,
        run_id=run.run_id,
        thread_id=run.thread_id,
        tool_call_id=f"call_{path}",
        capability=run.capability,
        arguments=arguments,
        preview=CreateDocumentInput.model_validate(arguments).model_dump(mode="json"),
    )
    assert effect.status == "pending_approval"
    return run, agent, effect, token


def human_decision(run, effect, *, verdict: str = "approve"):
    return run.chat.effects.decide(
        run.principal,
        effect_id=effect.effect_id,
        verdict=verdict,
        argument_digest=effect.argument_digest,
        reason=None,
    )


def test_an_agent_cannot_approve_its_own_effect(client: TestClient) -> None:
    run, agent, effect, _ = agent_effect(client, path="agent/self.md")

    with pytest.raises(AuthorizationError):
        run.chat.effects.decide(
            agent,
            effect_id=effect.effect_id,
            verdict="approve",
            argument_digest=effect.argument_digest,
            reason=None,
        )
    assert client.get("/api/v1/documents").json() == []


def test_a_human_approval_runs_with_the_requesters_authority_and_names_both(
    client: TestClient,
) -> None:
    run, _, effect, _ = agent_effect(client, path="agent/note.md")

    executed = human_decision(run, effect)

    assert executed.effect.status == "completed"
    [document] = client.get("/api/v1/documents").json()
    created = [
        event
        for event in client.get(
            "/api/v1/activity",
            params={"actor_kind": "agent", "resource_id": document["document_id"]},
        ).json()
        if event["action"] == "create"
    ]
    assert len(created) == 1
    assert created[0]["actor_id"] == "agent:scribe"
    assert created[0]["details"]["via"] == f"chat-effect:{effect.effect_id}"
    assert created[0]["details"]["approved_by"] == "human:jay"


def test_approval_cannot_exceed_what_the_requester_may_do_now(client: TestClient) -> None:
    run, agent, effect, _ = agent_effect(client, path="agent/narrowed.md")
    token_id = agent.token_id
    narrowed = client.patch(
        f"/api/v1/agent-tokens/{token_id}",
        json={
            "expected_version": 1,
            "label": "narrowed",
            "scopes": [{"capability": "read", "path_prefix": "agent"}],
            "expires_at": None,
        },
    )
    assert narrowed.status_code == 200, narrowed.text

    with pytest.raises(AuthorizationError):
        human_decision(run, effect)

    assert client.get("/api/v1/documents").json() == []


def test_a_token_revoked_before_approval_cannot_have_its_effect_run(client: TestClient) -> None:
    run, agent, effect, _ = agent_effect(client, path="agent/revoked.md")
    assert client.delete(f"/api/v1/agent-tokens/{agent.token_id}").status_code == 200

    with pytest.raises(AuthenticationError):
        human_decision(run, effect)

    assert client.get("/api/v1/documents").json() == []


def test_a_human_effect_names_the_chat_effect_in_the_ledger(client: TestClient) -> None:
    set_chat_autonomy(client, "workspace")
    created = prepare_effect(
        client,
        capability_id="create_document",
        arguments={**ARGUMENTS, "title": "Via chat", "path": "via-chat.md"},
        tool_call_id="call_via_chat",
    )
    [document] = client.get("/api/v1/documents").json()
    events = client.get(
        "/api/v1/activity",
        params={"actor_kind": "human", "resource_id": document["document_id"]},
    ).json()

    [event] = [e for e in events if e["action"] == "create"]
    assert event["details"]["via"] == f"chat-effect:{created.effect.effect_id}"
    assert event["details"]["approved_by"] == "policy:yolo"


def test_applying_a_proposal_names_the_proposal_in_the_ledger(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={"title": "Edited by chat", "content": "before", "path": "p/edit.md"},
        headers=headers("authority-proposal-doc"),
    ).json()
    from test_phase_seven_chat import create_thread

    thread_id = create_thread(client, document_id=document["document_id"])
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="proposal-origin"
    )
    proposals = client.app.state.services.chat.proposals
    proposal = proposals.create(
        principal,
        thread_id=thread_id,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="after",
        summary="Reword",
    )
    proposals.apply(
        principal,
        proposal_id=proposal.proposal_id,
        expected_revision_id=proposal.expected_revision_id,
        idempotency_key="origin-apply",
    )

    events = client.get(
        "/api/v1/activity",
        params={"actor_kind": "human", "resource_id": document["document_id"]},
    ).json()
    [update] = [e for e in events if e["action"] == "update"]
    assert update["details"]["via"] == f"chat-proposal:{proposal.proposal_id}"
