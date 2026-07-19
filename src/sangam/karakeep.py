from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import uuid
from typing import Any, Protocol
from urllib.parse import quote, urlsplit

import httpx
from markdownify import markdownify

from sangam.db import Database, utc_now
from sangam.errors import ConflictError, IntegrationError, NotFoundError, ValidationError
from sangam.organization import WorkspaceOrganizationService
from sangam.schemas import (
    KarakeepAsset,
    KarakeepBookmark,
    KarakeepBookmarkPage,
    KarakeepConnection,
    KarakeepImport,
    KarakeepImportDetail,
)
from sangam.service import DocumentService

KARAKEEP_ACTOR_ID = "integration:karakeep"


class KarakeepGateway(Protocol):
    def health(self) -> None: ...

    def search(self, *, query: str, limit: int, cursor: str | None) -> dict[str, Any]: ...

    def bookmark(self, bookmark_id: str) -> dict[str, Any]: ...


class KarakeepClient:
    """Small adapter around Karakeep's versioned HTTP API."""

    def __init__(self, *, base_url: str, api_key: str, timeout_seconds: float) -> None:
        normalized_url = base_url.strip().rstrip("/")
        if not normalized_url.startswith(("http://", "https://")):
            raise ValueError("Karakeep base URL must use HTTP or HTTPS")
        self.base_url = normalized_url
        self.api_key = api_key
        self.timeout_seconds = timeout_seconds

    def health(self) -> None:
        self._request_json("/bookmarks", params={"limit": 1})

    def search(self, *, query: str, limit: int, cursor: str | None) -> dict[str, Any]:
        params: dict[str, str | int | bool] = {
            "q": query,
            "limit": limit,
            "includeContent": False,
        }
        if cursor:
            params["cursor"] = cursor
        return self._request_json("/bookmarks/search", params=params)

    def bookmark(self, bookmark_id: str) -> dict[str, Any]:
        return self._request_json(
            f"/bookmarks/{quote(bookmark_id, safe='')}", params={"includeContent": True}
        )

    def _request_json(self, path: str, *, params: dict[str, object]) -> dict[str, Any]:
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


