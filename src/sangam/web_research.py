from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import date
from typing import Protocol

import httpx
from markdownify import markdownify

from sangam.db import Database, utc_now
from sangam.errors import NotFoundError, ValidationError
from sangam.ssrf_client import SafeCaptureClient

PAGE_CHARS = 8_000
MAX_SOURCES_PER_RUN = 50


@dataclass(frozen=True)
class WebHit:
    title: str
    url: str
    snippet: str
    published_at: str | None


@dataclass(frozen=True)
class WebSource:
    source_id: str
    url: str
    title: str
    snippet: str
    published_at: str | None
    retrieved_at: str


@dataclass(frozen=True)
class WebPage:
    source: WebSource
    content: str
    offset: int
    total_chars: int
    next_offset: int | None


class WebSearchProvider(Protocol):
    def search(
        self,
        query: str,
        *,
        limit: int,
        published_after: date | None,
        published_before: date | None,
    ) -> list[WebHit]: ...


class BraveSearchProvider:
    """Brave Search API adapter. Only the derived public query leaves Sangam."""

    endpoint = "https://api.search.brave.com/res/v1/web/search"

    def __init__(self, api_key: str, *, timeout_seconds: float = 10.0) -> None:
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds

    def search(
        self,
        query: str,
        *,
        limit: int,
        published_after: date | None,
        published_before: date | None,
    ) -> list[WebHit]:
        params: dict[str, str | int] = {"q": query, "count": limit}
        if published_after or published_before:
            start = (published_after or date(2000, 1, 1)).isoformat()
            end = (published_before or date.today()).isoformat()
            params["freshness"] = f"{start}to{end}"
        try:
            response = httpx.get(
                self.endpoint,
                params=params,
                headers={"Accept": "application/json", "X-Subscription-Token": self.api_key},
                timeout=self.timeout_seconds,
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise ValidationError("The web search provider is unavailable.") from error
        hits: list[WebHit] = []
        for item in payload.get("web", {}).get("results", [])[:limit]:
            url = item.get("url")
            if not isinstance(url, str):
                continue
            hits.append(
                WebHit(
                    title=str(item.get("title") or url),
                    url=url,
                    snippet=str(item.get("description") or ""),
                    published_at=item.get("page_age")
                    if isinstance(item.get("page_age"), str)
                    else None,
                )
            )
        return hits


class WebResearchService:
    """Searches and reads outside sources, recording each one per chat run.

    A source can only be read after a search in the same run returned it, so the
    model cannot fetch arbitrary URLs and cannot cite an ID that was never retrieved.
    """

    def __init__(
        self,
        database: Database,
        provider: WebSearchProvider,
        client: SafeCaptureClient | None = None,
    ) -> None:
        self.database = database
        self.provider = provider
        self.client = client or SafeCaptureClient(max_bytes=2_000_000)

    def search(
        self,
        run_id: str | None,
        query: str,
        *,
        limit: int,
        published_after: date | None,
        published_before: date | None,
    ) -> list[WebSource]:
        if published_after and published_before and published_after > published_before:
            raise ValidationError("published_after must not be later than published_before")
        hits = self.provider.search(
            query, limit=limit, published_after=published_after, published_before=published_before
        )
        retrieved_at = utc_now()
        sources = [
            WebSource(
                source_id=source_id(hit.url),
                url=hit.url,
                title=hit.title[:500],
                snippet=hit.snippet[:2_000],
                published_at=hit.published_at,
                retrieved_at=retrieved_at,
            )
            for hit in hits
        ]
        if run_id:
            self._record(run_id, query, sources)
        return sources

    def read(self, run_id: str | None, source_id_value: str, offset: int) -> WebPage:
        source = self._recorded(run_id, source_id_value)
        response = self.client.fetch(source.url)
        if response.content_type == "application/pdf":
            raise ValidationError("PDF web sources cannot be read in chat yet.")
        text = _page_text(response.body, response.content_type)
        window = text[offset : offset + PAGE_CHARS]
        end = offset + len(window)
        with self.database.transaction() as connection:
            connection.execute(
                "UPDATE chat_web_sources SET excerpt_hash = ?, read_at = ? "
                "WHERE run_id = ? AND source_id = ?",
                (
                    hashlib.sha256(window.encode("utf-8")).hexdigest(),
                    utc_now(),
                    run_id,
                    source.source_id,
                ),
            )
        return WebPage(
            source=source,
            content=window,
            offset=offset,
            total_chars=len(text),
            next_offset=end if end < len(text) else None,
        )

    def retrieved_source_ids(self, run_id: str) -> set[str]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT source_id FROM chat_web_sources WHERE run_id = ?", (run_id,)
            ).fetchall()
        return {row["source_id"] for row in rows}

    def queries(self, run_id: str) -> list[str]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT DISTINCT query FROM chat_web_sources WHERE run_id = ?", (run_id,)
            ).fetchall()
        return [row["query"] for row in rows]

    def _record(self, run_id: str, query: str, sources: list[WebSource]) -> None:
        with self.database.transaction() as connection:
            for source in sources:
                count = connection.execute(
                    "SELECT COUNT(*) AS count FROM chat_web_sources WHERE run_id = ?", (run_id,)
                ).fetchone()["count"]
                if count >= MAX_SOURCES_PER_RUN:
                    break
                connection.execute(
                    """
                    INSERT INTO chat_web_sources(
                        source_id, run_id, url, title, published_at, retrieved_at, query
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(run_id, url) DO NOTHING
                    """,
                    (
                        source.source_id,
                        run_id,
                        source.url,
                        source.title,
                        source.published_at,
                        source.retrieved_at,
                        query,
                    ),
                )

    def _recorded(self, run_id: str | None, source_id_value: str) -> WebSource:
        if not run_id:
            raise NotFoundError("Web source was not retrieved in this run")
        with self.database.connection() as connection:
            row = connection.execute(
                "SELECT * FROM chat_web_sources WHERE run_id = ? AND source_id = ?",
                (run_id, source_id_value),
            ).fetchone()
        if row is None:
            raise NotFoundError("Web source was not retrieved in this run")
        return WebSource(
            source_id=row["source_id"],
            url=row["url"],
            title=row["title"],
            snippet="",
            published_at=row["published_at"],
            retrieved_at=row["retrieved_at"],
        )


def source_id(url: str) -> str:
    """Stable per URL; uniqueness and validity are scoped to the run that retrieved it."""
    return "web_" + hashlib.sha256(url.encode()).hexdigest()[:12]


def _page_text(body: bytes, content_type: str) -> str:
    raw = body.decode("utf-8", errors="replace")
    if content_type == "text/html":
        raw = re.sub(
            r"<(script|style|noscript)\b[^>]*>.*?</\1\s*>",
            "",
            raw,
            flags=re.IGNORECASE | re.DOTALL,
        )
        raw = markdownify(raw, heading_style="ATX", bullets="-")
    return re.sub(r"\n{3,}", "\n\n", raw).strip()
