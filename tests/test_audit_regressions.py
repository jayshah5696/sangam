from __future__ import annotations

import json
import tarfile
from pathlib import Path

import httpx
import pytest
from conftest import headers
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from sangam import cli
from sangam.errors import ValidationError
from sangam.ssrf_client import validate_capture_url


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com:invalid/",
        "https://example.com:99999/",
        "http://[::1/",
        "https://[not-an-ip]/",
        "https://example.com\uff0fother/",
    ],
)
def test_malformed_capture_url_returns_validation_error(client: TestClient, url: str) -> None:
    with pytest.raises(ValidationError):
        validate_capture_url(url)
    response = client.post(
        "/api/v1/captures/url", json={"url": url}, headers=headers("malformed-capture")
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"


def test_malformed_asset_url_does_not_break_publication(client: TestClient) -> None:
    document = client.post(
        "/api/v1/documents",
        json={
            "title": "Malformed link",
            "content_type": "text/html",
            "content": '<img src="http://[invalid/"><p>Still readable</p>',
        },
        headers=headers("malformed-asset-document"),
    ).json()
    publication = client.post(
        "/api/v1/publications",
        json={
            "document_id": document["document_id"],
            "slug": "malformed-asset",
            "access_policy": "public",
        },
        headers=headers("malformed-asset-publication"),
    )
    assert publication.status_code == 201
    response = client.get("/api/v1/publications/malformed-asset/content")
    assert response.status_code == 200
    assert "Still readable" in response.json()["content"]
    asset = client.get(
        f"/api/v1/documents/{document['document_id']}/assets",
        params={"path": "http://[invalid/"},
    )
    assert asset.status_code == 404


@pytest.mark.parametrize("manifest_id", ["../retention-victim", "20000101T000000000000Z-000000ff"])
def test_backup_retention_ignores_mismatched_manifest_ids(
    client: TestClient, tmp_path: Path, manifest_id: str
) -> None:
    manager = client.app.state.services.backups.manager
    manager.retention_count = 2
    victim = tmp_path / "retention-victim"
    victim.mkdir()
    marker = victim / "keep.txt"
    marker.write_text("must survive retention", encoding="utf-8")
    backup = manager.create(backup_id="20000101T000000000000Z-00000001")
    manifest_path = manager.backup_root / backup.backup_id / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["backup_id"] = manifest_id
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    assert manager.list() == []
    manager.create(backup_id="20000102T000000000000Z-00000002")
    manager.create(backup_id="20000103T000000000000Z-00000003")
    manager.create(backup_id="20000104T000000000000Z-00000004")
    assert marker.read_text(encoding="utf-8") == "must survive retention"
    assert manifest_path.is_file()


@pytest.mark.parametrize(
    "content,content_type",
    [(b"<html>Bad gateway</html>", "text/html"), (b"", "text/plain")],
)
def test_cli_reports_non_json_http_errors(
    monkeypatch: pytest.MonkeyPatch, content: bytes, content_type: str
) -> None:
    def failed_request(method: str, url: str, **_kwargs: object) -> httpx.Response:
        return httpx.Response(
            502,
            content=content,
            headers={"Content-Type": content_type, "X-Operation-ID": "upstream-failure"},
            request=httpx.Request(method, url),
        )

    monkeypatch.setattr(cli.httpx, "request", failed_request)
    result = CliRunner().invoke(cli.app, ["list"])
    assert result.exit_code == 1
    payload = json.loads(result.output)
    assert "502" in payload["error"]["message"]
    assert payload["error"]["operation_id"] == "upstream-failure"


@pytest.mark.parametrize("payload", [["unavailable"], {"error": "unavailable"}])
def test_cli_preserves_nonstandard_json_errors(
    monkeypatch: pytest.MonkeyPatch, payload: list[str] | dict[str, str]
) -> None:
    def failed_request(method: str, url: str, **_kwargs: object) -> httpx.Response:
        return httpx.Response(
            502,
            json=payload,
            headers={"X-Operation-ID": "upstream-failure"},
            request=httpx.Request(method, url),
        )

    monkeypatch.setattr(cli.httpx, "request", failed_request)
    result = CliRunner().invoke(cli.app, ["list"])
    assert result.exit_code == 1
    assert json.loads(result.output) == payload


@pytest.mark.parametrize("unreadable", ["file", "directory"])
def test_backup_aborts_on_unreadable_attachments(client: TestClient, unreadable: str) -> None:
    manager = client.app.state.services.backups.manager
    directory = manager.workspace_root / "attachments"
    directory.mkdir()
    attachment = directory / "untracked.txt"
    attachment.write_text("must survive restore", encoding="utf-8")
    target = attachment if unreadable == "file" else directory
    permissions = target.stat().st_mode
    target.chmod(0)
    try:
        try:
            if unreadable == "file":
                target.read_bytes()
            else:
                list(target.iterdir())
        except PermissionError:
            pass
        else:
            pytest.skip("The current user can bypass filesystem permissions")
        with pytest.raises(PermissionError):
            manager.create()
        assert manager.list() == []
        assert list(manager.backup_root.iterdir()) == []
    finally:
        target.chmod(permissions)

    backup = manager.create()
    with tarfile.open(manager.backup_root / backup.backup_id / "workspace.tar.gz") as archive:
        handle = archive.extractfile("attachments/untracked.txt")
        assert handle is not None
        assert handle.read() == b"must survive restore"
