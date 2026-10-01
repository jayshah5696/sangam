"""Saved views keep a search query and filters for the workspace, on every device."""

from __future__ import annotations

from conftest import issue_agent_token
from fastapi.testclient import TestClient

from sangam.api import create_app
from sangam.config import Settings


def save(client: TestClient, name: str, **filters: object):
    return client.post(
        "/api/v1/saved-views",
        json={"name": name, "filters": {"query": "", "sort": "relevance", **filters}},
    )


def test_a_saved_view_persists_across_restarts(settings: Settings) -> None:
    with TestClient(create_app(settings)) as client:
        created = save(client, "Recent PDFs", sort="updated", content_type="application/pdf")
        assert created.status_code == 200, created.text
        view = created.json()
        assert view["name"] == "Recent PDFs"
        assert view["filters"] == {
            "query": "",
            "sort": "updated",
            "tag_id": None,
            "content_type": "application/pdf",
        }
    with TestClient(create_app(settings)) as restarted:
        assert restarted.get("/api/v1/saved-views").json() == [view]


def test_saving_the_same_name_replaces_the_view(client: TestClient) -> None:
    first = save(client, "Memory", query="memory").json()
    second = save(client, "  memory ", query="memory gb").json()
    assert second["view_id"] == first["view_id"]
    assert second["name"] == "memory"
    listed = client.get("/api/v1/saved-views").json()
    assert [view["filters"]["query"] for view in listed] == ["memory gb"]


def test_views_list_newest_first_and_delete(client: TestClient) -> None:
    older = save(client, "Older", query="a").json()
    newer = save(client, "Newer", query="b").json()
    assert [view["view_id"] for view in client.get("/api/v1/saved-views").json()] == [
        newer["view_id"],
        older["view_id"],
    ]
    assert client.delete(f"/api/v1/saved-views/{older['view_id']}").status_code == 204
    assert client.delete(f"/api/v1/saved-views/{older['view_id']}").status_code == 404
    assert [view["name"] for view in client.get("/api/v1/saved-views").json()] == ["Newer"]


def test_invalid_views_are_rejected(client: TestClient) -> None:
    assert save(client, "", query="x").status_code == 422
    assert save(client, "x" * 121).status_code == 422
    assert save(client, "bad\x00name").status_code == 422
    assert save(client, "Sort", sort="random").status_code == 422
    assert save(client, "Extra", unknown=True).status_code == 422


def test_saved_views_belong_to_the_workspace_owner(client: TestClient) -> None:
    token = issue_agent_token(client, actor_id="agent:viewer", capabilities=("read", "search"))
    auth = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/v1/saved-views", headers=auth).status_code == 403
    denied = client.post(
        "/api/v1/saved-views",
        json={"name": "Agent", "filters": {"query": "", "sort": "relevance"}},
        headers=auth,
    )
    assert denied.status_code == 403


def test_saving_and_deleting_are_audited(client: TestClient) -> None:
    view = save(client, "Audited", query="a").json()
    client.delete(f"/api/v1/saved-views/{view['view_id']}")
    events = client.get(
        "/api/v1/activity", params={"resource_type": "saved_view", "actor_kind": "human"}
    ).json()
    assert sorted(event["action"] for event in events) == ["delete_view", "save_view"]
