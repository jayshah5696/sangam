from __future__ import annotations

import hashlib
import io

from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def text_pdf(text: str = "Sangam research phrase") -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_reference = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_reference})}
    )
    stream = DecodedStreamObject()
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream.set_data(f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def import_pdf(
    client: TestClient,
    *,
    content: bytes,
    key: str,
    title: str = "Research paper",
    path: str = "research/paper.pdf",
    supersedes: str | None = None,
):
    query = {"title": title, "path": path}
    if supersedes:
        query["supersedes_document_id"] = supersedes
    return client.post(
        "/api/v1/pdfs",
        params=query,
        content=content,
        headers={**headers(key), "Content-Type": "application/pdf"},
    )


def test_pdf_import_extraction_range_search_and_immutability(client: TestClient, settings) -> None:
    source = text_pdf()
    imported_response = import_pdf(client, content=source, key="pdf-import")
    assert imported_response.status_code == 201
    imported = imported_response.json()
    document_id = imported["document_id"]

    retried = import_pdf(client, content=source, key="pdf-import")
    assert retried.status_code == 201
    assert retried.json()["document_id"] == document_id

    current = client.get(f"/api/v1/documents/{document_id}").json()
    assert current["content_type"] == "application/pdf"
    assert current["content"] == ""
    assert current["content_hash"] == hashlib.sha256(source).hexdigest()
    assert current["file_hash"] == current["content_hash"]
    assert current["pdf_extraction_status"] == "ready"
    assert current["pdf_page_count"] == 1
    assert (settings.workspace_root / "research/paper.pdf").read_bytes() == source

    full = client.get(f"/api/v1/pdfs/{document_id}/content")
    assert full.status_code == 200
    assert full.content == source
    assert full.headers["accept-ranges"] == "bytes"

    raw = client.get(f"/api/v1/documents/{document_id}/raw")
    assert raw.status_code == 200
    assert raw.content == source
    assert raw.headers["content-type"] == "application/pdf"
    downloaded = client.get(f"/api/v1/documents/{document_id}/download")
    assert downloaded.content == source
    assert downloaded.headers["content-disposition"] == ("attachment; filename*=UTF-8''paper.pdf")

    partial = client.get(f"/api/v1/pdfs/{document_id}/content", headers={"Range": "bytes=0-7"})
    assert partial.status_code == 206
    assert partial.content == source[:8]
    assert partial.headers["content-range"] == f"bytes 0-7/{len(source)}"

    pages = client.get(f"/api/v1/pdfs/{document_id}/pages").json()
    assert pages == [
        {"document_id": document_id, "page_number": 1, "text": "Sangam research phrase"}
    ]
    search = client.get(
        f"/api/v1/pdfs/{document_id}/search", params={"q": "research phrase"}
    ).json()
    assert search[0]["page_number"] == 1
    assert "research phrase" in search[0]["snippet"]
    assert [item["document_id"] for item in client.get("/api/v1/search?q=research").json()] == [
        document_id
    ]

    overwrite = client.patch(
        f"/api/v1/documents/{document_id}",
        json={"expected_revision_id": current["current_revision_id"], "content": "not a PDF"},
        headers=headers("overwrite-pdf"),
    )
    assert overwrite.status_code == 422
    assert (settings.workspace_root / "research/paper.pdf").read_bytes() == source

    replacement_source = text_pdf("Replacement paper")
    replacement = import_pdf(
        client,
        content=replacement_source,
        key="pdf-replacement",
        title="Replacement",
        path="research/replacement.pdf",
        supersedes=document_id,
    )
    assert replacement.status_code == 201
    assert replacement.json()["document_id"] != document_id
    assert replacement.json()["supersedes_document_id"] == document_id
    assert (settings.workspace_root / "research/paper.pdf").read_bytes() == source


def test_pdf_import_adopts_exact_orphan_and_resolves_reconciliation_conflict(
    client: TestClient, settings
) -> None:
    source = text_pdf("Recovered import")
    orphan = settings.workspace_root / "recovered/orphan.pdf"
    orphan.parent.mkdir(parents=True)
    orphan.write_bytes(source)

    scan = client.post("/api/v1/reconciliation/scan").json()
    assert any(
        conflict["conflict_type"] == "unknown_file" and conflict["path"] == "recovered/orphan.pdf"
        for conflict in scan["conflicts"]
    )

    imported = import_pdf(
        client,
        content=source,
        key="adopt-orphan",
        title="Recovered import",
        path="recovered/orphan.pdf",
    )
    assert imported.status_code == 201
    assert orphan.read_bytes() == source
    assert client.get("/api/v1/reconciliation").json()["conflicts"] == []


def test_annotation_versions_conflicts_tombstones_and_search(client: TestClient) -> None:
    document = import_pdf(client, content=text_pdf(), key="annotation-pdf").json()
    document_id = document["document_id"]
    create_body = {
        "page_number": 1,
        "annotation_type": "text_highlight",
        "selected_text": "research phrase",
        "note": "Important evidence",
        "geometry": [{"x": 0.1, "y": 0.1, "width": 0.3, "height": 0.04}],
        "tags": ["Evidence", "phase-five"],
        "color": "#F0C75E",
    }
    created_response = client.post(
        f"/api/v1/pdfs/{document_id}/annotations",
        json=create_body,
        headers=headers("create-annotation"),
    )
    assert created_response.status_code == 201
    created = created_response.json()
    annotation_id = created["annotation_id"]
    assert created["version"] == 1
    assert created["tags"] == ["Evidence", "phase-five"]
    assert created["created_by"] == "human:jay"

    updated_body = {
        "expected_version": 1,
        "selected_text": created["selected_text"],
        "note": "Updated research note",
        "geometry": created["geometry"],
        "tags": ["evidence"],
        "color": "#70A1D7",
    }
    updated = client.patch(
        f"/api/v1/annotations/{annotation_id}",
        json=updated_body,
        headers=headers("update-annotation"),
    ).json()
    assert updated["version"] == 2
    assert updated["note"] == "Updated research note"

    stale = client.patch(
        f"/api/v1/annotations/{annotation_id}",
        json={**updated_body, "note": "stale"},
        headers=headers("stale-annotation"),
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["details"]["current_version"] == 2

    annotation_search = client.get(
        f"/api/v1/pdfs/{document_id}/annotations", params={"q": "updated"}
    ).json()
    assert [item["annotation_id"] for item in annotation_search] == [annotation_id]
    assert [item["document_id"] for item in client.get("/api/v1/search?q=updated").json()] == [
        document_id
    ]

    removed = client.delete(
        f"/api/v1/annotations/{annotation_id}",
        params={"expected_version": 2},
        headers=headers("delete-annotation"),
    ).json()
    assert removed["deleted"] is True
    assert removed["version"] == 3
    assert client.get(f"/api/v1/pdfs/{document_id}/annotations").json() == []

    history = client.get(f"/api/v1/annotations/{annotation_id}/history").json()
    assert [event["operation"] for event in history] == ["delete", "update", "create"]
    assert [event["version"] for event in history] == [3, 2, 1]
    assert history[1]["snapshot"]["note"] == "Updated research note"


def test_agent_pdf_reads_searches_and_annotations_are_path_scoped(client: TestClient) -> None:
    allowed = import_pdf(
        client,
        content=text_pdf("Scoped evidence"),
        key="scoped-pdf",
        path="agents/scoped.pdf",
    ).json()
    denied = import_pdf(
        client,
        content=text_pdf("Private evidence"),
        key="private-pdf",
        path="projects/private.pdf",
    ).json()
    token = issue_agent_token(
        client,
        actor_id="agent:pdf-researcher",
        display_name="PDF researcher",
        capabilities=("read", "search", "update"),
        path_prefix="agents",
    )
    authorization = {"Authorization": f"Bearer {token}"}

    assert (
        client.get(
            f"/api/v1/pdfs/{allowed['document_id']}/search",
            params={"q": "Scoped"},
            headers=authorization,
        ).status_code
        == 200
    )
    created = client.post(
        f"/api/v1/pdfs/{allowed['document_id']}/annotations",
        json={
            "page_number": 1,
            "annotation_type": "page_note",
            "note": "Agent observation",
        },
        headers={**authorization, "Idempotency-Key": "agent-annotation"},
    )
    assert created.status_code == 201
    assert created.json()["created_by"] == "agent:pdf-researcher"

    assert (
        client.get(
            f"/api/v1/pdfs/{denied['document_id']}/content", headers=authorization
        ).status_code
        == 403
    )
    denied_annotation = client.post(
        f"/api/v1/pdfs/{denied['document_id']}/annotations",
        json={
            "page_number": 1,
            "annotation_type": "page_note",
            "note": "Must be denied",
        },
        headers={**authorization, "Idempotency-Key": "denied-agent-annotation"},
    )
    assert denied_annotation.status_code == 403


def test_extraction_failure_is_visible_and_does_not_block_pdf_bytes(client: TestClient) -> None:
    damaged = b"%PDF-1.7\nthis is deliberately damaged"
    imported = import_pdf(
        client,
        content=damaged,
        key="damaged-pdf",
        path="research/damaged.pdf",
    ).json()
    document_id = imported["document_id"]

    current = client.get(f"/api/v1/documents/{document_id}").json()
    assert current["pdf_extraction_status"] == "failed"
    assert current["pdf_extraction_error"]
    assert client.get(f"/api/v1/pdfs/{document_id}/content").content == damaged

    retried = client.post(f"/api/v1/pdfs/{document_id}/extract")
    assert retried.status_code == 200
    after_retry = client.get(f"/api/v1/documents/{document_id}").json()
    assert after_retry["pdf_extraction_status"] == "failed"


def test_pdf_move_rename_and_ancestor_folder_move(client: TestClient, settings) -> None:
    source = text_pdf("Movable PDF research")
    imported = import_pdf(
        client, content=source, key="pdf-movable", path="research/movable.pdf", title="Movable"
    ).json()
    document_id = imported["document_id"]
    rev_1 = imported["current_revision_id"]

    rename_resp = client.post(
        f"/api/v1/documents/{document_id}/move",
        headers=headers("rename-pdf"),
        json={"expected_revision_id": rev_1, "path": "research/renamed.pdf"},
    )
    assert rename_resp.status_code == 200, rename_resp.text
    renamed = rename_resp.json()
    assert renamed["path"] == "research/renamed.pdf"
    assert renamed["document_id"] == document_id
    assert renamed["content_hash"] == hashlib.sha256(source).hexdigest()
    assert (settings.workspace_root / "research/renamed.pdf").read_bytes() == source
    assert not (settings.workspace_root / "research/movable.pdf").exists()

    history = client.get(f"/api/v1/documents/{document_id}/history").json()
    assert history[0]["operation"] == "move"
    rev_2 = renamed["current_revision_id"]

    noop = client.post(
        f"/api/v1/documents/{document_id}/move",
        headers=headers("noop-pdf"),
        json={"expected_revision_id": rev_2, "path": "research/renamed.pdf"},
    )
    assert noop.status_code == 422

    wrong_ext = client.post(
        f"/api/v1/documents/{document_id}/move",
        headers=headers("wrong-ext-pdf"),
        json={"expected_revision_id": rev_2, "path": "research/renamed.md"},
    )
    assert wrong_ext.status_code == 422

    move_resp = client.post(
        f"/api/v1/documents/{document_id}/move",
        headers=headers("move-pdf-folder"),
        json={"expected_revision_id": rev_2, "path": "archive/renamed.pdf"},
    )
    assert move_resp.status_code == 200
    assert (settings.workspace_root / "archive/renamed.pdf").read_bytes() == source
    assert not (settings.workspace_root / "research/renamed.pdf").exists()

    folders = client.get("/api/v1/folders").json()
    archive_folder = next(f for f in folders if f["path"] == "archive")
    folder_resp = client.post(
        f"/api/v1/folders/{archive_folder['folder_id']}/move",
        headers=headers("rename-folder"),
        json={"path": "old_archive"},
    )
    assert folder_resp.status_code == 200
    after_folder_move = client.get(f"/api/v1/documents/{document_id}").json()
    assert after_folder_move["path"] == "old_archive/renamed.pdf"
    assert (settings.workspace_root / "old_archive/renamed.pdf").read_bytes() == source


def test_pdf_duplicate_creates_new_document_and_leaves_source_intact(
    client: TestClient, settings
) -> None:
    source = text_pdf("Original PDF for duplication")
    imported = import_pdf(
        client,
        content=source,
        key="pdf-dup-source",
        path="reports/paper.pdf",
        title="Original Paper",
    ).json()
    source_id = imported["document_id"]
    rev_id = imported["current_revision_id"]

    anno_resp = client.post(
        f"/api/v1/pdfs/{source_id}/annotations",
        json={
            "page_number": 1,
            "annotation_type": "text_highlight",
            "selected_text": "Original PDF",
            "note": "Source annotation",
            "geometry": [{"x": 0.1, "y": 0.1, "width": 0.3, "height": 0.04}],
        },
        headers=headers("dup-annotation"),
    )
    assert anno_resp.status_code == 201

    dup_resp = client.post(
        f"/api/v1/documents/{source_id}/duplicate",
        headers=headers("dup-default"),
        json={"expected_revision_id": rev_id},
    )
    assert dup_resp.status_code == 201, dup_resp.text
    duplicated = dup_resp.json()
    dup_id = duplicated["document_id"]
    assert dup_id != source_id
    assert duplicated["path"] == "reports/paper copy.pdf"
    assert duplicated["content_hash"] == imported["content_hash"]
    assert duplicated["supersedes_document_id"] is None
    assert (settings.workspace_root / "reports/paper copy.pdf").read_bytes() == source

    dup_annotations = client.get(f"/api/v1/pdfs/{dup_id}/annotations").json()
    assert dup_annotations == []

    source_annotations = client.get(f"/api/v1/pdfs/{source_id}/annotations").json()
    assert len(source_annotations) == 1

    dup_custom = client.post(
        f"/api/v1/documents/{source_id}/duplicate",
        headers=headers("dup-custom"),
        json={"expected_revision_id": rev_id, "path": "custom/nested.pdf", "title": "Custom Copy"},
    )
    assert dup_custom.status_code == 201
    assert dup_custom.json()["path"] == "custom/nested.pdf"
    assert dup_custom.json()["title"] == "Custom Copy"
    assert (settings.workspace_root / "custom/nested.pdf").read_bytes() == source

    collision = client.post(
        f"/api/v1/documents/{source_id}/duplicate",
        headers=headers("dup-collision"),
        json={"expected_revision_id": rev_id, "path": "reports/paper copy.pdf"},
    )
    assert collision.status_code == 422


def test_pdf_trash_retention_restore_and_collision(client: TestClient, settings) -> None:
    source = text_pdf("PDF for trash retention test")
    imported = import_pdf(
        client, content=source, key="pdf-trash-source", path="notes/trash_me.pdf", title="Trash Me"
    ).json()
    document_id = imported["document_id"]
    rev_1 = imported["current_revision_id"]

    del_resp = client.request(
        "DELETE",
        f"/api/v1/documents/{document_id}",
        json={"expected_revision_id": rev_1},
        headers=headers("trash-pdf"),
    )
    assert del_resp.status_code == 200, del_resp.text
    deleted = del_resp.json()
    assert deleted["deleted"] is True
    rev_del = deleted["current_revision_id"]

    assert not (settings.workspace_root / "notes/trash_me.pdf").exists()

    trash_file = settings.workspace_root / ".sangam-trash" / f"{document_id}.pdf"
    assert trash_file.exists()
    assert trash_file.read_bytes() == source

    scan = client.post("/api/v1/reconciliation/scan").json()
    assert not any("trash_me.pdf" in c.get("path", "") for c in scan["conflicts"])
    assert not any(".sangam-trash" in c.get("path", "") for c in scan["conflicts"])

    occupied = settings.workspace_root / "notes/trash_me.pdf"
    occupied.write_bytes(b"%PDF-1.7\nnew occupying file")
    conflict_restore = client.post(
        f"/api/v1/documents/{document_id}/restore",
        headers=headers("restore-conflict"),
        json={"expected_revision_id": rev_del, "revision_id": rev_del},
    )
    assert conflict_restore.status_code == 409
    assert "occupied" in conflict_restore.json()["error"]["message"]
    assert occupied.read_bytes() == b"%PDF-1.7\nnew occupying file"
    assert trash_file.exists()

    occupied.unlink()

    restore_resp = client.post(
        f"/api/v1/documents/{document_id}/restore",
        headers=headers("restore-pdf-ok"),
        json={"expected_revision_id": rev_del, "revision_id": rev_del},
    )
    assert restore_resp.status_code == 200, restore_resp.text
    restored = restore_resp.json()
    assert restored["deleted"] is False
    assert restored["path"] == "notes/trash_me.pdf"
    assert (settings.workspace_root / "notes/trash_me.pdf").read_bytes() == source
    assert not trash_file.exists()

    active_restore = client.post(
        f"/api/v1/documents/{document_id}/restore",
        headers=headers("restore-active-pdf"),
        json={"expected_revision_id": restored["current_revision_id"], "revision_id": rev_1},
    )
    assert active_restore.status_code == 422
