#!/usr/bin/env python
"""Seed multi-modal verification data into a running Sangam instance."""

from __future__ import annotations

import argparse
import io
import json
import time
import uuid
from pathlib import Path

import httpx
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject


def generate_pdf(text: str) -> bytes:
    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref})}
    )
    stream = DecodedStreamObject()
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream.set_data(f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode("ascii"))
    page[NameObject("/Contents")] = writer._add_object(stream)
    output = io.BytesIO()
    writer.write(output)
    return output.getvalue()


def seed(base_url: str, output_path: Path | None = None) -> dict:
    client = httpx.Client(timeout=20.0)

    # 1. Seed Markdown document
    md_payload = {
        "title": "Getting Started with Sangam",
        "path": "guides/getting-started.md",
        "content": """# Getting Started with Sangam

Welcome to Sangam, the durable local document workspace.

## Key Capabilities
- **Durable Revisions**: Every change creates an immutable revision hash.
- **Disk Materialization**: Changes are synced cleanly to the workspace filesystem.
- **FTS5 Search**: Instant search: `vector-search-term`, `sqlite-wal-engine`.

```typescript
export function calculateDigest(content: string): string {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
}
```
""",
    }
    md_resp = client.post(
        f"{base_url}/documents",
        json=md_payload,
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    md_doc = md_resp.json() if md_resp.status_code in (200, 201) else {"error": md_resp.text}

    # 2. Seed HTML document for trusted preview
    html_payload = {
        "title": "Interactive System Dashboard",
        "path": "widgets/dashboard.html",
        "content_type": "text/html",
        "content": """<!DOCTYPE html>
<html>
<head>
  <title>System Dashboard</title>
  <style>
    body { font-family: sans-serif; background: #0b0f19; color: #f3f4f6; padding: 20px; }
    .card { background: #1f2937; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
    .status { color: #10b981; font-weight: bold; }
  </style>
</head>
<body>
  <h1>Sangam Live Telemetry</h1>
  <div class="card">
    <p>Sandbox Status: <span class="status">ISOLATED</span></p>
    <p>Search token: <code>telemetry-html-widget</code></p>
  </div>
</body>
</html>
""",
    }
    html_resp = client.post(
        f"{base_url}/documents",
        json=html_payload,
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    html_doc = (
        html_resp.json() if html_resp.status_code in (200, 201) else {"error": html_resp.text}
    )

    # 3. Generate & upload PDF document
    pdf_bytes = generate_pdf(
        "Sangam Research: Distributed consensus with raft-protocol-state and vector clocks."
    )
    pdf_resp = client.post(
        f"{base_url}/pdfs",
        params={"title": "Distributed Consensus Research", "path": "research/consensus.pdf"},
        content=pdf_bytes,
        headers={
            "Content-Type": "application/pdf",
            "Idempotency-Key": str(uuid.uuid4()),
        },
    )
    pdf_doc = pdf_resp.json() if pdf_resp.status_code in (200, 201) else {"error": pdf_resp.text}

    # 4. Issue scoped agent token
    token_payload = {
        "actor_id": "agent:verification-runner",
        "display_name": "Verification Runner",
        "label": "seed verification token",
        "scopes": [
            {"capability": "read", "path_prefix": None},
            {"capability": "search", "path_prefix": None},
        ],
    }
    token_resp = client.post(f"{base_url}/agent-tokens", json=token_payload)
    token_data = token_resp.json() if token_resp.status_code == 201 else {"error": token_resp.text}

    # 5. Verify search indexes
    time.sleep(0.3)
    s_md = client.get(f"{base_url}/search", params={"q": "vector-search-term"}).json()
    s_html = client.get(f"{base_url}/search", params={"q": "telemetry-html-widget"}).json()

    manifest = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "markdown_document": {
            "id": md_doc.get("document_id"),
            "path": md_doc.get("path"),
            "status": "created" if "document_id" in md_doc else "failed",
        },
        "html_document": {
            "id": html_doc.get("document_id"),
            "path": html_doc.get("path"),
            "status": "created" if "document_id" in html_doc else "failed",
        },
        "pdf_document": {
            "id": pdf_doc.get("document_id"),
            "path": pdf_doc.get("path"),
            "status": "imported" if "document_id" in pdf_doc else "failed",
        },
        "agent_token": {
            "actor_id": token_data.get("actor_id"),
            "status": "issued" if "token" in token_data else "failed",
        },
        "verification_search": {
            "markdown_hits": len(s_md) if isinstance(s_md, list) else len(s_md.get("results", [])),
            "html_hits": len(s_html)
            if isinstance(s_html, list)
            else len(s_html.get("results", [])),
        },
    }

    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed multi-modal verification data")
    parser.add_argument("target", nargs="?", default=None, help="Port number or full API base URL")
    parser.add_argument("--url", default=None, help="Base API URL")
    parser.add_argument("--output", type=Path, default=None, help="Output manifest JSON path")
    args = parser.parse_args()

    target = args.url or args.target or "http://127.0.0.1:8765/api/v1"
    if target.isdigit() or not target.startswith("http"):
        base_url = f"http://127.0.0.1:{target}/api/v1"
    else:
        base_url = target.rstrip("/")
        if not base_url.endswith("/api/v1"):
            base_url = f"{base_url}/api/v1"

    manifest = seed(base_url, args.output)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
