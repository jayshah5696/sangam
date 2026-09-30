"""Drive conditional writes, scoped access, and audit export over real HTTP."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx


def main() -> None:
    base = os.environ["SANGAM_API_URL"] + "/api/v1"
    evidence: list[dict[str, object]] = []

    def request(method, path, expected, *, body=None, headers=None):
        with httpx.Client(base_url=base, timeout=30) as client:
            result = client.request(method, path, json=body, headers=headers)
        evidence.append(
            {
                "method": method,
                "path": path,
                "status": result.status_code,
                "expected": expected,
                "operation_id": result.headers.get("X-Operation-ID"),
            }
        )
        assert result.status_code == expected, (method, path, result.status_code, result.text)
        return result

    def mutation_headers(**extra):
        return {"Idempotency-Key": uuid.uuid4().hex, **extra}

    def create(path, *, content="baseline", content_type="text/markdown"):
        return request(
            "POST",
            "/documents",
            201,
            body={
                "path": path,
                "title": "Security proof",
                "content": content,
                "content_type": content_type,
            },
            headers=mutation_headers(),
        )

    def issue(actor, prefix, capabilities):
        result = request(
            "POST",
            "/agent-tokens",
            201,
            body={
                "actor_id": actor,
                "display_name": actor,
                "label": "ephemeral verification",
                "scopes": [{"capability": cap, "path_prefix": prefix} for cap in capabilities],
            },
        )
        return {"Authorization": "Bearer " + result.json()["token"]}

    for scope in ["//", "*/*", "**/**", "docs/*/"]:
        request(
            "POST",
            "/agent-tokens",
            422,
            body={
                "actor_id": "agent:invalid",
                "display_name": "Invalid",
                "label": "invalid",
                "scopes": [{"capability": "read", "path_prefix": scope}],
            },
        )
    agents = [
        issue(
            f"agent:security-proof-{i}",
            "proof/*",
            ("read", "create", "update", "move", "delete", "restore", "tag"),
        )
        for i in range(2)
    ]
    document = create("proof/nested/item.md")
    url = "/documents/" + document.json()["document_id"]
    etag = request("GET", url, 200, headers=agents[0]).headers["ETag"]
    request(
        "PATCH",
        url,
        412,
        body={"content": "rejected"},
        headers=mutation_headers(**agents[0], **{"If-Match": '"*"'}),
    )
    request(
        "PATCH",
        url,
        412,
        body={"content": "rejected"},
        headers=mutation_headers(**agents[0], **{"If-Match": "W/" + etag}),
    )
    request(
        "PATCH",
        url,
        422,
        body={"content": "rejected"},
        headers=mutation_headers(**agents[0], **{"If-Match": "malformed"}),
    )
    request("GET", url, 304, headers={**agents[0], "If-None-Match": f'"a,b", W/{etag}'})
    for suffix in ["/raw", "/download"]:
        artifact = request("GET", url + suffix, 200, headers=agents[0])
        request(
            "GET",
            url + suffix,
            304,
            headers={**agents[0], "If-None-Match": "W/" + artifact.headers["ETag"]},
        )

    start = threading.Barrier(2)

    def contender(i):
        start.wait(timeout=10)
        with httpx.Client(base_url=base, timeout=30) as client:
            return client.patch(
                url,
                json={"content": f"live-writer-{i}"},
                headers=mutation_headers(**agents[i], **{"If-Match": etag}),
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(contender, range(2)))
    statuses = sorted(result.status_code for result in results)
    assert statuses == [200, 412], statuses
    evidence.append({"concurrent_independent_agents": statuses})
    persisted = request("GET", url, 200, headers=agents[0])
    assert persisted.json()["content"] in {"live-writer-0", "live-writer-1"}
    assert (
        Path(os.environ["SANGAM_WORKSPACE_ROOT"], "proof/nested/item.md").read_text()
        == persisted.json()["content"]
    )
    request(
        "PATCH",
        url,
        409,
        body={
            "content": "body rejected",
            "expected_revision_id": document.json()["current_revision_id"],
        },
        headers=mutation_headers(**agents[0]),
    )
    replay_headers = mutation_headers(**agents[0], **{"If-Match": "*"})
    first = request("PATCH", url, 200, body={"content": "replay"}, headers=replay_headers)
    replay = request("PATCH", url, 200, body={"content": "replay"}, headers=replay_headers)
    assert first.json()["current_revision_id"] == replay.json()["current_revision_id"]
    request(
        "PATCH",
        url,
        409,
        body={"content": "replay"},
        headers={**replay_headers, "If-Match": '"changed"'},
    )

    tagged = request(
        "PATCH",
        url + "/metadata",
        200,
        body={
            "expected_metadata_version": first.json()["metadata_version"],
            "category": "proof",
            "tag_ids": [],
        },
        headers=mutation_headers(**agents[0], **{"If-Match": first.headers["ETag"]}),
    )
    assert tagged.json()["current_revision_id"] == first.json()["current_revision_id"]
    request("GET", url, 200, headers={**agents[0], "If-None-Match": first.headers["ETag"]})
    request(
        "PATCH",
        url + "/metadata",
        412,
        body={
            "expected_metadata_version": tagged.json()["metadata_version"],
            "category": "bad",
            "tag_ids": [],
        },
        headers=mutation_headers(**agents[0], **{"If-Match": first.headers["ETag"]}),
    )

    outside = create("private/denied.md")
    request(
        "PATCH",
        "/documents/" + outside.json()["document_id"],
        403,
        body={"content": "forbidden"},
        headers=mutation_headers(**agents[0], **{"If-Match": "malformed"}),
    )

    secrets = [
        "glpat-abcdefghijklmnop",
        "xoxb-1234567890-abcdefghij",
        "github_pat_abcdefghijklmnopqrstuv",
        "AKIA1234567890123456",
        "sgm_agt_98765",
        "sk-abcdefghijkl",
    ]
    audit_doc = create(
        "proof/" + secrets[0] + ".md",
        content="Ordinary text\n"
        + "\n".join(secrets)
        + "\n-----BEGIN PRIVATE KEY-----\nPRIVATE-MATERIAL\n-----END PRIVATE KEY-----",
    )
    with sqlite3.connect(os.environ["SANGAM_DATABASE_PATH"]) as connection:
        rows = connection.execute(
            "SELECT path, detail_json FROM operation_events WHERE resource_id = ?",
            (audit_doc.json()["document_id"],),
        ).fetchall()
        assert rows
        stored = json.dumps(rows)
        assert connection.execute("PRAGMA quick_check").fetchone()[0] == "ok"
    activity = request("GET", "/activity?actor_kind=human", 200)
    export = request("GET", "/activity/export.jsonl?actor_kind=human", 200)
    for text in [stored, activity.text, export.text]:
        assert "[REDACTED]" in text
        assert not any(secret in text for secret in [*secrets, "PRIVATE-MATERIAL"])
    report = {
        "ok": True,
        "checks": evidence,
        "sqlite_quick_check": "ok",
        "redaction_surfaces": ["persisted rows", "activity JSON", "JSONL"],
        "replay_revision": first.json()["current_revision_id"],
    }
    path = Path(os.environ["SANGAM_ARTIFACTS_DIR"]) / "security-api.json"
    path.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Live security API proof passed: {len(evidence)} observations; evidence: {path}")


if __name__ == "__main__":
    main()
