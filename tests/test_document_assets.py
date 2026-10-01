"""Images pasted into a document become ordinary files in the shared attachments folder.

References are workspace-root-relative (`/attachments/...`), so moving or renaming
the document, or its folder, never breaks them.
"""

from __future__ import annotations

import hashlib

from conftest import headers, issue_agent_token
from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def create(client: TestClient, key: str, path: str | None = "notes/plan.md") -> dict:
    response = client.post(
        "/api/v1/documents",
        json={"title": "Plan", "content": "# Plan\n", "path": path},
        headers=headers(key),
    )
    assert response.status_code == 201, response.text
    return response.json()


def upload(
    client: TestClient,
    document_id: str,
    content: bytes = PNG,
    *,
    filename: str = "Screen Shot 1.png",
    media_type: str = "image/png",
    authorization: str | None = None,
):
    request_headers = {"Content-Type": media_type}
    if authorization:
        request_headers["Authorization"] = authorization
    return client.post(
        f"/api/v1/documents/{document_id}/assets",
        params={"filename": filename},
        content=content,
        headers=request_headers,
    )


def test_uploaded_image_is_stored_in_attachments_and_readable(
    client: TestClient, settings: Settings
) -> None:
    document = create(client, "asset-doc")
    response = upload(client, document["document_id"])
    assert response.status_code == 201, response.text
    asset = response.json()
    digest = hashlib.sha256(PNG).hexdigest()[:16]
    assert asset["reference"] == f"/attachments/screen-shot-1-{digest}.png"
    assert asset["markdown"] == f"![Screen Shot 1]({asset['reference']})"
    assert asset["media_type"] == "image/png"
    assert (
        settings.workspace_root / "attachments" / f"screen-shot-1-{digest}.png"
    ).read_bytes() == PNG

    again = upload(client, document["document_id"])
    assert again.status_code == 201
    assert again.json()["reference"] == asset["reference"]

    served = client.get(
        f"/api/v1/documents/{document['document_id']}/assets",
        params={"path": asset["reference"]},
    )
    assert served.status_code == 200
    assert served.content == PNG
    assert served.headers["content-type"] == "image/png"
    assert served.headers["x-content-type-options"] == "nosniff"


def test_pathless_drafts_can_add_images(client: TestClient) -> None:
    draft = create(client, "asset-draft", path=None)
    response = upload(client, draft["document_id"])
    assert response.status_code == 201, response.text
    served = client.get(
        f"/api/v1/documents/{draft['document_id']}/assets",
        params={"path": response.json()["reference"]},
    )
    assert served.status_code == 200


def test_images_survive_moving_the_document_and_renaming_its_folder(client: TestClient) -> None:
    document = create(client, "asset-move")
    asset = upload(client, document["document_id"]).json()
    content = f"# Plan\n\n{asset['markdown']}\n"
    updated = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={"expected_revision_id": document["current_revision_id"], "content": content},
        headers=headers("asset-move-edit"),
    ).json()
    moved = client.post(
        f"/api/v1/documents/{document['document_id']}/move",
        json={
            "expected_revision_id": updated["current_revision_id"],
            "path": "elsewhere/deep/plan.md",
        },
        headers=headers("asset-move-move"),
    )
    assert moved.status_code == 200, moved.text
    assert moved.json()["content"] == content
    folder = next(f for f in client.get("/api/v1/folders").json() if f["path"] == "elsewhere")
    renamed = client.post(
        f"/api/v1/folders/{folder['folder_id']}/move",
        json={"path": "archive"},
        headers=headers("asset-move-folder"),
    )
    assert renamed.status_code == 200, renamed.text
    served = client.get(
        f"/api/v1/documents/{document['document_id']}/assets", params={"path": asset["reference"]}
    )
    assert served.status_code == 200
    assert served.content == PNG


def test_declared_type_must_match_the_bytes_and_svg_is_refused(client: TestClient) -> None:
    document = create(client, "asset-types")
    disguised = upload(client, document["document_id"], b"<script>alert(1)</script>")
    assert disguised.status_code == 422
    svg = upload(
        client,
        document["document_id"],
        b"<svg xmlns='http://www.w3.org/2000/svg'/>",
        filename="x.svg",
        media_type="image/svg+xml",
    )
    assert svg.status_code == 422


def test_oversized_images_are_refused(settings: Settings) -> None:
    limited = settings.model_copy(update={"max_publication_asset_bytes": 1_024})
    with TestClient(create_app(limited)) as client:
        document = create(client, "asset-large")
        response = upload(client, document["document_id"], PNG + b"\x00" * 2_048)
        assert response.status_code == 422
        assert "size limit" in response.json()["error"]["message"]


def test_asset_reads_serve_only_images_from_the_attachments_folder(client: TestClient) -> None:
    document = create(client, "asset-escape")
    create(client, "asset-secret", path="private/secret.md")
    for path in (
        "../private/secret.md",
        "/private/secret.md",
        "/attachments/../private/secret.md",
        "/attachments/notes.md",
        "https://example.com/x.png",
    ):
        escaped = client.get(
            f"/api/v1/documents/{document['document_id']}/assets", params={"path": path}
        )
        assert escaped.status_code == 404, path


def test_asset_routes_obey_document_scopes(client: TestClient) -> None:
    document = create(client, "asset-scope")
    upload(client, document["document_id"])
    reader = issue_agent_token(
        client, actor_id="agent:asset-reader", capabilities=("read",), path_prefix="elsewhere"
    )
    denied_read = client.get(
        f"/api/v1/documents/{document['document_id']}/assets",
        params={"path": "/attachments/anything.png"},
        headers={"Authorization": f"Bearer {reader}"},
    )
    assert denied_read.status_code == 403
    read_only = issue_agent_token(
        client, actor_id="agent:asset-viewer", capabilities=("read",), path_prefix="notes"
    )
    denied_write = upload(client, document["document_id"], authorization=f"Bearer {read_only}")
    assert denied_write.status_code == 403


def test_published_document_serves_its_uploaded_image(client: TestClient) -> None:
    document = create(client, "asset-publish")
    asset = upload(client, document["document_id"]).json()
    updated = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        json={
            "expected_revision_id": document["current_revision_id"],
            "content": f"# Plan\n\n{asset['markdown']}\n",
        },
        headers=headers("asset-publish-edit"),
    ).json()
    client.post(
        "/api/v1/publications",
        json={"document_id": document["document_id"], "slug": "plan", "access_policy": "public"},
        headers=headers("asset-publish-create"),
    )
    served = client.get(
        "/api/v1/publications/plan/asset",
        params={"revision": updated["current_revision_id"], "path": asset["reference"]},
    )
    assert served.status_code == 200
    assert served.content == PNG
