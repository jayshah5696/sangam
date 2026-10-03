import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from agents.tool_context import ToolContext
from chatkit.agents import AgentContext
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient
from test_phase_five_pdf_research import import_pdf, text_pdf
from test_phase_seven_chat import create_test_run, create_thread

from sangam.chat_context import ChatRequestContext
from sangam.errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    IdempotencyError,
    NotFoundError,
    ValidationError,
)
from sangam.security import Principal


@pytest.fixture
def editorial(client: TestClient):
    principal = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="editorial-review"
    )
    document = client.post(
        "/api/v1/documents",
        json={"title": "Editorial draft", "content": "original", "path": "draft.md"},
        headers=headers("editorial-draft"),
    ).json()
    thread = create_thread(client, document_id=document["document_id"])
    service = client.app.state.services.chat.proposals
    proposal = service.create(
        principal,
        thread_id=thread,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="agent wording",
        summary="Editorial change",
    )
    return principal, document, thread, service, proposal


def apply_edit(editorial, wording="reviewer wording", key="editorial-apply"):
    principal, _, _, service, proposal = editorial
    return service.apply(
        principal,
        proposal_id=proposal.proposal_id,
        expected_revision_id=proposal.expected_revision_id,
        idempotency_key=key,
        content=wording,
    )


def test_distinct_concurrent_edits_cannot_change_reserved_wording(
    client: TestClient, editorial, monkeypatch: pytest.MonkeyPatch
):
    principal, document, _, service, proposal = editorial
    entered, release = Event(), Event()
    update = service.workspace.write_document

    def paused(*args, **kwargs):
        assert kwargs["body"].content == "review A", "A second reviewer reached the write boundary"
        entered.set()
        assert release.wait(5)
        return update(*args, **kwargs)

    monkeypatch.setattr(service.workspace, "write_document", paused)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(apply_edit, editorial, "review A", "key-A")
        assert entered.wait(5)
        try:
            with pytest.raises(ConflictError):
                apply_edit(editorial, "review B", "key-B")
        finally:
            release.set()
        applied = first.result()
    stored = service.repository.get_owned(principal, proposal.proposal_id)
    assert stored.content == "agent wording"
    assert stored.applied_content == "review A"
    assert applied.applied_revision_id == stored.applied_revision_id
    persisted = client.get(f"/api/v1/documents/{document['document_id']}").json()
    assert persisted["content"] == stored.applied_content
    assert len(client.get(f"/api/v1/documents/{document['document_id']}/history").json()) == 2


@pytest.mark.parametrize("failure", [ValidationError, AuthorizationError, ConflictError])
def test_prevalidation_failure_releases_reservation(editorial, monkeypatch, failure):
    principal, _, _, service, proposal = editorial

    def reject(*args, **kwargs):
        raise failure("rejected before commit")

    with monkeypatch.context() as patch:
        patch.setattr(service.workspace, "validate_proposed_update", reject)
        with pytest.raises(failure):
            apply_edit(editorial)
    with service.repository.database.connection() as connection:
        row = connection.execute(
            "SELECT apply_idempotency_key FROM chat_proposals WHERE proposal_id = ?",
            (proposal.proposal_id,),
        ).fetchone()
    assert row["apply_idempotency_key"] is None
    assert service.repository.get_owned(principal, proposal.proposal_id).content == "agent wording"
    assert service.dismiss(principal, proposal.proposal_id, "Try again").status == "dismissed"


def test_committed_interruption_recovers_only_the_exact_payload(
    client: TestClient, editorial, monkeypatch
):
    principal, document, _, service, proposal = editorial

    def interrupt(*args, **kwargs):
        raise RuntimeError("after document commit")

    with monkeypatch.context() as patch:
        patch.setattr(service.repository, "mark_applied", interrupt)
        with pytest.raises(RuntimeError, match="after document commit"):
            apply_edit(editorial, "review A")
    with pytest.raises(ConflictError):
        apply_edit(editorial, "review B")
    recovered = apply_edit(editorial, "review A", "new-retry-key")
    replay = apply_edit(editorial, "review A", "another-key")
    assert replay.applied_revision_id == recovered.applied_revision_id
    assert recovered.content == "agent wording"
    assert recovered.applied_content == "review A"
    assert (
        service.repository.get_owned(principal, proposal.proposal_id).applied_content == "review A"
    )
    assert len(client.get(f"/api/v1/documents/{document['document_id']}/history").json()) == 2