class KarakeepService:
    """Owns Karakeep provenance and refresh state without bypassing DocumentService."""

    def __init__(
        self,
        *,
        database: Database,
        documents: DocumentService,
        organization: WorkspaceOrganizationService,
        client: KarakeepGateway | None,
        max_source_bytes: int,
    ) -> None:
        self.database = database
        self.documents = documents
        self.organization = organization
        self.client = client
        self.max_source_bytes = max_source_bytes

    def recover_interrupted_imports(self) -> None:
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = 'failed', last_error = ?, updated_at = ?
                WHERE status = 'importing'
                """,
                ("Import interrupted by a process restart; retry it explicitly.", utc_now()),
            )

    def connection_health(self) -> KarakeepConnection:
        if self.client is None:
            return KarakeepConnection(
                configured=False,
                connected=False,
                message="Set SANGAM_KARAKEEP_BASE_URL and SANGAM_KARAKEEP_API_KEY.",
            )
        try:
            self.client.health()
        except IntegrationError as error:
            return KarakeepConnection(configured=True, connected=False, message=error.message)
        return KarakeepConnection(
            configured=True,
            connected=True,
            message="Karakeep connection and bookmark read permission verified.",
        )

    def search_bookmarks(
        self, *, query: str, limit: int, cursor: str | None
    ) -> KarakeepBookmarkPage:
        client = self._require_client()
        payload = client.search(query=query, limit=limit, cursor=cursor)
        raw_bookmarks = payload.get("bookmarks")
        if not isinstance(raw_bookmarks, list):
            raise IntegrationError("Karakeep search response did not include bookmarks")
        with self.database.connection() as connection:
            imported = {
                row["bookmark_id"]: row
                for row in connection.execute(
                    "SELECT bookmark_id, document_id, status FROM karakeep_imports"
                ).fetchall()
            }
        bookmarks = []
        for raw in raw_bookmarks:
            if not isinstance(raw, dict):
                continue
            bookmark = self._bookmark_summary(raw)
            existing = imported.get(bookmark.bookmark_id)
            if existing:
                bookmark = bookmark.model_copy(
                    update={
                        "imported_document_id": existing["document_id"],
                        "import_status": existing["status"],
                    }
                )
            bookmarks.append(bookmark)
        next_cursor = payload.get("nextCursor")
        return KarakeepBookmarkPage(
            bookmarks=bookmarks,
            next_cursor=next_cursor if isinstance(next_cursor, str) else None,
        )

    def list_imports(self) -> list[KarakeepImport]:
        with self.database.connection() as connection:
            rows = connection.execute(
                self._import_query() + " ORDER BY i.updated_at DESC, i.import_id"
            ).fetchall()
        return [self._import_from_row(row) for row in rows]

    def get_import(self, import_id: str) -> KarakeepImportDetail:
        with self.database.connection() as connection:
            row = connection.execute(
                self._import_query() + " WHERE i.import_id = ?", (import_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Karakeep import not found: {import_id}")
        return self._detail_from_row(row)

    def get_document_import(self, document_id: str) -> KarakeepImportDetail:
        with self.database.connection() as connection:
            row = connection.execute(
                self._import_query() + " WHERE i.document_id = ?", (document_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Karakeep import not found for document: {document_id}")
        return self._detail_from_row(row)

    def import_bookmark(self, bookmark_id: str) -> KarakeepImportDetail:
        existing = self._find_by_bookmark(bookmark_id)
        if existing and existing.document_id:
            return self.get_import(existing.import_id)
        import_id = self._reserve(bookmark_id)
        try:
            raw = self._require_client().bookmark(bookmark_id)
            snapshot = self._normalize_snapshot(bookmark_id, raw)
            document = self.documents.create_document(
                title=snapshot["title"],
                content=snapshot["extracted_markdown"],
                path=None,
                content_type="text/markdown",
                actor_id=KARAKEEP_ACTOR_ID,
                idempotency_key=f"karakeep:{bookmark_id}:create",
            )
            self._merge_source_tags(
                document.document_id, snapshot["tags"], snapshot["content_hash"]
            )
            snapshot_id = self._store_snapshot(import_id, snapshot)
            now = utc_now()
            with self.database.transaction() as connection:
                connection.execute(
                    """
                    UPDATE karakeep_imports
                    SET document_id = ?, status = 'current', accepted_snapshot_id = ?,
                        pending_snapshot_id = NULL, last_error = NULL,
                        last_success_at = ?, updated_at = ?
                    WHERE import_id = ?
                    """,
                    (document.document_id, snapshot_id, now, now, import_id),
                )
            return self.get_import(import_id)
        except Exception as error:
            self._mark_failed(import_id, error)
            raise

    def refresh_import(self, import_id: str) -> KarakeepImportDetail:
        current = self.get_import(import_id)
        if current.document_id is None:
            return self.import_bookmark(current.bookmark_id)
        self._claim(import_id)
        try:
            raw = self._require_client().bookmark(current.bookmark_id)
            snapshot = self._normalize_snapshot(current.bookmark_id, raw)
            snapshot_id = self._store_snapshot(import_id, snapshot)
            self._merge_source_tags(current.document_id, snapshot["tags"], snapshot["content_hash"])
            with self.database.connection() as connection:
                row = connection.execute(
                    "SELECT accepted_snapshot_id FROM karakeep_imports WHERE import_id = ?",
                    (import_id,),
                ).fetchone()
                accepted_hash = None
                if row and row["accepted_snapshot_id"]:
                    accepted = connection.execute(
                        "SELECT content_hash FROM karakeep_snapshots WHERE snapshot_id = ?",
                        (row["accepted_snapshot_id"],),
                    ).fetchone()
                    accepted_hash = accepted["content_hash"] if accepted else None
            now = utc_now()
            unchanged = accepted_hash == snapshot["content_hash"]
            with self.database.transaction() as connection:
                connection.execute(
                    """
                    UPDATE karakeep_imports
                    SET status = ?, pending_snapshot_id = ?, last_error = NULL,
                        last_success_at = ?, updated_at = ?
                    WHERE import_id = ?
                    """,
                    (
                        "current" if unchanged else "review_required",
                        None if unchanged else snapshot_id,
                        now,
                        now,
                        import_id,
                    ),
                )
            return self.get_import(import_id)
        except Exception as error:
            self._mark_failed(import_id, error)
            raise

    def apply_refresh(
        self,
        *,
        import_id: str,
        expected_revision_id: str,
        content: str | None,
        actor_id: str,
        idempotency_key: str,
    ) -> KarakeepImportDetail:
        current = self.get_import(import_id)
        if current.document_id is None:
            raise ConflictError("The Karakeep import does not have a working document")
        is_retry = self._is_document_retry(
            actor_id=actor_id,
            idempotency_key=idempotency_key,
            document_id=current.document_id,
        )
        if current.status != "review_required" or current.pending_markdown is None:
            if not is_retry or current.accepted_markdown is None:
                raise ConflictError("This Karakeep import has no refreshed source awaiting review")
            reviewed_content = current.accepted_markdown if content is None else content
        else:
            reviewed_content = current.pending_markdown if content is None else content
        self.documents.update_document(
            document_id=current.document_id,
            expected_revision_id=expected_revision_id,
            content=reviewed_content,
            title=None,
            summary="Applied reviewed Karakeep source refresh",
            actor_id=actor_id,
            idempotency_key=idempotency_key,
        )
        now = utc_now()
        with self.database.transaction() as connection:
            if current.status == "review_required":
                connection.execute(
                    """
                    UPDATE karakeep_imports
                    SET status = 'current', accepted_snapshot_id = pending_snapshot_id,
                        pending_snapshot_id = NULL, last_error = NULL,
                        last_success_at = ?, updated_at = ?
                    WHERE import_id = ?
                    """,
                    (now, now, import_id),
                )
        return self.get_import(import_id)

    def _is_document_retry(self, *, actor_id: str, idempotency_key: str, document_id: str) -> bool:
        with self.database.connection() as connection:
            row = connection.execute(
                """
                SELECT 1 FROM idempotency_keys
                WHERE actor_id = ? AND idempotency_key = ?
                    AND operation = 'update' AND document_id = ?
                """,
                (actor_id, idempotency_key, document_id),
            ).fetchone()
        return row is not None

    def _reserve(self, bookmark_id: str) -> str:
        now = utc_now()
        import_id = str(uuid.uuid4())
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO karakeep_imports(
                    import_id, bookmark_id, document_id, status, last_error,
                    last_attempt_at, created_at, updated_at
                ) VALUES (?, ?, NULL, 'failed', NULL, ?, ?, ?)
                """,
                (import_id, bookmark_id, now, now, now),
            )
            row = connection.execute(
                "SELECT import_id, document_id, status FROM karakeep_imports WHERE bookmark_id = ?",
                (bookmark_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError("Karakeep import reservation could not be loaded")
            if row["document_id"]:
                return row["import_id"]
            if row["status"] == "importing":
                raise ConflictError("This Karakeep bookmark is already being imported")
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = 'importing', last_error = NULL, last_attempt_at = ?, updated_at = ?
                WHERE import_id = ?
                """,
                (now, now, row["import_id"]),
            )
            return row["import_id"]

    def _claim(self, import_id: str) -> None:
        now = utc_now()
        with self.database.transaction() as connection:
            row = connection.execute(
                "SELECT status FROM karakeep_imports WHERE import_id = ?", (import_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError(f"Karakeep import not found: {import_id}")
            if row["status"] == "importing":
                raise ConflictError("This Karakeep import is already running")
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = 'importing', last_error = NULL, last_attempt_at = ?, updated_at = ?
                WHERE import_id = ?
                """,
                (now, now, import_id),
            )

    def _mark_failed(self, import_id: str, error: Exception) -> None:
        message = (
            error.message if isinstance(error, (IntegrationError, ValidationError)) else str(error)
        )
        with self.database.transaction() as connection:
            connection.execute(
                """
                UPDATE karakeep_imports
                SET status = 'failed', last_error = ?, updated_at = ? WHERE import_id = ?
                """,
                (message[:1000], utc_now(), import_id),
            )

    def _merge_source_tags(self, document_id: str, names: list[str], source_hash: str) -> None:
        if not names:
            return
        tag_ids = []
        for name in names:
            key_hash = hashlib.sha256(name.casefold().encode()).hexdigest()[:20]
            tag = self.organization.create_tag(
                name=name,
                color="#527ea3",
                actor_id=KARAKEEP_ACTOR_ID,
                idempotency_key=f"karakeep:tag:{key_hash}",
            )
            tag_ids.append(tag.tag_id)
        document = self.documents.get_document(document_id)
        merged = list(dict.fromkeys([*(tag.tag_id for tag in document.tags), *tag_ids]))
        if merged == [tag.tag_id for tag in document.tags]:
            return
        self.documents.update_document_metadata(
            document_id=document_id,
            expected_metadata_version=document.metadata_version,
            category=document.category,
            tag_ids=merged,
            actor_id=KARAKEEP_ACTOR_ID,
            idempotency_key=f"karakeep:tags:{document_id}:{source_hash[:20]}",
        )

    def _store_snapshot(self, import_id: str, snapshot: dict[str, Any]) -> str:
        snapshot_id = str(uuid.uuid4())
        with self.database.transaction() as connection:
            connection.execute(
                """
                INSERT OR IGNORE INTO karakeep_snapshots(
                    snapshot_id, import_id, source_url, title, author,
                    source_created_at, source_modified_at, tags_json, assets_json,
                    source_payload_json, source_html, extracted_markdown,
                    content_hash, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    import_id,
                    snapshot["source_url"],
                    snapshot["title"],
                    snapshot["author"],
                    snapshot["source_created_at"],
                    snapshot["source_modified_at"],
                    json.dumps(snapshot["tags"]),
                    json.dumps(snapshot["assets"]),
                    snapshot["source_payload_json"],
                    snapshot["source_html"],
                    snapshot["extracted_markdown"],
                    snapshot["content_hash"],
                    utc_now(),
                ),
            )
            row = connection.execute(
                """
                SELECT snapshot_id FROM karakeep_snapshots
                WHERE import_id = ? AND content_hash = ?
                """,
                (import_id, snapshot["content_hash"]),
            ).fetchone()
            if row is None:
                raise RuntimeError("Karakeep snapshot could not be loaded")
            return row["snapshot_id"]

    def _normalize_snapshot(self, bookmark_id: str, raw: dict[str, Any]) -> dict[str, Any]:
        payload_json = json.dumps(raw, sort_keys=True, separators=(",", ":"))
        if len(payload_json.encode()) > self.max_source_bytes:
            raise ValidationError(
                "Karakeep source exceeds the configured import limit",
                details={"max_source_bytes": self.max_source_bytes},
            )
        bookmark = self._bookmark_summary(raw)
        content = raw.get("content") if isinstance(raw.get("content"), dict) else {}
        source_html = (
            content.get("htmlContent") if isinstance(content.get("htmlContent"), str) else ""
        )
        if source_html:
            body = markdownify(
                source_html,
                heading_style="ATX",
                bullets="-",
                strip=["script", "style", "noscript"],
            )
        elif isinstance(content.get("text"), str):
            body = content["text"]
        elif isinstance(content.get("content"), str):
            body = content["content"]
        else:
            body = "\n\n".join(
                value
                for value in (raw.get("summary"), content.get("description"), raw.get("note"))
                if isinstance(value, str) and value.strip()
            )
        body = re.sub(r"\n{3,}", "\n\n", body).strip()
        provenance = [
            f"# {self._single_line(bookmark.title)}",
            "",
            f"> Karakeep bookmark: `{bookmark_id}`",
        ]
        if bookmark.source_url:
            provenance.append(f"> Original source: <{bookmark.source_url}>")
        if bookmark.author:
            provenance.append(f"> Author: {self._single_line(bookmark.author)}")
        if bookmark.created_at:
            provenance.append(f"> Archived: {bookmark.created_at}")
        extracted_markdown = "\n".join([*provenance, "", "---", "", body]).rstrip() + "\n"
        content_hash = hashlib.sha256(extracted_markdown.encode()).hexdigest()
        return {
            "source_url": bookmark.source_url,
            "title": bookmark.title,
            "author": bookmark.author,
            "source_created_at": bookmark.created_at,
            "source_modified_at": bookmark.modified_at,
            "tags": bookmark.tags,
            "assets": [asset.model_dump() for asset in bookmark.assets],
            "source_payload_json": payload_json,
            "source_html": source_html,
            "extracted_markdown": extracted_markdown,
            "content_hash": content_hash,
        }

    def _bookmark_summary(self, raw: dict[str, Any]) -> KarakeepBookmark:
        bookmark_id = raw.get("id")
        created_at = raw.get("createdAt")
        if not isinstance(bookmark_id, str) or not isinstance(created_at, str):
            raise IntegrationError("Karakeep bookmark is missing its ID or creation time")
        content = raw.get("content") if isinstance(raw.get("content"), dict) else {}
        content_type = content.get("type")
        if content_type not in {"link", "text", "asset"}:
            content_type = "unknown"
        title = (
            raw.get("title") or content.get("title") or content.get("fileName") or "Untitled import"
        )
        source_url = content.get("url") or content.get("sourceUrl")
        if isinstance(source_url, str) and urlsplit(source_url).scheme not in {"http", "https"}:
            source_url = None
        tags = [
            tag["name"]
            for tag in raw.get("tags", [])
            if isinstance(tag, dict) and isinstance(tag.get("name"), str) and tag["name"].strip()
        ]
        assets = []
        for asset in raw.get("assets", []):
            if not isinstance(asset, dict) or not isinstance(asset.get("id"), str):
                continue
            assets.append(
                KarakeepAsset(
                    asset_id=asset["id"],
                    asset_type=str(asset.get("assetType") or "unknown"),
                    file_name=(
                        asset.get("fileName") if isinstance(asset.get("fileName"), str) else None
                    ),
                )
            )
        return KarakeepBookmark(
            bookmark_id=bookmark_id,
            title=self._single_line(str(title)),
            content_type=content_type,
            source_url=source_url if isinstance(source_url, str) else None,
            author=content.get("author") if isinstance(content.get("author"), str) else None,
            created_at=created_at,
            modified_at=raw.get("modifiedAt") if isinstance(raw.get("modifiedAt"), str) else None,
            tags=list(dict.fromkeys(tags)),
            assets=assets,
        )

    def _find_by_bookmark(self, bookmark_id: str) -> KarakeepImport | None:
        with self.database.connection() as connection:
            row = connection.execute(
                self._import_query() + " WHERE i.bookmark_id = ?", (bookmark_id,)
            ).fetchone()
        return self._import_from_row(row) if row else None

    @staticmethod
    def _single_line(value: str) -> str:
        return " ".join(value.split())[:240] or "Untitled import"

    def _require_client(self) -> KarakeepGateway:
        if self.client is None:
            raise ValidationError(
                "Karakeep is not configured",
                details={
                    "required_settings": [
                        "SANGAM_KARAKEEP_BASE_URL",
                        "SANGAM_KARAKEEP_API_KEY",
                    ]
                },
            )
        return self.client

    @staticmethod
    def _import_query() -> str:
        return """
            SELECT i.*,
                accepted.source_url, accepted.title, accepted.author,
                accepted.source_created_at, accepted.source_modified_at,
                accepted.tags_json, accepted.assets_json,
                accepted.extracted_markdown AS accepted_markdown,
                pending.extracted_markdown AS pending_markdown,
                d.title AS document_title, d.current_revision_id, r.content AS working_copy
            FROM karakeep_imports i
            LEFT JOIN karakeep_snapshots accepted
                ON accepted.snapshot_id = i.accepted_snapshot_id
            LEFT JOIN karakeep_snapshots pending
                ON pending.snapshot_id = i.pending_snapshot_id
            LEFT JOIN documents d ON d.document_id = i.document_id
            LEFT JOIN revisions r ON r.revision_id = d.current_revision_id
        """

    @staticmethod
    def _import_from_row(row: sqlite3.Row) -> KarakeepImport:
        return KarakeepImport(
            import_id=row["import_id"],
            bookmark_id=row["bookmark_id"],
            document_id=row["document_id"],
            status=row["status"],
            last_error=row["last_error"],
            last_attempt_at=row["last_attempt_at"],
            last_success_at=row["last_success_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            source_url=row["source_url"],
            title=row["title"],
            author=row["author"],
            source_created_at=row["source_created_at"],
            source_modified_at=row["source_modified_at"],
            tags=json.loads(row["tags_json"] or "[]"),
            assets=[
                KarakeepAsset.model_validate(asset)
                for asset in json.loads(row["assets_json"] or "[]")
            ],
        )

    @classmethod
    def _detail_from_row(cls, row: sqlite3.Row) -> KarakeepImportDetail:
        summary = cls._import_from_row(row)
        return KarakeepImportDetail(
            **summary.model_dump(),
            document_title=row["document_title"],
            current_revision_id=row["current_revision_id"],
            working_copy=row["working_copy"],
            accepted_markdown=row["accepted_markdown"],
            pending_markdown=row["pending_markdown"],
        )
