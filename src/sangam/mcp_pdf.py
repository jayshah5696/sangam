"""PDF operations shared by Code Mode and the App bridge."""

import base64
import sqlite3
from typing import Literal

from pydantic import BaseModel, JsonValue

from sangam.application import ApplicationServices
from sangam.capabilities import Capability
from sangam.errors import AuthorizationError, ConflictError, IdempotencyError, ValidationError
from sangam.idempotency import IdempotencyStore
from sangam.mcp_models import (
    PdfAnnotations,
    PdfBytes,
    PdfCreateAnnotation,
    PdfOperation,
    PdfReadPage,
    PdfSearch,
)
from sangam.mcp_state import McpState
from sangam.schemas import Annotation
from sangam.security import Principal


class PdfStatusResult(BaseModel):
    document_id: str
    current_revision_id: str
    status: Literal["pending", "processing", "ready", "failed"]
    page_count: int | None
    error: str | None
    resource_uri: str
    next_action: str | None


class PdfPageResult(PdfStatusResult):
    page_number: int
    text: str | None
    next_offset: int | None


class PdfSearchHit(BaseModel):
    page_number: int
    snippet: str


class PdfSearchResult(PdfStatusResult):
    items: list[PdfSearchHit]
    next_offset: int | None


class PdfAnnotationResult(BaseModel):
    items: list[Annotation]
    next_offset: int | None


class PdfAnnotationWrite(Annotation):
    operation_key: str


class PdfOperations:
    def __init__(self, services: ApplicationServices, state: McpState) -> None:
        self.services = services
        self.state = state

    def invoke(
        self, principal: Principal, operation: PdfOperation, execution_key: str | None = None
    ) -> dict[str, JsonValue]:
        document = self.services.workspace_access.get_document(principal, operation.document_id)
        if document.content_type != "application/pdf":
            raise ValidationError("The document is not a PDF.")
        if execution_key:
            self.state.dependency(principal, execution_key, document.document_id)
        status = PdfStatusResult.model_validate(
            {
                "document_id": document.document_id,
                "current_revision_id": document.current_revision_id,
                "status": document.pdf_extraction_status,
                "page_count": document.pdf_page_count,
                "error": document.pdf_extraction_error,
                "resource_uri": f"sangam://document/{document.document_id}",
                "next_action": (
                    "Read pdf.status or the resource again to check extraction completion. "
                    "Accepted work is not finished work."
                )
                if document.pdf_extraction_status in {"pending", "processing"}
                else None,
            }
        )
        if isinstance(operation, PdfCreateAnnotation):
            return self.create_annotation(principal, operation, execution_key)
        if isinstance(operation, PdfAnnotations):
            notes = self.services.workspace_access.list_annotations(
                principal,
                document.document_id,
                page_number=operation.page_number,
                query="",
                include_deleted=False,
            )
            # The canonical annotation API bounds field sizes; cap each page of notes.
            end = operation.offset + operation.limit
            return PdfAnnotationResult(
                items=notes[operation.offset : end], next_offset=end if end < len(notes) else None
            ).model_dump(mode="json")
        if isinstance(operation, PdfReadPage):
            text = None
            next_offset = None
            if status.status == "ready":
                pages = self.services.workspace_access.pdf_pages(principal, document.document_id)
                if operation.page_number > len(pages):
                    raise ValidationError("PDF page number exceeds the document page count.")
                page = pages[operation.page_number - 1].text
                end = operation.offset + operation.length
                text = page[operation.offset : end]
                next_offset = end if end < len(page) else None
            return PdfPageResult(
                **status.model_dump(),
                page_number=operation.page_number,
                text=text,
                next_offset=next_offset,
            ).model_dump(mode="json")
        if isinstance(operation, PdfSearch):
            self.services.authorization.require(principal, Capability.SEARCH, document.path)
            hits = (
                self.services.workspace_access.search_pdf_pages(
                    principal, document.document_id, operation.query
                )
                if status.status == "ready"
                else []
            )
            selected = hits[operation.offset : operation.offset + operation.limit]
            return PdfSearchResult(
                **status.model_dump(),
                items=[
                    PdfSearchHit(page_number=hit.page_number, snippet=hit.snippet[:1000])
                    for hit in selected
                ],
                next_offset=operation.offset + len(selected)
                if operation.offset + len(selected) < len(hits)
                else None,
            ).model_dump(mode="json")
        return status.model_dump(mode="json")

    def bytes(self, principal: Principal, operation: PdfBytes) -> dict[str, JsonValue]:
        document, total = self.services.workspace_access.pdf_stream_info(
            principal, operation.document_id
        )
        if document.current_revision_id != operation.expected_revision_id:
            raise ConflictError("PDF revision changed. Reopen the document before loading bytes.")
        if operation.offset > total:
            raise ValidationError("PDF byte offset exceeds the source length.")
        end = min(operation.offset + operation.length, total)
        data = (
            b"".join(
                self.services.workspace_access.pdf_stream(
                    principal, operation.document_id, start=operation.offset, end=end - 1
                )
            )
            if end > operation.offset
            else b""
        )
        return {
            "bytes": base64.b64encode(data).decode(),
            "offset": operation.offset,
            "total_bytes": total,
            "next_offset": end if end < total else None,
        }

    def create_annotation(
        self, principal: Principal, operation: PdfCreateAnnotation, execution_key: str | None
    ) -> dict[str, JsonValue]:
        document = self.services.workspace_access.get_document(principal, operation.document_id)
        self.services.authorization.require(principal, Capability.UPDATE, document.path)
        if execution_key:
            self.state.dependency(
                principal, execution_key, operation.document_id, Capability.UPDATE
            )
            self.state.before_write(
                principal,
                execution_key,
                operation.operation_key,
                operation.document_id,
                resource_type="annotation",
            )

        def record_target(connection: sqlite3.Connection) -> None:
            if execution_key:
                committed = IdempotencyStore.lookup(
                    connection, actor_id=principal.actor_id, key=operation.operation_key
                )
                if committed and committed.operation == "annotation_create" and committed.completed:
                    connection.execute(
                        "UPDATE mcp_execution_writes SET resource_id = ?, outcome = 'committed' "
                        "WHERE actor_id = ? AND execution_key = ? AND operation_key = ?",
                        (
                            committed.resource_id,
                            principal.actor_id,
                            execution_key,
                            operation.operation_key,
                        ),
                    )

        try:
            with self.state.database.commit_hook(record_target):
                note = self.services.workspace_access.create_annotation(
                    principal,
                    document_id=operation.document_id,
                    page_number=operation.page_number,
                    annotation_type=operation.annotation_type,
                    note=operation.note,
                    selected_text=operation.selected_text,
                    geometry=operation.geometry,
                    tags=operation.tags,
                    color=operation.color,
                    idempotency_key=operation.operation_key,
                )
            # A replay may return before opening a transaction. Reconcile its reference too.
            with self.state.database.transaction() as connection:
                record_target(connection)
            if execution_key:
                self.state.confirm_write(principal, execution_key, operation.operation_key)
        except (AuthorizationError, ConflictError, IdempotencyError, ValidationError):
            if execution_key:
                self.state.reject_write(principal, execution_key, operation.operation_key)
            raise
        return PdfAnnotationWrite(
            **note.model_dump(), operation_key=operation.operation_key
        ).model_dump(mode="json")