@pytest.mark.parametrize("line_ending", ["\n", "\r\n", "\r"])
def test_citations_pin_revision_validate_quote_and_do_not_lie_about_location(
    client, editorial, line_ending
):
    principal, document, thread, service, _ = editorial
    source = client.post(
        "/api/v1/documents",
        json={
            "title": "Evidence",
            "content": line_ending.join(["First line", "Exact supporting passage.", "Last line"]),
        },
        headers=headers("editorial-evidence"),
    ).json()
    arguments = dict(
        thread_id=thread,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="cited proposal",
        summary="Cited change",
    )
    cited = service.create(
        principal,
        **arguments,
        citations=[{"document_id": source["document_id"], "snippet": "Exact supporting passage."}],
    )
    assert cited.citations[0].revision_id == source["current_revision_id"]
    assert cited.citations[0].location == "Lines 2–2"
    for invalid in [
        {"revision_id": document["current_revision_id"]},
        {"snippet": "Invented quote"},
        {"page_number": 1},
        {"annotation_id": "foreign-annotation"},
    ]:
        with pytest.raises((ValidationError, NotFoundError)):
            service.create(
                principal,
                **arguments,
                citations=[
                    {
                        "document_id": source["document_id"],
                        "snippet": "Exact supporting passage.",
                        **invalid,
                    }
                ],
            )


def test_late_reads_and_identical_wording_in_other_run_keep_their_own_evidence(client, editorial):
    principal, document, thread, service, _ = editorial
    evidence = client.app.state.services.chat.evidence
    first_run = create_test_run(
        client, principal, thread_id=thread, document_id=document["document_id"]
    )
    arguments = dict(
        thread_id=thread,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="same wording",
        summary="Run-specific change",
    )
    first = service.create(principal, **arguments, run_id=first_run, rationale="Repeated rationale")
    evidence.record_run_source(
        first_run,
        document_id=document["document_id"],
        revision_id=document["current_revision_id"],
        title=document["title"],
        path=document["path"],
    )
    evidence.complete_run(first_run, status="completed")
    second_run = create_test_run(
        client, principal, thread_id=thread, document_id=document["document_id"]
    )
    second = service.create(
        principal, **arguments, run_id=second_run, rationale="Repeated rationale"
    )
    assert first.proposal_id != second.proposal_id
    listed = {p.proposal_id: p for p in service.list(principal, thread_id=thread, document_id=None)}
    assert listed[first.proposal_id].sources_retrieved[0].document_id == document["document_id"]
    assert listed[second.proposal_id].sources_retrieved == []
    assert listed[second.proposal_id].rationale == "Repeated rationale"


def test_source_bound_signals_omissions(client, editorial):
    principal, document, thread, service, _ = editorial
    evidence = client.app.state.services.chat.evidence
    run = create_test_run(client, principal, thread_id=thread, document_id=document["document_id"])
    sources = [
        client.post(
            "/api/v1/documents",
            json={"title": f"Bounded source {number}", "content": f"Source body {number}"},
            headers=headers(f"bounded-source-{number}"),
        ).json()
        for number in range(51)
    ]
    for source in sources[:50] + sources[:1]:
        evidence.record_run_source(
            run,
            document_id=source["document_id"],
            revision_id=source["current_revision_id"],
            title=source["title"],
            path=source["path"],
        )
    proposal = service.create(
        principal,
        thread_id=thread,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="bounded",
        summary="Bounds",
        run_id=run,
    )
    assert len(proposal.sources_retrieved) == 50
    assert proposal.sources_retrieved_truncated is False
    omitted = sources[-1]
    evidence.record_run_source(
        run,
        document_id=omitted["document_id"],
        revision_id=omitted["current_revision_id"],
        title=omitted["title"],
        path=omitted["path"],
    )
    listed = next(
        p
        for p in service.list(principal, thread_id=thread, document_id=None)
        if p.proposal_id == proposal.proposal_id
    )
    assert len(listed.sources_retrieved) == 50
    assert listed.sources_retrieved_truncated is True


