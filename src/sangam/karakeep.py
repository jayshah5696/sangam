from __future__ import annotations

import hashlib

from sangam.errors import ConflictError, IntegrationError, ValidationError
from sangam.karakeep_extraction import KarakeepExtractor
from sangam.karakeep_gateway import KarakeepGateway
from sangam.karakeep_repository import (
    KARAKEEP_ACTOR_ID,
    KarakeepRepository,
    StoredSnapshot,
)
from sangam.organization import WorkspaceOrganizationService
from sangam.schemas import (
    KarakeepBookmarkPage,
    KarakeepConnection,
    KarakeepImport,
    KarakeepImportDetail,
)
from sangam.service import DocumentService


class KarakeepService:
    """Orchestrate imports while gateway, extraction, and persistence own their seams."""

    def __init__(
        self,
        *,
        documents: DocumentService,
        organization: WorkspaceOrganizationService,
        client: KarakeepGateway | None,
        extractor: KarakeepExtractor,
        repository: KarakeepRepository,
    ) -> None:
        self.documents = documents
        self.organization = organization
        self.client = client
        self.extractor = extractor
        self.repository = repository

    def recover_interrupted_imports(self) -> None:
        self.repository.recover_interrupted_imports()

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
        page = self._require_client().search(query=query, limit=limit, cursor=cursor)
        imported = self.repository.imported_states()
        bookmarks = []
        for source in page.bookmarks:
            bookmark = source.summary()
            existing = imported.get(bookmark.bookmark_id)
            if existing:
                bookmark = bookmark.model_copy(
                    update={
                        "imported_document_id": existing[0],
                        "import_status": existing[1],
                    }
                )
            bookmarks.append(bookmark)
        return KarakeepBookmarkPage(bookmarks=bookmarks, next_cursor=page.next_cursor)

    def list_imports(self) -> list[KarakeepImport]:
        return self.repository.list_imports()

    def get_import(self, import_id: str) -> KarakeepImportDetail:
        return self.repository.get_import(import_id)

    def get_document_import(self, document_id: str) -> KarakeepImportDetail:
        return self.repository.get_document_import(document_id)

    def import_bookmark(self, bookmark_id: str) -> KarakeepImportDetail:
        existing = self.repository.find_by_bookmark(bookmark_id)
        if existing and existing.document_id and existing.status in {"current", "review_required"}:
            return self.repository.get_import(existing.import_id)
        reservation = self.repository.reserve(bookmark_id)
        create_key = self._create_key(bookmark_id)
        try:
            document_id = self.repository.recover_document_link(
                reservation.import_id, create_key=create_key
            )
            snapshot = self.repository.initial_snapshot(reservation.import_id)
            if snapshot is None:
                source = self._require_client().bookmark(bookmark_id)
                normalized = self.extractor.extract(source)
                snapshot_id = self.repository.store_snapshot(reservation.import_id, normalized)
                snapshot = StoredSnapshot(
                    snapshot_id=snapshot_id,
                    title=normalized.title,
                    tags=normalized.tags,
                    extracted_markdown=normalized.extracted_markdown,
                    content_hash=normalized.content_hash,
                )
            if document_id is None:
                document = self.documents.create_document(
                    title=snapshot.title,
                    content=snapshot.extracted_markdown,
                    path=None,
                    content_type="text/markdown",
                    actor_id=KARAKEEP_ACTOR_ID,
                    idempotency_key=create_key,
                )
                document_id = document.document_id
                self.repository.link_initial_document(
                    reservation.import_id, document_id, snapshot.snapshot_id
                )
            self._merge_source_tags(document_id, snapshot.tags, snapshot.content_hash)
            self.repository.complete_initial_import(reservation.import_id, snapshot.snapshot_id)
            return self.repository.get_import(reservation.import_id)
        except Exception as error:
            self.repository.mark_failed(reservation.import_id, error)
            raise

    def refresh_import(self, import_id: str) -> KarakeepImportDetail:
        current = self.repository.get_import(import_id)
        if current.document_id is None:
            return self.import_bookmark(current.bookmark_id)
        self.repository.claim_refresh(import_id)
        try:
            source = self._require_client().bookmark(current.bookmark_id)
            snapshot = self.extractor.extract(source)
            snapshot_id = self.repository.store_snapshot(import_id, snapshot)
            self._merge_source_tags(current.document_id, snapshot.tags, snapshot.content_hash)
            unchanged = self.repository.accepted_content_hash(import_id) == snapshot.content_hash
            self.repository.complete_refresh(import_id, snapshot_id, unchanged=unchanged)
            return self.repository.get_import(import_id)
        except Exception as error:
            self.repository.mark_failed(import_id, error)
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
        current = self.repository.get_import(import_id)
        if current.document_id is None:
            raise ConflictError("The Karakeep import does not have a working document")
        is_retry = self.repository.is_document_retry(
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
        if current.status == "review_required":
            self.repository.complete_apply(import_id)
        return self.repository.get_import(import_id)

    def _merge_source_tags(
        self, document_id: str, names: tuple[str, ...], source_hash: str
    ) -> None:
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
        existing_tag_ids = [tag.tag_id for tag in document.tags]
        merged = list(dict.fromkeys([*existing_tag_ids, *tag_ids]))
        if merged == existing_tag_ids:
            return
        self.documents.update_document_metadata(
            document_id=document_id,
            expected_metadata_version=document.metadata_version,
            category=document.category,
            tag_ids=merged,
            actor_id=KARAKEEP_ACTOR_ID,
            idempotency_key=f"karakeep:tags:{document_id}:{source_hash[:20]}",
        )

    @staticmethod
    def _create_key(bookmark_id: str) -> str:
        return f"karakeep:{bookmark_id}:create"

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
