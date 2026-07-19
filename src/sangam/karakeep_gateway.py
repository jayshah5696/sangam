from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Literal, Protocol
from urllib.parse import quote, urlsplit

import httpx
from pydantic import BaseModel, ConfigDict, Field
from pydantic import ValidationError as PydanticValidationError

from sangam.errors import IntegrationError
from sangam.schemas import KarakeepAsset, KarakeepBookmark


class _KarakeepContentPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str = "unknown"
    url: str | None = None
    sourceUrl: str | None = None
    title: str | None = None
    fileName: str | None = None
    author: str | None = None
    htmlContent: str | None = None
    text: str | None = None
    content: str | None = None
    description: str | None = None


class _KarakeepTagPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: str


class _KarakeepAssetPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    assetType: str = "unknown"
    fileName: str | None = None


class _KarakeepBookmarkPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str
    createdAt: str
    modifiedAt: str | None = None
    title: str | None = None
    summary: str | None = None
    note: str | None = None
    tags: list[_KarakeepTagPayload] = Field(default_factory=list)
    assets: list[_KarakeepAssetPayload] = Field(default_factory=list)
    content: _KarakeepContentPayload | None = None


class _KarakeepSearchPayload(BaseModel):
    model_config = ConfigDict(extra="ignore")

    bookmarks: list[_KarakeepBookmarkPayload]
    nextCursor: str | None = None


@dataclass(frozen=True)
class KarakeepSourceBookmark:
    bookmark_id: str
    title: str
    content_type: Literal["link", "text", "asset", "unknown"]
    source_url: str | None
    author: str | None
    created_at: str
    modified_at: str | None
    tags: tuple[str, ...]
    assets: tuple[KarakeepAsset, ...]
    source_html: str
    source_text: str
    fallback_text: str
    source_payload_json: str

    def summary(self) -> KarakeepBookmark:
        return KarakeepBookmark(
            bookmark_id=self.bookmark_id,
            title=self.title,
            content_type=self.content_type,
            source_url=self.source_url,
            author=self.author,
            created_at=self.created_at,
            modified_at=self.modified_at,
            tags=list(self.tags),
            assets=list(self.assets),
        )


@dataclass(frozen=True)
class KarakeepSourcePage:
    bookmarks: tuple[KarakeepSourceBookmark, ...]
    next_cursor: str | None


class KarakeepGateway(Protocol):
    def health(self) -> None: ...

    def search(self, *, query: str, limit: int, cursor: str | None) -> KarakeepSourcePage: ...

    def bookmark(self, bookmark_id: str) -> KarakeepSourceBookmark: ...


class KarakeepClient:
    """Validate Karakeep HTTP payloads and expose domain-shaped responses."""

    def __init__(self, *, base_url: str, api_key: str, timeout_seconds: float) -> None:
        normalized_url = base_url.strip().rstrip("/")
        if not normalized_url.startswith(("http://", "https://")):
            raise ValueError("Karakeep base URL must use HTTP or HTTPS")
        self.base_url = normalized_url
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds

    def health(self) -> None:
        self._request_json("/bookmarks", params={"limit": 1})

    def search(self, *, query: str, limit: int, cursor: str | None) -> KarakeepSourcePage:
        params: dict[str, str | int | bool] = {
            "q": query,
            "limit": limit,
            "includeContent": False,
        }
        if cursor:
            params["cursor"] = cursor
        raw = self._request_json("/bookmarks/search", params=params)
        try:
            payload = _KarakeepSearchPayload.model_validate(raw)
        except PydanticValidationError as error:
            raise IntegrationError("Karakeep returned an invalid search response") from error
        return KarakeepSourcePage(
            bookmarks=tuple(
                self._to_source(bookmark, raw_payload=raw_bookmark)
                for bookmark, raw_bookmark in zip(
                    payload.bookmarks, raw.get("bookmarks", []), strict=True
                )
            ),
            next_cursor=payload.nextCursor,
        )

    def bookmark(self, bookmark_id: str) -> KarakeepSourceBookmark:
        raw = self._request_json(
            f"/bookmarks/{quote(bookmark_id, safe='')}", params={"includeContent": True}
        )
        try:
            payload = _KarakeepBookmarkPayload.model_validate(raw)
        except PydanticValidationError as error:
            raise IntegrationError("Karakeep returned an invalid bookmark response") from error
        if payload.id != bookmark_id:
            raise IntegrationError("Karakeep returned a different bookmark than requested")
        return self._to_source(payload, raw_payload=raw)

    def _request_json(self, path: str, *, params: dict[str, object]) -> dict[str, object]:
        try:
            response = httpx.get(
                f"{self.base_url}{path}",
                params=params,
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {self.api_key}",
                },
                timeout=self.timeout_seconds,
                follow_redirects=False,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise IntegrationError(
                "Karakeep could not be reached or returned an invalid response"
            ) from error
        if not isinstance(payload, dict):
            raise IntegrationError("Karakeep returned an unexpected response shape")
        return payload

    @classmethod
    def _to_source(
        cls, payload: _KarakeepBookmarkPayload, *, raw_payload: object
    ) -> KarakeepSourceBookmark:
        content = payload.content or _KarakeepContentPayload()
        content_type: Literal["link", "text", "asset", "unknown"]
        content_type = content.type if content.type in {"link", "text", "asset"} else "unknown"
        title = payload.title or content.title or content.fileName or "Untitled import"
        source_url = content.url or content.sourceUrl
        if source_url and urlsplit(source_url).scheme not in {"http", "https"}:
            source_url = None
        tags = tuple(dict.fromkeys(tag.name.strip() for tag in payload.tags if tag.name.strip()))
        assets = tuple(
            KarakeepAsset(
                asset_id=asset.id,
                asset_type=asset.assetType,
                file_name=asset.fileName,
            )
            for asset in payload.assets
        )
        fallback_text = "\n\n".join(
            value.strip()
            for value in (payload.summary, content.description, payload.note)
            if value and value.strip()
        )
        return KarakeepSourceBookmark(
            bookmark_id=payload.id,
            title=cls._single_line(title),
            content_type=content_type,
            source_url=source_url,
            author=content.author,
            created_at=payload.createdAt,
            modified_at=payload.modifiedAt,
            tags=tags,
            assets=assets,
            source_html=content.htmlContent or "",
            source_text=content.text or content.content or "",
            fallback_text=fallback_text,
            source_payload_json=json.dumps(raw_payload, sort_keys=True, separators=(",", ":")),
        )

    @staticmethod
    def _single_line(value: str) -> str:
        return " ".join(value.split())[:240] or "Untitled import"