def test_revoked_inflight_principal_cannot_apply_and_reservation_remains_dismissible(
    client, editorial
):
    _, document, _, service, _ = editorial
    token = issue_agent_token(client, capabilities=("read", "update"))
    identity = client.app.state.services.identity
    principal = identity.authenticate(token, operation_id="authenticated-before-revocation")
    thread = create_thread(client, Authorization=f"Bearer {token}")
    proposal = service.create(
        principal,
        thread_id=thread,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="agent proposal",
        summary="Revoked",
    )
    original = service.repository.reserve_apply

    # Revoke after the request authenticated and after reservation, before the write.
    def reserve_then_revoke(*args, **kwargs):
        reserved = original(*args, **kwargs)
        identity.revoke_token(principal.token_id)
        return reserved

    service.repository.reserve_apply = reserve_then_revoke
    with pytest.raises(AuthenticationError):
        service.apply(
            principal,
            proposal_id=proposal.proposal_id,
            expected_revision_id=proposal.expected_revision_id,
            content="reviewer change",
            idempotency_key="revoked-in-flight",
        )
    owner = Principal.trusted_human(
        actor_id="human:jay", display_name="Jay", operation_id="dismiss-revoked"
    )
    assert service.dismiss(owner, proposal.proposal_id, "Revoked review").status == "dismissed"
    assert (
        client.get(f"/api/v1/documents/{document['document_id']}").json()["content"] == "original"
    )


def test_existing_principal_cannot_reveal_evidence_after_scope_withdrawal(client, editorial):
    _, document, _, service, _ = editorial
    token = issue_agent_token(client, capabilities=("read", "update"))
    identity = client.app.state.services.identity
    principal = identity.authenticate(token, operation_id="before-scope-withdrawal")
    thread = create_thread(client, Authorization=f"Bearer {token}")
    proposal = service.create(
        principal,
        thread_id=thread,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="evidence-backed",
        summary="Scoped",
        citations=[{"document_id": document["document_id"], "snippet": "original"}],
    )
    updated = client.patch(
        f"/api/v1/agent-tokens/{principal.token_id}",
        json={
            "expected_version": 1,
            "label": "Scope withdrawn",
            "scopes": [
                {"capability": "read", "path_prefix": "unrelated/"},
                {"capability": "update", "path_prefix": "unrelated/"},
            ],
        },
    )
    assert updated.status_code == 200, updated.text
    visible = next(
        p
        for p in service.list(principal, thread_id=thread, document_id=None)
        if p.proposal_id == proposal.proposal_id
    )
    assert visible.citations[0].snippet == ""
    assert visible.citations[0].title is None
    assert visible.citations[0].available is False


def test_actual_byte_limit_failure_allows_retry_then_replay(client, editorial):
    _, document, _, service, proposal = editorial
    limit = service.workspace.documents.max_document_bytes
    response = client.post(
        f"/api/v1/chat/proposals/{proposal.proposal_id}/apply",
        json={
            "expected_revision_id": proposal.expected_revision_id,
            "content": "é" * (limit // 2 + 1),
        },
        headers=headers("review-over-byte-limit"),
    )
    assert response.status_code == 422, response.text
    applied = apply_edit(editorial)
    assert applied.applied_content == "reviewer wording"
    assert (
        client.get(f"/api/v1/documents/{document['document_id']}").json()["content"]
        == "reviewer wording"
    )
    assert (
        apply_edit(editorial, key="retry-new-key").applied_revision_id
        == applied.applied_revision_id
    )


def test_recovery_after_newer_human_revision_keeps_original_committed_revision(
    client, editorial, monkeypatch
):
    _, document, _, service, proposal = editorial

    def interruption(*args, **kwargs):
        raise RuntimeError("interrupted completion")

    with monkeypatch.context() as patch:
        patch.setattr(service.repository, "mark_applied", interruption)
        with pytest.raises(RuntimeError):
            apply_edit(editorial)
    committed = client.get(f"/api/v1/documents/{document['document_id']}").json()
    changed = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={
            "expected_revision_id": committed["current_revision_id"],
            "content": "newer human wording",
        },
        headers=headers("after-interrupted-editorial"),
    )
    assert changed.status_code == 200
    recovered = apply_edit(editorial)
    assert recovered.applied_revision_id == committed["current_revision_id"]
    assert recovered.applied_content == "reviewer wording"
    assert (
        client.get(f"/api/v1/documents/{document['document_id']}").json()["content"]
        == "newer human wording"
    )


def test_another_actor_cannot_spend_an_interrupted_review_reservation(editorial, monkeypatch):
    principal, _, _, service, proposal = editorial

    def interruption(*args, **kwargs):
        raise RuntimeError("interrupted completion")

    with monkeypatch.context() as patch:
        patch.setattr(service.repository, "mark_applied", interruption)
        with pytest.raises(RuntimeError):
            apply_edit(editorial)
    another = Principal.trusted_human(
        actor_id="human:another", display_name="Another reviewer", operation_id="other-reviewer"
    )
    with pytest.raises((ConflictError, ValidationError, NotFoundError)):
        service.apply(
            another,
            proposal_id=proposal.proposal_id,
            expected_revision_id=proposal.expected_revision_id,
            idempotency_key="other-reviewer-key",
            content="reviewer wording",
        )
    assert service.repository.get_owned(principal, proposal.proposal_id).status == "pending"
    assert apply_edit(editorial).status == "applied"


