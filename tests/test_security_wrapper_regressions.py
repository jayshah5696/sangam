from __future__ import annotations

import json
import multiprocessing
import threading
from contextlib import contextmanager
from pathlib import Path

import pytest
from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient

from sangam.access import writes
from sangam.api import create_app
from sangam.capabilities import Capability
from sangam.config import Settings
from sangam.security import Principal


def _cross_create_replay_process(root: str, result_pipe) -> None:
    """Bound a real HTTP deadlock reproduction to a disposable child process."""
    directory = Path(root)
    settings = Settings(
        database_path=directory / "database.sqlite3",
        workspace_root=directory / "workspace",
        backup_root=directory / "backups",
        frontend_dist=directory / "missing-frontend",
        backups_enabled=False,
        openrouter_api_key=None,
    )
    with TestClient(create_app(settings)) as client:
        documents = []
        for name in ["a", "b"]:
            created = client.post(
                "/api/v1/documents",
                json={"title": name.upper(), "content": "same", "path": f"docs/{name}.md"},
                headers=headers(f"create-{name}"),
            )
            assert created.status_code == 201
            documents.append(created.json())
        policy = client.app.state.services.workspace_access.policy
        real_require = policy.require
        sources_authorized = threading.Barrier(2)

        def observed_require(principal, capability, path):
            real_require(principal, capability, path)
            if capability == Capability.READ and path in {"docs/a.md", "docs/b.md"}:
                sources_authorized.wait(timeout=5)

        # Observe the real authorization boundary after both source locks are held.
        # Authorization and all storage operations still execute their production code.
        policy.require = observed_require
        responses = []
        errors = []

        def duplicate(index):
            source = documents[index]
            destination = documents[1 - index]
            try:
                response = client.post(
                    f"/api/v1/documents/{source['document_id']}/duplicate",
                    json={
                        "expected_revision_id": source["current_revision_id"],
                        "title": destination["title"],
                        "path": destination["path"],
                    },
                    headers=headers(f"create-{'b' if index == 0 else 'a'}"),
                )
                responses.append(response.status_code)
            except Exception as error:
                errors.append(repr(error))

        workers = [
            threading.Thread(target=duplicate, args=(index,), daemon=True) for index in [0, 1]
        ]
        for worker in workers:
            worker.start()
        for worker in workers:
            worker.join(timeout=8)
        if any(worker.is_alive() for worker in workers):
            result_pipe.send({"deadlocked": True, "responses": responses, "errors": errors})
            # Parent terminates this process, including blocked API/audit workers.
            return
        with client.app.state.services.documents.database.connection() as connection:
            count = connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
            revisions = connection.execute("SELECT COUNT(*) FROM revisions").fetchone()[0]
            accepted = connection.execute(
                "SELECT COUNT(*) FROM operation_events WHERE action = 'duplicate' "
                "AND outcome = 'accepted'"
            ).fetchone()[0]
        result_pipe.send(
            {
                "deadlocked": False,
                "responses": sorted(responses),
                "errors": errors,
                "documents": count,
                "revisions": revisions,
                "accepted_duplicates": accepted,
            }
        )


def test_body_only_duplicates_cannot_replay_opposite_create_keys(tmp_path):
    context = multiprocessing.get_context("spawn")
    receiving, sending = context.Pipe(duplex=False)
    process = context.Process(target=_cross_create_replay_process, args=(str(tmp_path), sending))
    process.start()
    sending.close()
    try:
        assert receiving.poll(30), (
            "Duplicate reproduction did not report within its process deadline"
        )
        result = receiving.recv()
        assert not result["deadlocked"], f"Opposite source/create replay locks deadlocked: {result}"
        assert result["responses"] == [409, 409], result
        assert result["errors"] == [], result
        assert result["documents"] == 2 and result["revisions"] == 2
        assert result["accepted_duplicates"] == 0
        process.join(timeout=5)
        assert process.exitcode == 0
    finally:
        if process.is_alive():
            process.terminate()
        process.join(timeout=5)
        if process.is_alive():
            process.kill()
            process.join(timeout=5)
        receiving.close()
        process.close()


