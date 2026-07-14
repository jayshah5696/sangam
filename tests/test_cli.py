from __future__ import annotations

from typing import Any

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
        ["history", "doc-1"],
        ["restore", "doc-1", "r1", "--expected-revision", "r2"],
    ]
    for arguments in invocations:
        result = runner.invoke(cli.app, arguments)
        assert result.exit_code == 0, result.output

    assert ("GET", "/documents", None) in calls
    assert ("GET", "/documents/doc-1", None) in calls
    assert ("GET", "/search?q=workspace+notes", None) in calls
    assert (
        "POST",
        "/documents",
        {"title": "CLI", "content": "from file", "path": None},
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
        "/documents/doc-1/restore",
        {"expected_revision_id": "r2", "revision_id": "r1"},
    ) in calls