def test_revoked_retry_after_commit_preserves_recovery_for_a_reissued_token(
    client, editorial, monkeypatch
):
    _, document, _, service, _ = editorial
    token = issue_agent_token(client, capabilities=("read", "update"))
    identity = client.app.state.services.identity
    principal = identity.authenticate(token, operation_id="interrupted-agent-review")
    thread = create_thread(client, Authorization=f"Bearer {token}")
    proposal = service.create(
        principal,
        thread_id=thread,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="committed agent wording",
        summary="Recover revoked",
    )

    def attempt(actor):
        return service.apply(
            actor,
            proposal_id=proposal.proposal_id,
            expected_revision_id=proposal.expected_revision_id,
            idempotency_key="revoked-recovery",
        )

    def interruption(*args, **kwargs):
        raise RuntimeError("after commit")

    with monkeypatch.context() as patch:
        patch.setattr(service.repository, "mark_applied", interruption)
        with pytest.raises(RuntimeError):
            attempt(principal)
    committed = client.get(f"/api/v1/documents/{document['document_id']}").json()
    identity.revoke_token(principal.token_id)
    with pytest.raises(AuthenticationError):
        attempt(principal)
    replacement = issue_agent_token(client, capabilities=("read", "update"))
    reauthorized = identity.authenticate(replacement, operation_id="reauthorized-agent-review")
    recovered = attempt(reauthorized)
    assert recovered.status == "applied"
    assert recovered.applied_revision_id == committed["current_revision_id"]
    assert len(client.get(f"/api/v1/documents/{document['document_id']}/history").json()) == 2


def test_pdf_citations_use_owned_pages_annotations_and_recheck_deleted_locators(client, editorial):
    principal, document, thread, service, _ = editorial
    first = import_pdf(
        client,
        content=text_pdf("Exact PDF evidence"),
        key="editorial-pdf",
        path="editorial/source.pdf",
    ).json()
    foreign = import_pdf(
        client,
        content=text_pdf("Exact PDF evidence"),
        key="editorial-foreign-pdf",
        path="editorial/foreign.pdf",
    ).json()
    annotations = []
    for index, source in enumerate([first, foreign]):
        response = client.post(
            f"/api/v1/pdfs/{source['document_id']}/annotations",
            json={
                "page_number": 1,
                "annotation_type": "text_highlight",
                "selected_text": "Exact PDF evidence",
                "note": "Source quote",
                "geometry": [{"x": 0.1, "y": 0.1, "width": 0.3, "height": 0.04}],
                "tags": [],
                "color": "#F0C75E",
            },
            headers=headers(f"editorial-annotation-{index}"),
        )
        assert response.status_code == 201
        annotations.append(response.json())
    arguments = dict(
        thread_id=thread,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="PDF-backed wording",
        summary="PDF support",
    )
    citation = {
        "document_id": first["document_id"],
        "page_number": 1,
        "annotation_id": annotations[0]["annotation_id"],
        "snippet": "Exact PDF evidence",
    }
    proposal = service.create(principal, **arguments, citations=[citation])
    assert proposal.citations[0].revision_id == first["current_revision_id"]
    assert proposal.citations[0].location == "Page 1"
    for invalid in [
        {"page_number": 2},
        {"annotation_id": annotations[1]["annotation_id"]},
        {"revision_id": foreign["current_revision_id"]},
        {"snippet": "Fabricated evidence"},
    ]:
        with pytest.raises((NotFoundError, ValidationError)):
            service.create(principal, **arguments, citations=[{**citation, **invalid}])
    removed = client.delete(
        f"/api/v1/annotations/{annotations[0]['annotation_id']}",
        params={"expected_version": 1},
        headers=headers("editorial-annotation-delete"),
    )
    assert removed.status_code == 200
    listed = next(
        p
        for p in service.list(principal, thread_id=thread, document_id=None)
        if p.proposal_id == proposal.proposal_id
    )
    assert listed.citations[0].available is False
    assert listed.citations[0].snippet == ""


