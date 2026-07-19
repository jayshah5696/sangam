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


def _token() -> str | None:
    token = os.getenv("SANGAM_TOKEN")
    return token.strip() if token and token.strip() else None


def _request(method: str, path: str, *, body: dict[str, Any] | None = None) -> Any:
    headers: dict[str, str] = {}
    if token := _token():
        headers["Authorization"] = f"Bearer {token}"
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
        payload = error.response.json()
        if operation_id := error.response.headers.get("X-Operation-ID"):
            payload.setdefault("error", {})["operation_id"] = operation_id
        typer.echo(json.dumps(payload, indent=2), err=True)
        raise typer.Exit(1) from error
    except httpx.HTTPError as error:
        typer.echo(f"Unable to reach Sangam at {_base_url()}: {error}", err=True)
        raise typer.Exit(1) from error
    return response.json()


def _print_json(value: Any) -> None:
    typer.echo(json.dumps(value, indent=2, sort_keys=True))


@app.command("list")
def list_documents(
    limit: Annotated[int, typer.Option("--limit", min=1, max=200)] = 100,
    offset: Annotated[int, typer.Option("--offset", min=0)] = 0,
) -> None:
    """List current documents."""
    _print_json(_request("GET", f"/documents?{urlencode({'limit': limit, 'offset': offset})}"))


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
def search(
    query: str,
    limit: Annotated[int, typer.Option("--limit", min=1, max=200)] = 50,
    offset: Annotated[int, typer.Option("--offset", min=0)] = 0,
) -> None:
    """Search current document titles, paths, content, tags, and categories."""
    _print_json(
        _request("GET", f"/search?{urlencode({'q': query, 'limit': limit, 'offset': offset})}")
    )


@app.command()
def create(
    title: Annotated[str, typer.Option("--title", "-t")],
    content: Annotated[str, typer.Option("--content", "-c")] = "",
    file: Annotated[Path | None, typer.Option("--file", "-f")] = None,
    path: Annotated[
        str | None, typer.Option("--path", help="Workspace-relative .md or .html path.")
    ] = None,
    content_type: Annotated[
        str, typer.Option("--content-type", help="text/markdown or text/html")
    ] = "text/markdown",
) -> None:
    """Create a text document, materialized only when --path is provided."""
    if file:
        content = file.read_text(encoding="utf-8")
    _print_json(
        _request(
            "POST",
            "/documents",
            body={
                "title": title,
                "content": content,
                "path": path,
                "content_type": content_type,
            },
        )
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
def move(
    document_id: str,
    path: str,
    expected_revision: Annotated[str, typer.Option("--expected-revision")],
    summary: Annotated[str | None, typer.Option("--summary")] = None,
) -> None:
    """Move a materialized document using an explicit expected revision."""
    _print_json(
        _request(
            "POST",
            f"/documents/{document_id}/move",
            body={
                "expected_revision_id": expected_revision,
                "path": path,
                "summary": summary,
            },
        )
    )


@app.command()
def tag(
    document_id: str,
    expected_metadata_version: Annotated[int, typer.Option("--expected-metadata-version")],
    tag_id: Annotated[list[str] | None, typer.Option("--tag-id")] = None,
    category: Annotated[str | None, typer.Option("--category")] = None,
) -> None:
    """Replace a document's category and tag assignments."""
    _print_json(
        _request(
            "PATCH",
            f"/documents/{document_id}/metadata",
            body={
                "expected_metadata_version": expected_metadata_version,
                "category": category,
                "tag_ids": tag_id or [],
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
def diff(
    document_id: str,
    from_revision: Annotated[str, typer.Option("--from-revision")],
    to_revision: Annotated[str | None, typer.Option("--to-revision")] = None,
) -> None:
    """Compare two immutable document revisions."""
    parameters = {"from_revision_id": from_revision}
    if to_revision:
        parameters["to_revision_id"] = to_revision
    _print_json(_request("GET", f"/documents/{document_id}/diff?{urlencode(parameters)}"))


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


@app.command()
def publish(
    document_id: str,
    slug: str,
    access: Annotated[
        str, typer.Option("--access", help="private, public, or unlisted")
    ] = "private",
) -> None:
    """Publish a document at a stable slug."""
    _print_json(
        _request(
            "POST",
            "/publications",
            body={"document_id": document_id, "slug": slug, "access_policy": access},
        )
    )


@app.command("publications")
def list_publications() -> None:
    """List document publications and their current policy."""
    _print_json(_request("GET", "/publications"))


@app.command()
def unpublish(
    publication_id: str,
    expected_version: Annotated[int, typer.Option("--expected-version", min=0)],
) -> None:
    """Disable a publication and revoke its unlisted credentials."""
    _print_json(
        _request(
            "DELETE",
            f"/publications/{publication_id}?{urlencode({'expected_version': expected_version})}",
        )
    )


@app.command("expose-revision")
def expose_revision(publication_id: str, revision_id: str) -> None:
    """Expose one historical revision through its non-enumerable ID."""
    _print_json(
        _request(
            "POST",
            f"/publications/{publication_id}/revisions",
            body={"revision_id": revision_id},
        )
    )


@app.command("rotate-publication-token")
def rotate_publication_token(publication_id: str) -> None:
    """Rotate and disclose a replacement unlisted-publication token once."""
    _print_json(_request("POST", f"/publications/{publication_id}/rotate-token"))


if __name__ == "__main__":
    app()
