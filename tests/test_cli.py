from __future__ import annotations

from typing import Any

import httpx
import pytest
from typer.testing import CliRunner

from sangam import cli


def test_cli_commands_map_to_http_api(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    calls: list[tuple[str, str, dict[str, Any] | None]] = []

    def fake_request(method: str, path: str, *, body: dict[str, Any] | None = None) -> Any:
        calls.append((method, path, body))
        if path.endswith("/history"):
            return [{"revision_id": "r1"}]
        if method == "GET" and path == "/documents/doc-1":
            return {"content": "CLI content"}
        return {"document_id": "doc-1", "current_revision_id": "r2"}

    monkeypatch.setattr(cli, "_request", fake_request)
    runner = CliRunner()
    content_file = tmp_path / "content.md"
    content_file.write_text("from file", encoding="utf-8")

    invocations = [
        ["list"],
        ["read", "doc-1"],
        ["search", "workspace notes"],
        ["create", "--title", "CLI", "--file", str(content_file)],
        [
            "update",
            "doc-1",
            "--expected-revision",
            "r1",
            "--content",
            "updated",
        ],
        ["materialize", "doc-1", "projects/cli.md", "--expected-revision", "r2"],
        ["move", "doc-1", "agents/cli.md", "--expected-revision", "r2"],
        [
            "tag",
            "doc-1",
            "--expected-metadata-version",
            "2",
            "--tag-id",
            "tag-1",
            "--category",
            "Research",
        ],
        ["history", "doc-1"],
        ["diff", "doc-1", "--from-revision", "r1", "--to-revision", "r2"],
        ["restore", "doc-1", "r1", "--expected-revision", "r2"],
        ["publish", "doc-1", "cli-report", "--access", "unlisted"],
        ["publications"],
        ["expose-revision", "pub-1", "r1"],
        ["rotate-publication-token", "pub-1"],
        ["unpublish", "pub-1", "--expected-version", "2"],
    ]
    for arguments in invocations:
        result = runner.invoke(cli.app, arguments)
        assert result.exit_code == 0, result.output

    assert ("GET", "/documents?limit=100&offset=0", None) in calls
    assert ("GET", "/documents/doc-1", None) in calls
    assert ("GET", "/search?q=workspace+notes&limit=50&offset=0", None) in calls
    assert (
        "POST",
        "/documents",
        {
            "title": "CLI",
            "content": "from file",
            "path": None,
            "content_type": "text/markdown",
        },
    ) in calls
    assert (
        "PATCH",
        "/documents/doc-1",
        {
            "expected_revision_id": "r1",
            "content": "updated",
            "summary": None,
        },
    ) in calls
    assert (
        "POST",
        "/documents/doc-1/materialize",
        {"expected_revision_id": "r2", "path": "projects/cli.md"},
    ) in calls
    assert ("GET", "/documents/doc-1/history", None) in calls
    assert (
        "POST",
        "/documents/doc-1/move",
        {"expected_revision_id": "r2", "path": "agents/cli.md", "summary": None},
    ) in calls
    assert (
        "PATCH",
        "/documents/doc-1/metadata",
        {
            "expected_metadata_version": 2,
            "category": "Research",
            "tag_ids": ["tag-1"],
        },
    ) in calls
    assert (
        "GET",
        "/documents/doc-1/diff?from_revision_id=r1&to_revision_id=r2",
        None,
    ) in calls
    assert (
        "POST",
        "/documents/doc-1/restore",
        {"expected_revision_id": "r2", "revision_id": "r1"},
    ) in calls
    assert (
        "POST",
        "/publications",
        {"document_id": "doc-1", "slug": "cli-report", "access_policy": "unlisted"},
    ) in calls
    assert ("GET", "/publications", None) in calls
    assert (
        "POST",
        "/publications/pub-1/revisions",
        {"revision_id": "r1"},
    ) in calls
    assert ("POST", "/publications/pub-1/rotate-token", None) in calls
    assert ("DELETE", "/publications/pub-1?expected_version=2", None) in calls


def test_cli_uses_bearer_token_without_spoofable_actor_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_httpx_request(method: str, url: str, **kwargs: object) -> httpx.Response:
        captured.update(method=method, url=url, **kwargs)
        return httpx.Response(200, json=[], request=httpx.Request(method, url))

    monkeypatch.setenv("SANGAM_TOKEN", "sgm_agt_example.secret")
    monkeypatch.setattr(cli.httpx, "request", fake_httpx_request)

    assert cli._request("GET", "/documents") == []
    request_headers = captured["headers"]
    assert isinstance(request_headers, dict)
    assert request_headers == {"Authorization": "Bearer sgm_agt_example.secret"}
