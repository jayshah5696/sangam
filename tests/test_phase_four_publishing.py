from __future__ import annotations

import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings
from sangam.errors import AuthenticationError
from sangam.security import CloudflareAccessVerifier


def mutation_headers(key: str, authorization: str | None = None) -> dict[str, str]:
    result = {"Idempotency-Key": key}
    if authorization:
        result["Authorization"] = authorization
    return result


def create_document(
    client: TestClient,
    *,
    title: str,
    content: str,
    key: str,
    path: str | None = None,
    content_type: str = "text/markdown",
) -> dict[str, object]:
    response = client.post(
        "/api/v1/documents",
        headers=mutation_headers(key),
        json={
            "title": title,
            "content": content,
            "path": path,
            "content_type": content_type,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_html_document_uses_the_normal_revision_materialization_and_reindex_spine(
    client: TestClient, settings: Settings
) -> None:
    html = "<main><h1>Interactive report</h1><script>window.ran = true</script></main>"
    created = create_document(
        client,
        title="Interactive report",
        content=html,
        path="reports/interactive.html",
        content_type="text/html",
        key="create-html",
    )
    assert created["content_type"] == "text/html"
    assert created["trust_level"] == "untrusted"
    assert (settings.workspace_root / "reports" / "interactive.html").read_text() == html

    mismatch = client.post(
        "/api/v1/documents",
        headers=mutation_headers("html-mismatch"),
        json={
            "title": "Wrong suffix",
            "content": html,
            "path": "reports/wrong.md",
            "content_type": "text/html",
        },
    )
    assert mismatch.status_code == 422
    assert mismatch.json()["error"]["code"] == "validation_error"

    imported_path = settings.workspace_root / "imports" / "outside.html"
    imported_path.parent.mkdir(parents=True)
    imported_path.write_text("<p>Imported while stopped</p>", encoding="utf-8")
    report = client.post("/api/v1/reconciliation/scan").json()
    conflict = next(item for item in report["conflicts"] if item["path"] == "imports/outside.html")
    imported = client.post("/api/v1/reconciliation/reindex", json={"path": conflict["path"]}).json()
    assert imported["content_type"] == "text/html"


def test_publication_and_trust_share_the_canonical_idempotency_namespace(
    client: TestClient,
) -> None:
    document = create_document(
        client,
        title="Canonical mutations",
        content="<h1>Canonical</h1>",
        content_type="text/html",
        key="canonical-source",
    )
    trusted = client.patch(
        f"/api/v1/documents/{document['document_id']}/trust",
        headers=mutation_headers("shared-phase-four-key"),
        json={"expected_trust_version": 0, "trust_level": "trusted_interactive"},
    )
    assert trusted.status_code == 200

    collision = client.post(
        "/api/v1/publications",
        headers=mutation_headers("shared-phase-four-key"),
        json={
            "document_id": document["document_id"],
            "slug": "canonical-collision",
            "access_policy": "public",
        },
    )
    assert collision.status_code == 409
    assert collision.json()["error"]["code"] == "idempotency_conflict"

    published = client.post(
        "/api/v1/publications",
        headers=mutation_headers("canonical-publication"),
        json={
            "document_id": document["document_id"],
            "slug": "canonical",
            "access_policy": "public",
        },
    )
    assert published.status_code == 201

    with client.app.state.services.documents.database.connection() as connection:
        phase_four_table = connection.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'phase_four_idempotency_keys'
            """
        ).fetchone()
        rows = connection.execute(
            """
            SELECT operation, resource_type FROM mutation_idempotency_keys
            WHERE idempotency_key IN ('shared-phase-four-key', 'canonical-publication')
            ORDER BY operation
            """
        ).fetchall()
    assert phase_four_table is None
    assert [tuple(row) for row in rows] == [
        ("document_trust", "document"),
        ("publish", "publication"),
    ]


def test_publication_latest_revision_and_explicit_exposure_are_non_enumerable(
    client: TestClient,
) -> None:
    document = create_document(
        client,
        title="Published notes",
        content="# First\n",
        path="published/notes.md",
        key="publish-source",
    )
    first_revision = str(document["current_revision_id"])
    created = client.post(
        "/api/v1/publications",
        headers=mutation_headers("publish-notes"),
        json={"document_id": document["document_id"], "slug": "notes", "access_policy": "public"},
    )
    assert created.status_code == 201, created.text
    publication = created.json()
    assert publication["active"] is True

    latest = client.get("/api/v1/publications/notes/content")
    assert latest.status_code == 200
    assert latest.headers["Cache-Control"] == "no-store, max-age=0"
    assert latest.json()["revision_id"] == first_revision

    updated = client.patch(
        f"/api/v1/documents/{document['document_id']}",
        headers=mutation_headers("update-published"),
        json={
            "expected_revision_id": first_revision,
            "content": "# Second\n",
        },
    ).json()
    latest = client.get("/api/v1/publications/notes/content").json()
    assert latest["content"] == "# Second\n"
    assert latest["revision_id"] == updated["current_revision_id"]

    hidden = client.get("/api/v1/publications/notes/content", params={"revision": first_revision})
    assert hidden.status_code == 404
    assert hidden.json()["error"]["message"] == "Publication not found"

    exposed = client.post(
        f"/api/v1/publications/{publication['publication_id']}/revisions",
        headers=mutation_headers("expose-first"),
        json={"revision_id": first_revision},
    )
    assert exposed.status_code == 200
    historical = client.get(
        "/api/v1/publications/notes/content", params={"revision": first_revision}
    )
    assert historical.status_code == 200
    assert historical.json()["content"] == "# First\n"
    assert historical.json()["is_latest"] is False


def test_unlisted_token_rotation_and_unpublish_revoke_access(client: TestClient) -> None:
    document = create_document(
        client,
        title="Quiet link",
        content="# Shared carefully\n",
        key="unlisted-source",
    )
    created = client.post(
        "/api/v1/publications",
        headers=mutation_headers("publish-unlisted"),
        json={
            "document_id": document["document_id"],
            "slug": "quiet-link",
            "access_policy": "unlisted",
        },
    ).json()
    token = created["token"]
    assert token.startswith("sgm_pub_")
    assert client.get("/api/v1/publications/quiet-link/content").status_code == 404
    assert (
        client.get(
            "/api/v1/publications/quiet-link/content",
            headers={"Authorization": f"Sangam-Publication {token}"},
        ).status_code
        == 200
    )

    rotated = client.post(
        f"/api/v1/publications/{created['publication_id']}/rotate-token",
        headers=mutation_headers("rotate-unlisted"),
    ).json()
    replacement = rotated["token"]
    assert replacement != token
    assert (
        client.get(
            "/api/v1/publications/quiet-link/content",
            headers={"Authorization": f"Sangam-Publication {token}"},
        ).status_code
        == 404
    )
    assert (
        client.get(
            "/api/v1/publications/quiet-link/content",
            headers={"Authorization": f"Sangam-Publication {replacement}"},
        ).status_code
        == 200
    )

    unpublished = client.delete(
        f"/api/v1/publications/{created['publication_id']}",
        params={"expected_version": rotated["version"]},
        headers=mutation_headers("unpublish-unlisted"),
    )
    assert unpublished.status_code == 200
    assert unpublished.json()["active"] is False
    assert (
        client.get(
            "/api/v1/publications/quiet-link/content",
            headers={"Authorization": f"Sangam-Publication {replacement}"},
        ).status_code
        == 404
    )


def test_publication_assets_require_policy_revision_and_exact_source_reference(
    client: TestClient, settings: Settings
) -> None:
    asset = settings.workspace_root / "published" / "images" / "chart.svg"
    asset.parent.mkdir(parents=True, exist_ok=True)
    asset.write_text('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>')
    document = create_document(
        client,
        title="Report with chart",
        content="# Report\n\n![Chart](images/chart.svg)\n",
        path="published/report.md",
        key="asset-source",
    )
    publication = client.post(
        "/api/v1/publications",
        headers=mutation_headers("publish-assets"),
        json={
            "document_id": document["document_id"],
            "slug": "asset-report",
            "access_policy": "public",
        },
    )
    assert publication.status_code == 201
    served = client.get(
        "/api/v1/publications/asset-report/asset",
        params={"revision": document["current_revision_id"], "path": "images/chart.svg"},
    )
    assert served.status_code == 200
    assert served.headers["Content-Type"].startswith("image/svg+xml")
    assert b"<circle" in served.content
    assert (
        client.get(
            "/api/v1/publications/asset-report/asset",
            params={"revision": document["current_revision_id"], "path": "not-linked.svg"},
        ).status_code
        == 404
    )
    assert (
        client.get(
            "/api/v1/publications/asset-report/asset",
            params={"revision": document["current_revision_id"], "path": "../../.env"},
        ).status_code
        == 404
    )


def test_publish_capability_is_path_scoped_and_trust_remains_human_only(client: TestClient) -> None:
    allowed = create_document(
        client,
        title="Agent report",
        content="# Agent report\n",
        path="agents/report.md",
        key="agent-publish-allowed",
    )
    denied = create_document(
        client,
        title="Private report",
        content="# Private report\n",
        path="projects/private.md",
        key="agent-publish-denied",
    )
    issued = client.post(
        "/api/v1/agent-tokens",
        json={
            "actor_id": "agent:publisher",
            "display_name": "Publisher",
            "label": "Publication scope",
            "scopes": [{"capability": "publish", "path_prefix": "agents"}],
        },
    ).json()
    bearer = f"Bearer {issued['token']}"
    published = client.post(
        "/api/v1/publications",
        headers=mutation_headers("agent-publish", bearer),
        json={
            "document_id": allowed["document_id"],
            "slug": "agent-report",
            "access_policy": "public",
        },
    )
    assert published.status_code == 201
    outside = client.post(
        "/api/v1/publications",
        headers=mutation_headers("agent-publish-outside", bearer),
        json={
            "document_id": denied["document_id"],
            "slug": "private-report",
            "access_policy": "public",
        },
    )
    assert outside.status_code == 403

    html = create_document(
        client,
        title="Interactive",
        content="<script>window.ok = true</script>",
        content_type="text/html",
        key="trust-source",
    )
    trust = client.patch(
        f"/api/v1/documents/{html['document_id']}/trust",
        headers=mutation_headers("agent-trust", bearer),
        json={"expected_trust_version": 0, "trust_level": "trusted_interactive"},
    )
    assert trust.status_code == 403


def test_trusted_preview_uses_fragment_grant_restrictive_csp_and_live_trust_check(
    client: TestClient, settings: Settings
) -> None:
    image = settings.workspace_root / "interactive" / "preview.png"
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"trusted-preview-image")
    document = create_document(
        client,
        title="Interactive visualization",
        content=(
            '<script>window.previewRan = true</script><h1>Trusted</h1><img src="preview.png">'
        ),
        path="interactive/visual.html",
        content_type="text/html",
        key="preview-source",
    )
    trusted = client.patch(
        f"/api/v1/documents/{document['document_id']}/trust",
        headers=mutation_headers("trust-html"),
        json={"expected_trust_version": 0, "trust_level": "trusted_interactive"},
    )
    assert trusted.status_code == 200
    assert trusted.json()["trust_version"] == 1

    grant = client.post(
        f"/api/v1/documents/{document['document_id']}/trusted-preview",
        params={"revision_id": document["current_revision_id"]},
    ).json()
    assert grant["token"] not in grant["url"]
    assert "?" not in grant["url"]
    shell = client.get("/trusted-preview/")
    assert "location.hash" in shell.text
    assert "history.replaceState" in shell.text
    assert shell.headers["Referrer-Policy"] == "no-referrer"
    assert "frame-ancestors" in shell.headers["Content-Security-Policy"]
    assert client.get("/api/v1/health").headers["X-Content-Type-Options"] == "nosniff"

    rendered = client.get(
        "/api/v1/trusted-previews/content",
        headers={"Authorization": f"Sangam-Preview {grant['token']}", "Origin": "null"},
    )
    assert rendered.status_code == 200
    assert "window.previewRan = true" in rendered.text
    assert "default-src 'none'" in rendered.text
    assert "connect-src 'none'" in rendered.text
    assert rendered.headers["Cache-Control"] == "no-store, max-age=0"
    assert rendered.headers["Access-Control-Allow-Origin"] == "null"
    preview_asset = client.get(
        "/api/v1/trusted-previews/asset",
        params={"path": "preview.png"},
        headers={"Authorization": f"Sangam-Preview {grant['token']}", "Origin": "null"},
    )
    assert preview_asset.status_code == 200
    assert preview_asset.content == b"trusted-preview-image"
    assert preview_asset.headers["Access-Control-Allow-Origin"] == "null"
    assert (
        client.get(
            "/api/v1/trusted-previews/asset",
            params={"path": "not-in-document.png"},
            headers={"Authorization": f"Sangam-Preview {grant['token']}"},
        ).status_code
        == 404
    )

    tampered = grant["token"][:-1] + ("a" if grant["token"][-1] != "a" else "b")
    assert (
        client.get(
            "/api/v1/trusted-previews/content",
            headers={"Authorization": f"Sangam-Preview {tampered}"},
        ).status_code
        == 404
    )

    untrusted = client.patch(
        f"/api/v1/documents/{document['document_id']}/trust",
        headers=mutation_headers("untrust-html"),
        json={"expected_trust_version": 1, "trust_level": "untrusted"},
    )
    assert untrusted.status_code == 200
    assert (
        client.get(
            "/api/v1/trusted-previews/content",
            headers={"Authorization": f"Sangam-Preview {grant['token']}"},
        ).status_code
        == 404
    )

    retrusted = client.patch(
        f"/api/v1/documents/{document['document_id']}/trust",
        headers=mutation_headers("retrust-html"),
        json={"expected_trust_version": 2, "trust_level": "trusted_interactive"},
    )
    assert retrusted.status_code == 200
    assert retrusted.json()["trust_version"] == 3
    assert (
        client.get(
            "/api/v1/trusted-previews/content",
            headers={"Authorization": f"Sangam-Preview {grant['token']}"},
        ).status_code
        == 404
    )
    replacement_grant = client.post(
        f"/api/v1/documents/{document['document_id']}/trusted-preview",
        params={"revision_id": document["current_revision_id"]},
    ).json()
    assert (
        client.get(
            "/api/v1/trusted-previews/content",
            headers={"Authorization": f"Sangam-Preview {replacement_grant['token']}"},
        ).status_code
        == 200
    )

    with client.app.state.services.documents.database.connection() as connection:
        trust_events = connection.execute(
            "SELECT previous_level, next_level FROM document_trust_events ORDER BY created_at"
        ).fetchall()
    assert [tuple(event) for event in trust_events] == [
        ("untrusted", "trusted_interactive"),
        ("trusted_interactive", "untrusted"),
        ("untrusted", "trusted_interactive"),
    ]


def test_trusted_preview_cors_is_limited_to_opaque_preview_requests(client: TestClient) -> None:
    preflight = client.options(
        "/api/v1/trusted-previews/content",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert preflight.status_code == 204
    assert preflight.headers["Access-Control-Allow-Origin"] == "null"
    assert preflight.headers["Access-Control-Allow-Methods"] == "GET"
    assert preflight.headers["Access-Control-Allow-Headers"] == "Authorization"

    foreign_origin = client.options(
        "/api/v1/trusted-previews/content",
        headers={
            "Origin": "https://attacker.example",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert foreign_origin.status_code == 400
    assert foreign_origin.headers.get("Access-Control-Allow-Origin") is None

    unsafe_method = client.options(
        "/api/v1/trusted-previews/content",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert unsafe_method.status_code == 400
    assert unsafe_method.headers.get("Access-Control-Allow-Origin") is None

    unrelated = client.options(
        "/api/v1/health",
        headers={
            "Origin": "null",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert unrelated.status_code == 400
    assert unrelated.headers.get("Access-Control-Allow-Origin") is None


def test_private_publication_requires_trusted_proxy_identity(tmp_path: Path) -> None:
    settings = Settings(
        database_path=tmp_path / "database" / "sangam.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
        backups_enabled=False,
        frontend_dist=tmp_path / "missing",
        auth_mode="trusted_proxy",
        trusted_identity_header="X-Test-Identity",
        trusted_identity_value="jay@example.com",
    )
    trusted = {"X-Test-Identity": "jay@example.com"}
    with TestClient(create_app(settings)) as client:
        document_response = client.post(
            "/api/v1/documents",
            headers={**trusted, "Idempotency-Key": "private-source"},
            json={"title": "Private", "content": "# Private\n"},
        )
        assert document_response.status_code == 201
        document = document_response.json()
        publication = client.post(
            "/api/v1/publications",
            headers={**trusted, "Idempotency-Key": "private-publication"},
            json={
                "document_id": document["document_id"],
                "slug": "private",
                "access_policy": "private",
            },
        )
        assert publication.status_code == 201
        assert client.get("/api/v1/publications/private/content").status_code == 404
        assert (
            client.get("/api/v1/publications/private/content", headers=trusted).status_code == 200
        )


def test_expired_preview_grant_is_not_retrievable(client: TestClient, monkeypatch) -> None:
    document = create_document(
        client,
        title="Expiring",
        content="<script>window.expiring = true</script>",
        content_type="text/html",
        key="expiring-source",
    )
    client.patch(
        f"/api/v1/documents/{document['document_id']}/trust",
        headers=mutation_headers("trust-expiring"),
        json={"expected_trust_version": 0, "trust_level": "trusted_interactive"},
    )
    grant = client.post(
        f"/api/v1/documents/{document['document_id']}/trusted-preview",
        params={"revision_id": document["current_revision_id"]},
    ).json()
    monkeypatch.setattr(time, "time", lambda: 4_000_000_000)
    expired = client.get(
        "/api/v1/trusted-previews/content",
        headers={"Authorization": f"Sangam-Preview {grant['token']}"},
    )
    assert expired.status_code == 404


def test_cloudflare_access_verifier_checks_signature_issuer_audience_and_email(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    verifier = CloudflareAccessVerifier(
        team_domain="https://team.cloudflareaccess.com",
        audience="sangam-audience",
        allowed_email="jay@example.com",
    )

    class SigningKey:
        key = private_key.public_key()

    monkeypatch.setattr(verifier.jwks, "get_signing_key_from_jwt", lambda _token: SigningKey())
    now = datetime.now(UTC)

    def token(email: str, audience: str = "sangam-audience") -> str:
        return jwt.encode(
            {
                "iss": "https://team.cloudflareaccess.com",
                "aud": [audience],
                "email": email,
                "iat": now,
                "exp": now + timedelta(minutes=5),
            },
            private_key,
            algorithm="RS256",
        )

    assert verifier.verify(token("jay@example.com")) == "jay@example.com"
    with pytest.raises(AuthenticationError):
        verifier.verify(token("intruder@example.com"))
    with pytest.raises(AuthenticationError):
        verifier.verify(token("jay@example.com", audience="wrong-audience"))


def test_cloudflare_access_mode_maps_verified_assertion_to_local_human(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    verified: list[str] = []

    class FakeVerifier:
        def __init__(self, **_settings: str) -> None:
            pass

        def verify(self, raw_token: str) -> str:
            if raw_token != "verified-access-jwt":
                raise AuthenticationError("invalid")
            verified.append(raw_token)
            return "jay@example.com"

    monkeypatch.setattr("sangam.application.CloudflareAccessVerifier", FakeVerifier)
    settings = Settings(
        database_path=tmp_path / "database" / "sangam.sqlite3",
        workspace_root=tmp_path / "workspace",
        backup_root=tmp_path / "backups",
        backups_enabled=False,
        frontend_dist=tmp_path / "missing",
        auth_mode="cloudflare_access",
        cloudflare_access_team_domain="https://team.cloudflareaccess.com",
        cloudflare_access_audience="audience",
        cloudflare_access_email="jay@example.com",
    )
    with TestClient(create_app(settings)) as client:
        assert client.get("/api/v1/documents").status_code == 401
        accepted = client.get(
            "/api/v1/documents",
            headers={"Cf-Access-Jwt-Assertion": "verified-access-jwt"},
        )
        assert accepted.status_code == 200
        assert verified == ["verified-access-jwt"]