def test_body_only_duplicate_identity_and_legacy_replay_are_source_bound(client):
    source = client.post(
        "/api/v1/documents",
        json={"title": "Source", "content": "base", "path": "docs/source.md"},
        headers=headers("source"),
    ).json()
    other = client.post(
        "/api/v1/documents",
        json={"title": "Source", "content": "base", "path": "docs/other.md"},
        headers=headers("other"),
    ).json()
    token = issue_agent_token(client, capabilities=("read", "create", "tag"), path_prefix="docs")
    auth = {"Authorization": f"Bearer {token}"}
    body = {
        "expected_revision_id": source["current_revision_id"],
        "title": "Copy",
        "path": "docs/copy.md",
    }
    url = f"/api/v1/documents/{source['document_id']}/duplicate"
    first = client.post(url, json=body, headers={**auth, **headers("duplicate")})
    assert first.status_code == 201
    replay = client.post(url, json=body, headers={**auth, **headers("duplicate")})
    assert replay.status_code == 201 and replay.json()["document_id"] == first.json()["document_id"]
    metadata = client.patch(
        f"/api/v1/documents/{first.json()['document_id']}/metadata",
        json={"expected_metadata_version": 0, "category": "copy", "tag_ids": []},
        headers={**auth, **headers("copy-metadata")},
    )
    assert metadata.status_code == 200
    assert (
        client.post(url, json=body, headers={**auth, **headers("copy-metadata")}).status_code == 409
    )
    wrong_source = client.post(
        f"/api/v1/documents/{other['document_id']}/duplicate",
        json={**body, "expected_revision_id": other["current_revision_id"]},
        headers={**auth, **headers("duplicate")},
    )
    assert wrong_source.status_code == 409
    outside = client.post(
        url,
        json={**body, "path": "private/copy.md"},
        headers={**auth, **headers("duplicate")},
    )
    assert outside.status_code == 403

    # Older releases duplicated through a wrapper that stored the storage-shaped
    # create key and an accepted duplicate audit row. Reproduce exactly those writes.
    def legacy_duplicate(*, title: str, path: str, key: str, operation_id: str):
        services = client.app.state.services
        principal = Principal.trusted_human(
            actor_id="human:jay", display_name="Jay", operation_id=operation_id
        )
        return services.workspace_access.audited(
            principal,
            writes("duplicate", "document"),
            lambda: services.documents.duplicate_document(
                document_id=source["document_id"],
                expected_revision_id=source["current_revision_id"],
                title=title,
                path=path,
                actor_id=principal.actor_id,
                idempotency_key=key,
            ),
            resource_id=source["document_id"],
            details={
                "expected_revision_id": source["current_revision_id"],
                "source_path": source["path"],
                "destination_path": path,
                "title": title,
            },
        )

    legacy = legacy_duplicate(
        title="Legacy copy", path="docs/legacy.md", key="legacy-duplicate", operation_id="lc"
    )
    secret_title = "github_pat_abcdefghijklmnopqrstuv"
    secret_path = "docs/glpat-abcdefghijklmnop.md"
    secret_legacy = legacy_duplicate(
        title=secret_title, path=secret_path, key="legacy-secret-duplicate", operation_id="ls"
    )
    changed = client.patch(
        f"/api/v1/documents/{source['document_id']}",
        json={"expected_revision_id": source["current_revision_id"], "content": "new source"},
        headers=headers("change-source"),
    )
    assert changed.status_code == 200
    legacy_body = {**body, "title": "Legacy copy", "path": "docs/legacy.md"}
    recovered = client.post(url, json=legacy_body, headers=headers("legacy-duplicate"))
    assert recovered.status_code == 201 and recovered.json()["document_id"] == legacy.document_id
    secret_body = {**body, "title": secret_title, "path": secret_path}
    secret_recovered = client.post(
        url, json=secret_body, headers=headers("legacy-secret-duplicate")
    )
    assert secret_recovered.status_code == 201
    assert secret_recovered.json()["document_id"] == secret_legacy.document_id
    assert (
        client.post(
            url,
            json={**secret_body, "title": "github_pat_zyxwvutsrqponmlkjihgfe"},
            headers=headers("legacy-secret-duplicate"),
        ).status_code
        == 409
    )
    assert (
        client.post(
            url,
            json={**legacy_body, "title": "Different"},
            headers=headers("legacy-duplicate"),
        ).status_code
        == 409
    )
    moved = client.post(
        f"/api/v1/documents/{first.json()['document_id']}/move",
        json={
            "expected_revision_id": first.json()["current_revision_id"],
            "path": "private/copy.md",
        },
        headers=headers("move-copy"),
    )
    assert moved.status_code == 200
    assert client.post(url, json=body, headers={**auth, **headers("duplicate")}).status_code == 403


