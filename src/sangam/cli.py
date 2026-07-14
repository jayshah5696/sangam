from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import urlencode

import httpx
import typer

app = typer.Typer(help="Use Sangam's document API from the command line.", no_args_is_help=True)


def _base_url() -> str:
    return os.getenv("SANGAM_API_URL", "http://127.0.0.1:8000").rstrip("/")


def _request(method: str, path: str, *, body: dict[str, Any] | None = None) -> Any:
    headers = {"X-Actor": "client:cli"}
    if method != "GET":
        headers["Idempotency-Key"] = str(uuid.uuid4())
    try:
        response = httpx.request(
            method,
            f"{_base_url()}/api/v1{path}",
            json=body,
            headers=headers,
            timeout=15,
        )
        response.raise_for_status()
    except httpx.HTTPStatusError as error:
        typer.echo(json.dumps(error.response.json(), indent=2), err=True)
        raise typer.Exit(1) from error
    except httpx.HTTPError as error:
        typer.echo(f"Unable to reach Sangam at {_base_url()}: {error}", err=True)
        raise typer.Exit(1) from error
    return response.json()


def _print_json(value: Any) -> None:
    typer.echo(json.dumps(value, indent=2, sort_keys=True))


@app.command("list")
def list_documents() -> None:
    """List current documents."""
    _print_json(_request("GET", "/documents"))


@app.command()
def read(
    document_id: str,
    json_output: Annotated[bool, typer.Option("--json", help="Print all metadata.")] = False,
) -> None:
    """Read a document by stable ID."""
    document = _request("GET", f"/documents/{document_id}")
    if json_output:
        _print_json(document)
    else:
        typer.echo(document["content"], nl=not document["content"].endswith("\n"))


@app.command()
def search(query: str) -> None:
    """Search current document titles, paths, content, tags, and categories."""
    _print_json(_request("GET", f"/search?{urlencode({'q': query})}"))


@app.command()
def create(
    title: Annotated[str, typer.Option("--title", "-t")],
    content: Annotated[str, typer.Option("--content", "-c")] = "",
    file: Annotated[Path | None, typer.Option("--file", "-f")] = None,
    path: Annotated[str | None, typer.Option("--path", help="Workspace-relative .md path.")] = None,
) -> None:
    """Create a Markdown document, materialized only when --path is provided."""
    if file:
        content = file.read_text(encoding="utf-8")
    _print_json(
        _request("POST", "/documents", body={"title": title, "content": content, "path": path})
    )


@app.command()
def update(
    document_id: str,
    expected_revision: Annotated[str, typer.Option("--expected-revision")],
    content: Annotated[str, typer.Option("--content", "-c")] = "",
    file: Annotated[Path | None, typer.Option("--file", "-f")] = None,
    summary: Annotated[str | None, typer.Option("--summary")] = None,
) -> None:
    """Update content using an explicit expected revision."""
    if file:
        content = file.read_text(encoding="utf-8")
    _print_json(
        _request(
            "PATCH",
            f"/documents/{document_id}",
            body={
                "expected_revision_id": expected_revision,
                "content": content,
                "summary": summary,
            },
        )
    )


@app.command()
def materialize(
    document_id: str,
    path: str,
    expected_revision: Annotated[str, typer.Option("--expected-revision")],
) -> None:
    """Save an unmaterialized document to an ordinary workspace file."""
    _print_json(
        _request(
            "POST",
            f"/documents/{document_id}/materialize",
            body={"expected_revision_id": expected_revision, "path": path},
        )
    )


@app.command()
def history(document_id: str) -> None:
    """Show immutable revision history."""
    _print_json(_request("GET", f"/documents/{document_id}/history"))


@app.command()
def restore(
    document_id: str,
    revision_id: str,
    expected_revision: Annotated[str, typer.Option("--expected-revision")],
) -> None:
    """Restore an old snapshot as a new revision."""
    _print_json(
        _request(
            "POST",
            f"/documents/{document_id}/restore",
            body={
                "expected_revision_id": expected_revision,
                "revision_id": revision_id,
            },
        )
    )


if __name__ == "__main__":
    app()
