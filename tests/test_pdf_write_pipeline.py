"""A PDF move, trash, or restore must notice a writer that got in after its revision check.

Within one process the document lock prevents this, so a second process is simulated by a
raw SQL write made while the file step runs: after the pre-commit check, before the commit.
"""

from __future__ import annotations

import uuid

import pytest
from fastapi.testclient import TestClient
from test_phase_five_pdf_research import import_pdf, text_pdf

from sangam.db import utc_now
from sangam.errors import ConflictError


def write_from_another_process(client: TestClient, document_id: str) -> str:
    """Append a revision to the document as a competing writer would, bypassing locks."""
    services = client.app.state.services
    with services.documents.database.transaction() as connection:
        head = connection.execute(
            "SELECT current_revision_id, content_hash, size_bytes FROM documents "
            "WHERE document_id = ?",
            (document_id,),
        ).fetchone()
        revision_id = str(uuid.uuid4())
        connection.execute(
            "INSERT INTO revisions(revision_id, document_id, parent_revision_id, content, "
            "content_hash, size_bytes, actor_id, operation, summary, created_at) "
            "VALUES (?, ?, ?, '', ?, ?, 'human:jay', 'move', 'competing writer', ?)",
            (
                revision_id,
                document_id,
                head["current_revision_id"],
                head["content_hash"],
                head["size_bytes"],
                utc_now(),
            ),
        )
        connection.execute(
            "UPDATE documents SET current_revision_id = ? WHERE document_id = ?",
            (revision_id, document_id),
        )
    return revision_id


@pytest.mark.parametrize("operation", ["move", "delete"])
def test_a_competing_write_during_the_file_step_fails_the_commit_and_restores_the_file(
    client: TestClient, settings, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    pdf = import_pdf(client, content=text_pdf(), key=f"import-{operation}", path="race/paper.pdf")
    document = pdf.json()
    services = client.app.state.services
    filesystem = services.documents.workspace
    competing: list[str] = []

    def after(name: str):
        original = getattr(filesystem, name)

        def wrapped(*args, **kwargs):
            result = original(*args, **kwargs)
            if not competing:  # the undo step moves files too
                competing.append(write_from_another_process(client, document["document_id"]))
            return result

        monkeypatch.setattr(filesystem, name, wrapped)

    after("move_document" if operation == "move" else "trash_document")
    call = {
        "move": lambda: services.documents.move_document(
            document_id=document["document_id"],
            expected_revision_id=document["current_revision_id"],
            path="race/moved.pdf",
            summary=None,
            actor_id="human:jay",
            idempotency_key="race-move",
        ),
        "delete": lambda: services.documents.delete_document(
            document_id=document["document_id"],
            expected_revision_id=document["current_revision_id"],
            summary=None,
            actor_id="human:jay",
            idempotency_key="race-delete",
        ),
    }[operation]

    with pytest.raises(ConflictError):
        call()

    head = services.documents.get_document(document["document_id"], include_deleted=True)
    assert head.current_revision_id == competing[0]
    assert head.path == "race/paper.pdf" and not head.deleted
    assert (settings.workspace_root / "race" / "paper.pdf").is_file()
    assert not (settings.workspace_root / "race" / "moved.pdf").exists()
