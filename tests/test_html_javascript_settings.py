from __future__ import annotations

from fastapi.testclient import TestClient


def issue_agent_token(client: TestClient) -> str:
    response = client.post(
        "/api/v1/agent-tokens",
        json={
            "actor_id": "agent:html-settings-test",
            "display_name": "HTML settings test",
            "label": "HTML settings test token",
            "scopes": [
                {"capability": "read", "path_prefix": None},
                {"capability": "publish", "path_prefix": None},
            ],
        },
    )
    assert response.status_code == 201
    return response.json()["token"]


def create_html(client: TestClient) -> dict:
    response = client.post(
        "/api/v1/documents",
        headers={"Idempotency-Key": "html-js-source"},
        json={
            "title": "Interactive fixture",
            "content_type": "text/html",
            "content": (
                '<p id="result">not run</p><script>result.textContent="JavaScript ran"</script>'
            ),
        },
    )
    assert response.status_code == 201
    return response.json()


def test_html_javascript_is_enabled_by_default_and_controls_preview_grants(
    client: TestClient,
) -> None:
    document = create_html(client)
    current = client.get("/api/v1/settings/html-javascript")
    assert current.status_code == 200
    assert current.json()["enabled"] is True
    assert current.json()["version"] == 1

    grant = client.post(
        f"/api/v1/documents/{document['document_id']}/trusted-preview",
        params={"revision_id": document["current_revision_id"]},
    )
    assert grant.status_code == 200

    disabled = client.put(
        "/api/v1/settings/html-javascript",
        json={"expected_version": 1, "enabled": False},
    )
    assert disabled.status_code == 200
    assert disabled.json()["enabled"] is False
    assert disabled.json()["version"] == 2

    revoked = client.get(
        "/api/v1/trusted-previews/content",
        headers={"Authorization": f"Sangam-Preview {grant.json()['token']}"},
    )
    assert revoked.status_code == 404
    blocked = client.post(
        f"/api/v1/documents/{document['document_id']}/trusted-preview",
        params={"revision_id": document["current_revision_id"]},
    )
    assert blocked.status_code == 422

    enabled = client.put(
        "/api/v1/settings/html-javascript",
        json={"expected_version": 2, "enabled": True},
    )
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True
    assert enabled.json()["version"] == 3


def test_only_the_human_administrator_can_change_html_javascript_policy(
    client: TestClient,
) -> None:
    bearer = issue_agent_token(client)
    denied = client.put(
        "/api/v1/settings/html-javascript",
        headers={"Authorization": f"Bearer {bearer}"},
        json={"expected_version": 1, "enabled": False},
    )
    assert denied.status_code == 403
    assert client.get("/api/v1/settings/html-javascript").json()["enabled"] is True


def test_publication_includes_an_isolated_runtime_grant_when_enabled(client: TestClient) -> None:
    document = create_html(client)
    publication = client.post(
        "/api/v1/publications",
        headers={"Idempotency-Key": "html-js-publication"},
        json={
            "document_id": document["document_id"],
            "slug": "interactive-fixture",
            "access_policy": "public",
        },
    )
    assert publication.status_code == 201
    content = client.get("/api/v1/publications/interactive-fixture/content")
    assert content.status_code == 200
    payload = content.json()
    assert payload["javascript_enabled"] is True
    assert payload["interactive_preview"]["token"]
    assert payload["interactive_preview"]["url"].endswith("/trusted-preview/")

    client.put(
        "/api/v1/settings/html-javascript",
        json={"expected_version": 1, "enabled": False},
    )
    static_content = client.get("/api/v1/publications/interactive-fixture/content").json()
    assert static_content["javascript_enabled"] is False
    assert static_content["interactive_preview"] is None
