from __future__ import annotations

import json
from typing import Any

import pytest

from sangam.errors import IntegrationError, ValidationError
from sangam.karakeep_extraction import KarakeepExtractor
from sangam.karakeep_gateway import KarakeepClient, KarakeepSourceBookmark


class StubResponse:
    def __init__(self, payload: object) -> None:
        self.payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> object:
        return self.payload


def bookmark_payload(**overrides: Any) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": "bookmark-1",
        "createdAt": "2026-07-01T10:00:00Z",
        "title": "Typed boundary",
        "tags": [{"name": "Research"}],
        "assets": [{"id": "asset-1", "assetType": "fullPageArchive"}],
        "content": {
            "type": "link",
            "url": "https://example.com/typed",
            "htmlContent": "<p>Validated content.</p>",
        },
    }
    payload.update(overrides)
    return payload


def test_gateway_returns_typed_bookmarks(monkeypatch: pytest.MonkeyPatch) -> None:
    payload = bookmark_payload()
    monkeypatch.setattr("httpx.get", lambda *args, **kwargs: StubResponse(payload))
    client = KarakeepClient(
        base_url="https://karakeep.example/api/v1", api_key="secret", timeout_seconds=5
    )

    bookmark = client.bookmark("bookmark-1")

    assert isinstance(bookmark, KarakeepSourceBookmark)
    assert bookmark.tags == ("Research",)
    assert bookmark.assets[0].asset_id == "asset-1"
    assert json.loads(bookmark.source_payload_json)["id"] == "bookmark-1"


def test_gateway_rejects_invalid_payload_at_boundary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("httpx.get", lambda *args, **kwargs: StubResponse({"id": "bookmark-1"}))
    client = KarakeepClient(
        base_url="https://karakeep.example/api/v1", api_key="secret", timeout_seconds=5
    )

    with pytest.raises(IntegrationError, match="invalid bookmark response"):
        client.bookmark("bookmark-1")


def test_extractor_is_pure_and_enforces_source_limit() -> None:
    payload = bookmark_payload()
    bookmark = KarakeepSourceBookmark(
        bookmark_id="bookmark-1",
        title="Typed boundary",
        content_type="link",
        source_url="https://example.com/typed",
        author=None,
        created_at="2026-07-01T10:00:00Z",
        modified_at=None,
        tags=("Research",),
        assets=(),
        source_html="<p>Validated content.</p><script>ignored()</script>",
        source_text="",
        fallback_text="",
        source_payload_json=json.dumps(payload),
    )

    snapshot = KarakeepExtractor(max_source_bytes=10_000).extract(bookmark)

    assert "Validated content" in snapshot.extracted_markdown
    assert "ignored" not in snapshot.extracted_markdown
    assert "Karakeep bookmark: `bookmark-1`" in snapshot.extracted_markdown
    with pytest.raises(ValidationError, match="configured import limit"):
        KarakeepExtractor(max_source_bytes=10).extract(bookmark)
