from __future__ import annotations

import contextlib
import re
from datetime import UTC, datetime
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from markdownify import markdownify

from sangam.access import WorkspaceAccessService
from sangam.errors import validate_metadata_text
from sangam.karakeep_extraction import KarakeepExtractor
from sangam.schemas import Document
from sangam.security import Principal
from sangam.ssrf_client import SafeCaptureClient

if TYPE_CHECKING:
    from sangam.pdf_research import PdfResearchService
    from sangam.projects import ProjectService
    from sangam.service import DocumentService


def _slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "-", value.lower()).strip("-")
    return cleaned[:60] or "capture"


def _default_inbox_path(title: str, extension: str, now: datetime) -> str:
    date_str = now.strftime("%Y-%m-%d")
    suffix = datetime.now(UTC).strftime("%H%M%S")
    slug_title = _slug(title)
    return f"inbox/{date_str}-{slug_title}-{suffix}.{extension}"


def _format_markdown_with_provenance(
    *,
    title: str,
    original_url: str,
    final_url: str,
    fetch_time: str,
    content_hash: str,
    body: str,
) -> str:
    provenance = [
        f"# {title}",
        "",
        f"> Original source: <{original_url}>",
        f"> Final URL: <{final_url}>",
        f"> Captured at: {fetch_time}",
        f"> Content hash: sha256:{content_hash}",
        "",
        "---",
        "",
        body.strip(),
    ]
    return "\n".join(provenance).strip() + "\n"


class CaptureService:
    """Service orchestrating SSRF-safe web page and PDF capture into the Sangam workspace."""

    def __init__(
        self,
        *,
        workspace: WorkspaceAccessService,
        documents: DocumentService,
        pdf_research: PdfResearchService,
        projects: ProjectService,
        extractor: KarakeepExtractor,
        capture_client: SafeCaptureClient | None = None,
    ) -> None:
        self.workspace = workspace
        self.documents = documents
        self.pdf_research = pdf_research
        self.projects = projects
        self.extractor = extractor
        self.client = capture_client or SafeCaptureClient()

    def capture_url(
        self,
        principal: Principal,
        *,
        url: str,
        title: str | None = None,
        path: str | None = None,
        project_id: str | None = None,
        idempotency_key: str,
    ) -> Document:
        """Fetch URL with SSRF guards and persist as an Inbox document or imported PDF."""
        response = self.client.fetch(url)
        now = datetime.now(UTC)

        # Determine document title
        doc_title = title.strip() if title and title.strip() else None
        if not doc_title:
            doc_title = response.title
        if not doc_title:
            parsed = urlsplit(response.final_url)
            path_part = parsed.path.rstrip("/").split("/")[-1] if parsed.path else ""
            doc_title = f"{parsed.netloc}{'/' + path_part if path_part else ''}" or "Captured page"
        validate_metadata_text(doc_title, "Document title")

        if response.content_type == "application/pdf":
            doc_path = path or _default_inbox_path(doc_title, "pdf", now)
            if not doc_path.lower().endswith(".pdf"):
                doc_path = f"{doc_path}.pdf"

            document = self.workspace.import_pdf(
                principal,
                title=doc_title,
                path=doc_path,
                content=response.body,
                supersedes_document_id=None,
                idempotency_key=idempotency_key,
            )
        else:
            # HTML or text/plain
            if response.content_type == "text/html":
                # Convert HTML body using KarakeepExtractor cleaning logic
                raw_html = response.body.decode("utf-8", errors="replace")
                cleaned_html = re.sub(
                    r"<(script|style|noscript)\b[^>]*>.*?</\1\s*>",
                    "",
                    raw_html,
                    flags=re.IGNORECASE | re.DOTALL,
                )
                converted_body = markdownify(
                    cleaned_html,
                    heading_style="ATX",
                    bullets="-",
                )
            else:
                converted_body = response.body.decode("utf-8", errors="replace")

            converted_body = re.sub(r"\n{3,}", "\n\n", converted_body).strip()
            markdown_content = _format_markdown_with_provenance(
                title=doc_title,
                original_url=response.original_url,
                final_url=response.final_url,
                fetch_time=response.fetch_time,
                content_hash=response.content_hash,
                body=converted_body,
            )

            doc_path = path or _default_inbox_path(doc_title, "md", now)
            if not doc_path.lower().endswith(".md"):
                doc_path = f"{doc_path}.md"

            document = self.workspace.create_document(
                principal,
                title=doc_title,
                path=doc_path,
                content=markdown_content,
                content_type="text/markdown",
                idempotency_key=idempotency_key,
            )

        # Attach to project if requested
        if project_id:
            with contextlib.suppress(Exception):
                self.projects.add_document(
                    project_id,
                    document.document_id,
                    role="source",
                    actor_id=principal.actor_id,
                )

        return document