def test_idempotency_collision_before_commit_does_not_reserve_forever(client, editorial):
    _, _, _, service, proposal = editorial
    other = client.post(
        "/api/v1/documents",
        json={"title": "Other draft", "content": "other"},
        headers=headers("other-editorial-draft"),
    ).json()
    changed = client.patch(
        f"/api/v1/documents/{other['document_id']}",
        json={
            "expected_revision_id": other["current_revision_id"],
            "content": "another update",
        },
        headers=headers("colliding-review-key"),
    )
    assert changed.status_code == 200
    with pytest.raises(IdempotencyError):
        apply_edit(editorial, key="colliding-review-key")
    assert service.repository.get_owned(editorial[0], proposal.proposal_id).status == "pending"
    assert apply_edit(editorial, key="fresh-review-key").status == "applied"


def test_a_revoked_run_cannot_retrieve_or_record_new_source_content(client, editorial):
    _, document, _, _, _ = editorial
    token = issue_agent_token(client, capabilities=("read",))
    chat = client.app.state.services.chat
    principal = client.app.state.services.identity.authenticate(
        token, operation_id="revoked-retrieval"
    )
    thread_id = create_thread(client, Authorization=f"Bearer {token}")
    run_id = create_test_run(
        client, principal, thread_id=thread_id, document_id=document["document_id"]
    )
    context = ChatRequestContext(principal=principal, run_id=run_id)
    thread = asyncio.run(chat.store_adapter.load_thread(thread_id, context))
    agent = AgentContext(thread=thread, store=chat.store_adapter, request_context=context)
    tool = next(tool for tool in chat.tools if tool.name == "read_document")
    arguments = json.dumps({"document_id": document["document_id"]})
    tool_context = ToolContext(
        context=agent, tool_name=tool.name, tool_call_id="revoked-read", tool_arguments=arguments
    )
    client.app.state.services.identity.revoke_token(principal.token_id)
    payload = json.loads(asyncio.run(tool.on_invoke_tool(tool_context, arguments)))
    assert payload["error"]["code"] == "authentication_required"
    assert "original" not in json.dumps(payload)
    assert chat.evidence.list_run_sources(run_id) == []


def test_same_wording_from_a_different_mutation_is_not_an_apply_recovery(client, editorial):
    principal, document, _, service, proposal = editorial
    manual = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={
            "expected_revision_id": document["current_revision_id"],
            "content": "reviewer wording",
            "summary": "Manual edit with different provenance",
        },
        headers=headers("manual-review-key"),
    )
    assert manual.status_code == 200
    with pytest.raises(ConflictError):
        apply_edit(editorial, key="manual-review-key")
    assert service.repository.get_owned(principal, proposal.proposal_id).status == "stale"
    assert (
        service.dismiss(principal, proposal.proposal_id, "Manual edit already won").status
        == "dismissed"
    )


def test_bounded_unicode_editorial_metadata_remains_valid_for_apply(editorial):
    principal, document, thread, service, _ = editorial
    proposal = service.create(
        principal,
        thread_id=thread,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="Unicode metadata proposal",
        summary="説明" * 200,
        rationale="判断" * 400,
    )
    applied = service.apply(
        principal,
        proposal_id=proposal.proposal_id,
        expected_revision_id=proposal.expected_revision_id,
        idempotency_key="unicode-review-metadata",
    )
    assert applied.status == "applied"
    assert len(applied.summary.encode("utf-8")) <= 500
    assert "[truncated]" in applied.summary


def test_repeated_passages_require_an_exact_locator_instead_of_guessing(client, editorial):
    principal, document, thread, service, _ = editorial
    prefix = "📚\nRepeated quote.\nContext for the claim.\n"
    source = client.post(
        "/api/v1/documents",
        json={"title": "Repeated passages", "content": prefix + "Repeated quote."},
        headers=headers("repeated-editorial-source"),
    ).json()
    arguments = dict(
        thread_id=thread,
        document_id=document["document_id"],
        expected_revision_id=document["current_revision_id"],
        content="Disambiguated",
        summary="Exact location",
    )
    citation = {"document_id": source["document_id"], "snippet": "Repeated quote."}
    with pytest.raises(ValidationError, match="unique|ambiguous"):
        service.create(principal, **arguments, citations=[citation])
    browser_offset = len(prefix) + 1  # The leading emoji uses two UTF-16 units.
    proposal = service.create(
        principal, **arguments, citations=[{**citation, "quote_start": browser_offset}]
    )
    assert proposal.citations[0].location == "Lines 4–4"
    assert proposal.citations[0].quote_start == browser_offset
    for offset in [0, 1, browser_offset + 1]:
        with pytest.raises(ValidationError):
            service.create(principal, **arguments, citations=[{**citation, "quote_start": offset}])
