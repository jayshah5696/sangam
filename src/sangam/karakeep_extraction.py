from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from markdownify import markdownify

from sangam.errors import ValidationError
from sangam.karakeep_gateway import KarakeepSourceBookmark
from sangam.schemas import KarakeepAsset


@dataclass(frozen=True)
class NormalizedSnapshot:
    source_url: str | None
    title: str
    author: str | None
    source_created_at: str
    source_modified_at: str | None
    tags: tuple[str, ...]
    assets: tuple[KarakeepAsset, ...]
    source_payload_json: str
    source_html: str
    extracted_markdown: str
    content_hash: str


class KarakeepExtractor:
    """Pure conversion from a validated Karakeep bookmark to Sangam Markdown."""

    def __init__(self, *, max_source_bytes: int) -> None:
        self.max_source_bytes = max_source_bytes

    def extract(self, bookmark: KarakeepSourceBookmark) -> NormalizedSnapshot:
        if len(bookmark.source_payload_json.encode()) > self.max_source_bytes:
            raise ValidationError(
                "Karakeep source exceeds the configured import limit",
                details={"max_source_bytes": self.max_source_bytes},
            )
        if bookmark.source_html:
            source_html = re.sub(
                r"<(script|style|noscript)\b[^>]*>.*?</\1\s*>",
                "",
                bookmark.source_html,
                flags=re.IGNORECASE | re.DOTALL,
            )
            body = markdownify(
                source_html,
                heading_style="ATX",
                bullets="-",
            )
        else:
            body = bookmark.source_text or bookmark.fallback_text
        body = re.sub(r"\n{3,}", "\n\n", body).strip()
        provenance = [
            f"# {self._single_line(bookmark.title)}",
            "",
            f"> Karakeep bookmark: `{bookmark.bookmark_id}`",
        ]
        if bookmark.source_url:
            provenance.append(f"> Original source: <{bookmark.source_url}>")
        if bookmark.author:
            provenance.append(f"> Author: {self._single_line(bookmark.author)}")
        if bookmark.created_at:
            provenance.append(f"> Archived: {bookmark.created_at}")
        extracted_markdown = "\n".join([*provenance, "", "---", "", body]).rstrip() + "\n"
        return NormalizedSnapshot(
            source_url=bookmark.source_url,
            title=bookmark.title,
            author=bookmark.author,
            source_created_at=bookmark.created_at,
            source_modified_at=bookmark.modified_at,
            tags=bookmark.tags,
            assets=bookmark.assets,
            source_payload_json=bookmark.source_payload_json,
            source_html=bookmark.source_html,
            extracted_markdown=extracted_markdown,
            content_hash=hashlib.sha256(extracted_markdown.encode()).hexdigest(),
        )

    @staticmethod
    def _single_line(value: str) -> str:
        return " ".join(value.split())[:240] or "Untitled import"
