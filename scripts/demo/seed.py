"""Seed demo data into a local Sangam instance. Safe to re-run."""

import json
import secrets
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8000/api/v1"
_run = secrets.token_hex(4)
_n = [0]


def call(method, path, body=None, token=None):
    _n[0] += 1
    headers = {"Content-Type": "application/json", "Idempotency-Key": f"seed-{_run}-{_n[0]}"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as exc:
        print("FAILED", method, path, exc.code, exc.read()[:400])
        raise


def list_docs():
    with urllib.request.urlopen(BASE + "/documents?limit=200") as resp:
        return json.loads(resp.read())


def find_or_create(path, title, content, content_type="text/markdown"):
    for doc in list_docs():
        if doc["path"] == path:
            return doc
    return call(
        "POST",
        "/documents",
        {
            "title": title,
            "path": path,
            "content": content,
            "content_type": content_type,
        },
    )


doc1 = find_or_create(
    "research/rag-evaluation.md",
    "Evaluating RAG systems beyond cosine similarity",
    """# Evaluating RAG systems beyond cosine similarity

Retrieval quality is not a single number. A useful evaluation stack separates:

## Retrieval metrics

- **Recall@k** against a labeled gold set
- **nDCG** when relevance is graded, not binary
- Latency percentiles under realistic corpus sizes

## Generation faithfulness

Grounded-ness checks compare every claim in the answer against retrieved
context. Uncited claims are treated as failures, not style choices.

## The revision connection

An evaluation corpus is itself a document set. Storing it in Sangam means every
corpus change has a diff and an author.
""",
)

find_or_create(
    "projects/demo-notes.md",
    "Demo workspace notes",
    """# Demo workspace notes

This workspace exists to show Sangam's core loop:

1. Write Markdown in the editor.
2. Search it instantly with FTS5.
3. Compare revisions side by side and restore anything.
4. Publish a page when you are ready to share.

Every change here went through the same API that scoped agents use, so nothing
is special-cased for humans.
""",
)

html_doc = find_or_create(
    "agents/writing-style-rules-dashboard.html",
    "Writing style rules dashboard",
    """<!doctype html>
<html>
<head><meta charset="utf-8"><title>Writing style rules</title>
<style>
  body {
    font-family: -apple-system, sans-serif;
    margin: 2rem;
    background: #102a43;
    color: #f0f4f8;
  }
  h1 { color: #9fb3c8; }
  .rule {
    border-left: 4px solid #2f80ed;
    padding: 0.75rem 1rem;
    margin: 0.5rem 0;
    background: #243b53;
  }
  code { color: #f9c74f; }
</style></head>
<body>
<h1>Writing style rules dashboard</h1>
<div class="rule">Prefer short sentences. One idea each.</div>
<div class="rule">
  Name the actor: <code>the service retries</code>,
  not <code>a retry occurs</code>.
</div>
<div class="rule">Show the diff, then explain it.</div>
</body>
</html>
""",
    content_type="text/html",
)

pubs = call("GET", "/publications/by-document/" + html_doc["document_id"])
if not pubs:
    call(
        "POST",
        "/publications",
        {
            "document_id": html_doc["document_id"],
            "slug": "writing-style-rules",
            "access_policy": "public",
        },
    )

issued = call(
    "POST",
    "/agent-tokens",
    {
        "actor_id": "agent:researcher",
        "display_name": "Researcher agent",
        "label": "demo research agent",
        "scopes": [{"capability": "read"}],
        "expires_at": None,
    },
)
agent_token = issued["token"]

agent_content = (
    "# Notes written by an agent\n\n"
    "This file was created by `agent:researcher` using a scoped bearer token.\n"
    "The token can only read documents under its scope, and every operation\n"
    "shows up in the activity ledger with its own actor id.\n"
)

try:
    created = call(
        "POST",
        "/documents",
        {
            "title": "Notes written by an agent",
            "path": "research/agent-notes-" + _run + ".md",
            "content_type": "text/markdown",
            "content": agent_content,
        },
        token=agent_token,
    )
except Exception:
    print("Agent creation denied as expected for read-only scope")
    created = None

print("seeded ok:", doc1["document_id"], html_doc["document_id"])