@pytest.mark.parametrize("http_condition", [False, True])
def test_supported_large_update_admits_final_diff_before_storage(client, settings, http_condition):
    old = "a\n" * 950_000
    new = "b\n" * 950_000
    assert len(old.encode()) < 2_000_000 and len(new.encode()) < 2_000_000
    created = client.post(
        "/api/v1/documents",
        json={"title": "Large", "content": old, "path": "docs/large.md"},
        headers=headers("large-create"),
    )
    assert created.status_code == 201
    document = created.json()
    service = client.app.state.services.documents
    activity = client.app.state.services.activity
    observed = []
    real_record = activity._record_with_connection_and_reservation

    def observed_record(**kwargs):
        if kwargs["action"] == "update":
            reservation = kwargs["reservation"]
            observed.append(
                (
                    reservation._reserved_bytes,
                    activity.estimate_payload_bytes(kwargs["details"]),
                    reservation._is_oversized_owner,
                )
            )
        return real_record(**kwargs)

    activity._record_with_connection_and_reservation = observed_record
    supplied = headers("large-update")
    body = {"content": new}
    if http_condition:
        supplied["If-Match"] = created.headers["ETag"]
    else:
        body["expected_revision_id"] = document["current_revision_id"]
    response = client.patch(
        f"/api/v1/documents/{document['document_id']}", json=body, headers=supplied
    )
    assert response.status_code == 200, response.text[:1000]
    assert observed and all(
        reserved >= needed > activity.max_total_bytes and owner
        for reserved, needed, owner in observed
    )
    assert service.get_document(document["document_id"]).content == new
    assert (settings.workspace_root / "docs/large.md").read_text() == new
    with service.database.connection() as connection:
        event = connection.execute(
            "SELECT detail_json, revision_id FROM operation_events "
            "WHERE operation_id = ? AND outcome = 'accepted'",
            (response.headers["X-Operation-ID"],),
        ).fetchone()
        assert (
            connection.execute(
                "SELECT COUNT(*) FROM revisions WHERE document_id = ?",
                (document["document_id"],),
            ).fetchone()[0]
            == 2
        )
    assert event["revision_id"] == response.json()["current_revision_id"]
    details = json.loads(event["detail_json"])
    assert details["lines_added"] == 950_000 and details["lines_removed"] == 950_000
    assert "-a\n" in details["diff"] and "+b\n" in details["diff"]
    assert activity._oversized_owner_id is None and activity.total_in_flight_bytes() == 0


def test_audit_readmission_refreshes_diff_after_waiting_for_capacity(client):
    created = client.post(
        "/api/v1/documents",
        json={"title": "Waiting", "content": "old", "path": "docs/waiting.md"},
        headers=headers("waiting-create"),
    ).json()
    service = client.app.state.services.documents
    activity = client.app.state.services.activity
    at_admission = threading.Event()
    real_admit = activity.admit
    real_record = activity._record_with_connection_and_reservation
    admissions = []
    records = []

    @contextmanager
    def observed_admit(estimated_bytes=1024, timeout=10.0):
        admissions.append(
            (
                estimated_bytes,
                getattr(service.database._local, "active_connection", None) is not None,
            )
        )
        at_admission.set()
        with real_admit(estimated_bytes, timeout) as reservation:
            yield reservation

    def observed_record(**kwargs):
        if kwargs["action"] == "update":
            records.append(
                (
                    kwargs["reservation"]._reserved_bytes,
                    activity.estimate_payload_bytes(kwargs["details"]),
                )
            )
        return real_record(**kwargs)

    blocker = real_admit(activity.max_total_bytes)
    activity.admit = observed_admit
    activity._record_with_connection_and_reservation = observed_record
    result = []
    errors = []

    def update():
        try:
            result.append(
                client.patch(
                    f"/api/v1/documents/{created['document_id']}",
                    json={"content": "final"},
                    headers={**headers("waiting-update"), "If-Match": "*"},
                )
            )
        except Exception as error:
            errors.append(repr(error))

    worker = threading.Thread(target=update, daemon=True)
    worker.start()
    try:
        assert at_admission.wait(timeout=5)
        service.update_document(
            document_id=created["document_id"],
            expected_revision_id=created["current_revision_id"],
            content="intervening\n" * 1000,
            title=None,
            summary=None,
            actor_id="human:jay",
            idempotency_key="intervening",
        )
    finally:
        blocker.release()
        worker.join(timeout=15)
    assert not worker.is_alive() and errors == []
    assert result[0].status_code == 200
    assert records and all(reserved >= needed for reserved, needed in records)
    assert all(not in_transaction for _, in_transaction in admissions)
    with service.database.connection() as connection:
        event = connection.execute(
            "SELECT detail_json FROM operation_events "
            "WHERE operation_id = ? AND outcome = 'accepted'",
            (result[0].headers["X-Operation-ID"],),
        ).fetchone()
    details = json.loads(event["detail_json"])
    assert details["lines_removed"] == 1000 and details["lines_added"] == 1
    assert "-intervening\n" in details["diff"] and "+final\n" in details["diff"]
