"""Seed only an isolated local MCP walkthrough; never print the bearer secret."""

from __future__ import annotations

import argparse
import os
from pathlib import Path

import httpx

from sangam.schemas import Document, IssuedAgentToken


def seed_demo(
    base_url: str, *, inference: bool = False
) -> tuple[Document, Document, Document, IssuedAgentToken]:
    with httpx.Client(base_url=base_url, timeout=30) as client:
        response = client.post(
            "/api/v1/documents",
            headers={"Idempotency-Key": "mcp-demo-document"},
            json={
                "title": "Sangam MCP walkthrough",
                "path": "mcp-demo/walkthrough.md",
                "content_type": "text/markdown",
                "content": (
                    "# Sangam MCP walkthrough\n\n"
                    "Search for walkthrough, open this document, and edit this paragraph.\n\n"
                    "Draft backup preserves unfinished work. Save commits a document revision.\n"
                ),
            },
        )
        response.raise_for_status()
        document = Document.model_validate(response.json())
        companion_response = client.post(
            "/api/v1/documents",
            headers={"Idempotency-Key": "mcp-demo-companion"},
            json={
                "title": "Walkthrough companion notes",
                "path": "mcp-demo/companion.md",
                "content_type": "text/markdown",
                "content": (
                    "# Companion notes\n\nFind walkthrough documents inside the App. "
                    "Open both documents and switch between their drafts.\n"
                ),
            },
        )
        companion_response.raise_for_status()
        companion = Document.model_validate(companion_response.json())
        pdf_response = client.post(
            "/api/v1/pdfs",
            params={"title": "Sangam PDF walkthrough", "path": "mcp-demo/walkthrough.pdf"},
            headers={"Idempotency-Key": "mcp-demo-pdf", "Content-Type": "application/pdf"},
            content=(
                Path(__file__).resolve().parent.parent / "frontend/e2e/assets/multipage.pdf"
            ).read_bytes(),
        )
        pdf_response.raise_for_status()
        pdf = Document.model_validate(pdf_response.json())
        guide = client.post(
            "/api/v1/documents",
            headers={"Idempotency-Key": "mcp-demo-skill"},
            json={
                "title": "Walkthrough review skill",
                "path": "mcp-demo/SKILL.md",
                "content_type": "text/markdown",
                "content": (
                    "---\nname: walkthrough-review\ndescription: Review walkthrough documents\n"
                    "sangam:\n  files:\n"
                    f"    references/companion.md: {companion.document_id}\n"
                    f"    references/paper.pdf: {pdf.document_id}\n---\n"
                    "Read [companion](references/companion.md) and [paper](references/paper.pdf).\n"
                    "Compare the documents before preparing the requested update.\n"
                ),
            },
        )
        guide.raise_for_status()
        client.post(
            "/api/v1/chat/skills", json={"document_id": guide.json()["document_id"]}
        ).raise_for_status()
        scopes = [
            {"capability": capability, "path_prefix": "mcp-demo/"}
            for capability in ("read", "search", "create", "update")
        ]
        if inference:
            scopes.append({"capability": "inference", "path_prefix": None})
        issued = client.post(
            "/api/v1/agent-tokens",
            json={
                "actor_id": "agent:mcp-demo",
                "display_name": "Local MCP walkthrough",
                "label": "Disposable local MCP key",
                "scopes": scopes,
            },
        )
        issued.raise_for_status()
        return document, companion, pdf, IssuedAgentToken.model_validate(issued.json())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--inference", choices=("true", "false"), default="false")
    options = parser.parse_args()
    root = Path(os.environ["SANGAM_VERIFY_RUN_DIR"])
    if not root.name.startswith("sangam-verify-"):
        raise RuntimeError("The MCP demo requires the isolated verification instance.")
    document, companion, pdf, issued = seed_demo(
        os.environ["SANGAM_API_URL"], inference=options.inference == "true"
    )
    key_path = root / "mcp-demo-key.txt"
    descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(issued.token)
    print(f"MCP host: {os.environ['SANGAM_API_URL']}/mcp-host.html")
    print(f"Disposable scoped key file: {key_path}")
    print(f"Walkthrough document: {document.document_id}")
    print(f"Companion document: {companion.document_id}")
    print(f"PDF document: {pdf.document_id}")
    print("Paste the file's contents into Sangam API key, connect, then search for walkthrough.")
    if options.inference == "true":
        print("Sending an App assistant message invokes Sangam's configured model with this key.")
    print("The disposable instance stays running until you press Ctrl+C.")


if __name__ == "__main__":
    main()
