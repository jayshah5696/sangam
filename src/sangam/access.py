from __future__ import annotations

from collections.abc import Callable
from typing import TypeVar

from sangam.activity import ActivityService
from sangam.authorization import AuthorizationPolicy
from sangam.capabilities import Capability
from sangam.errors import AuthorizationError, ConflictError, SangamError
from sangam.organization import WorkspaceOrganizationService
from sangam.schemas import Document, DocumentSummary, Folder, Revision, RevisionDiff, Tag
from sangam.security import Principal
from sangam.service import DocumentService

T = TypeVar("T")


class WorkspaceAccessService:
    """Public workspace boundary that authenticates policy before domain services run."""

    def __init__(
        self,
        *,
        documents: DocumentService,
        organization: WorkspaceOrganizationService,
        policy: AuthorizationPolicy,
        activity: ActivityService,
    ) -> None:
        self.documents = documents
        self.organization = organization
        self.policy = policy
        self.activity = activity

    def list_documents(
        self,
        principal: Principal,
        *,
        include_deleted: bool = False,
        limit: int = 100,
        offset: int = 0,
    ) -> list[DocumentSummary]:
        def operation() -> list[DocumentSummary]:
            return self.documents.list_document_summaries(
                include_deleted=include_deleted,
                path_prefixes=self.policy.allowed_prefixes(principal, Capability.READ),
                limit=limit,
                offset=offset,
            )

        return self._run(principal, "list", "document", operation)

    def search_documents(
        self,
        principal: Principal,
        *,
        query: str,
        tag_id: str | None,
        category: str | None,
        actor_id: str | None,
        sort: str,
        limit: int = 50,
        offset: int = 0,
    ) -> list[DocumentSummary]:
        def operation() -> list[DocumentSummary]:
            return self.documents.search_documents(
                query=query,
                tag_id=tag_id,
                category=category,
                actor_id=actor_id,
                sort=sort,
                path_prefixes=self.policy.allowed_prefixes(
                    principal, Capability.READ, Capability.SEARCH
                ),
                limit=limit,
                offset=offset,
            )

        return self._run(principal, "search", "document", operation)

    def get_document(
        self, principal: Principal, document_id: str, *, include_deleted: bool = False
    ) -> Document:
        document = self.documents.get_document(document_id, include_deleted=include_deleted)
        return self._document_operation(
            principal,
            capability=Capability.READ,
            action="read",
            current=document,
            operation=lambda: document,
        )

    def create_document(
        self,
        principal: Principal,
        *,
        title: str,
        content: str,
        path: str | None,
        idempotency_key: str,
    ) -> Document:
        def operation() -> Document:
            self.policy.require(principal, Capability.CREATE, path)
            return self.documents.create_document(
                title=title,
                content=content,
                path=path,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        return self._run(principal, "create", "document", operation, path=path)

    def update_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        content: str,
        title: str | None,
        summary: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.UPDATE,
            action="update",
            current=current,
            operation=lambda: self.documents.update_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                content=content,
                title=title,
                summary=summary,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
        )

    def duplicate_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        title: str | None,
        path: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)

        def operation() -> Document:
            self.policy.require(principal, Capability.READ, current.path)
            self.policy.require(principal, Capability.CREATE, path)
            return self.documents.duplicate_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                title=title,
                path=path,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        return self._run(
            principal,
            "duplicate",
            "document",
            operation,
            resource_id=document_id,
            path=path,
        )

    def update_document_metadata(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_metadata_version: int,
        category: str | None,
        tag_ids: list[str],
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.TAG,
            action="tag",
            current=current,
            operation=lambda: self.documents.update_document_metadata(
                document_id=document_id,
                expected_metadata_version=expected_metadata_version,
                category=category,
                tag_ids=tag_ids,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
        )

    def materialize_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        path: str,
        summary: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)

        def operation() -> Document:
            self.policy.require(principal, Capability.MOVE, current.path)
            self.policy.require(principal, Capability.MOVE, path)
            return self.documents.materialize_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                path=path,
                summary=summary,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        return self._run(
            principal,
            "materialize",
            "document",
            operation,
            resource_id=document_id,
            path=path,
        )

    def move_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        path: str,
        summary: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)

        def operation() -> Document:
            self.policy.require(principal, Capability.MOVE, current.path)
            self.policy.require(principal, Capability.MOVE, path)
            return self.documents.move_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                path=path,
                summary=summary,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        return self._run(
            principal,
            "move",
            "document",
            operation,
            resource_id=document_id,
            path=path,
        )

    def delete_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        summary: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id)
        return self._document_operation(
            principal,
            capability=Capability.DELETE,
            action="delete",
            current=current,
            operation=lambda: self.documents.delete_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                summary=summary,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
        )

    def history(self, principal: Principal, document_id: str) -> list[Revision]:
        current = self.documents.get_document(document_id, include_deleted=True)

        return self._document_operation(
            principal,
            capability=Capability.READ,
            action="history",
            current=current,
            operation=lambda: self.documents.history(document_id),
        )

    def revision_diff(
        self,
        principal: Principal,
        *,
        document_id: str,
        from_revision_id: str,
        to_revision_id: str | None,
    ) -> RevisionDiff:
        current = self.documents.get_document(document_id, include_deleted=True)

        return self._document_operation(
            principal,
            capability=Capability.READ,
            action="diff",
            current=current,
            operation=lambda: self.documents.revision_diff(
                document_id=document_id,
                from_revision_id=from_revision_id,
                to_revision_id=to_revision_id,
            ),
        )

    def restore_document(
        self,
        principal: Principal,
        *,
        document_id: str,
        expected_revision_id: str,
        revision_id: str,
        summary: str | None,
        idempotency_key: str,
    ) -> Document:
        current = self.documents.get_document(document_id, include_deleted=True)
        return self._document_operation(
            principal,
            capability=Capability.RESTORE,
            action="restore",
            current=current,
            operation=lambda: self.documents.restore_document(
                document_id=document_id,
                expected_revision_id=expected_revision_id,
                revision_id=revision_id,
                summary=summary,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            ),
        )

    def list_tags(self, principal: Principal) -> list[Tag]:
        def operation() -> list[Tag]:
            self._require_global_read(principal)
            return self.organization.list_tags()

        return self._run(principal, "list_tags", "tag", operation)

    def list_folders(self, principal: Principal) -> list[Folder]:
        def operation() -> list[Folder]:
            self._require_global_read(principal)
            return self.organization.list_folders()

        return self._run(principal, "list_folders", "folder", operation)

    def create_tag(
        self, principal: Principal, *, name: str, color: str, idempotency_key: str
    ) -> Tag:
        def operation() -> Tag:
            self.policy.require_administrator(principal)
            return self.organization.create_tag(
                name=name,
                color=color,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        return self._run(principal, "create", "tag", operation)

    def create_folder(
        self,
        principal: Principal,
        *,
        path: str,
        category: str | None,
        tag_ids: list[str],
        idempotency_key: str,
    ) -> Folder:
        def operation() -> Folder:
            self.policy.require_administrator(principal)
            return self.organization.create_folder(
                path=path,
                category=category,
                tag_ids=tag_ids,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        return self._run(principal, "create", "folder", operation, path=path)

    def update_folder_metadata(
        self,
        principal: Principal,
        *,
        folder_id: str,
        expected_metadata_version: int,
        category: str | None,
        tag_ids: list[str],
        idempotency_key: str,
    ) -> Folder:
        def operation() -> Folder:
            self.policy.require_administrator(principal)
            return self.organization.update_folder_metadata(
                folder_id=folder_id,
                expected_metadata_version=expected_metadata_version,
                category=category,
                tag_ids=tag_ids,
                actor_id=principal.actor_id,
                idempotency_key=idempotency_key,
            )

        return self._run(principal, "tag", "folder", operation, resource_id=folder_id)

    def _document_operation(
        self,
        principal: Principal,
        *,
        capability: Capability,
        action: str,
        current: Document,
        operation: Callable[[], T],
    ) -> T:
        def authorized() -> T:
            self.policy.require(principal, capability, current.path)
            return operation()

        return self._run(
            principal,
            action,
            "document",
            authorized,
            resource_id=current.document_id,
            path=current.path,
        )

    def _require_global_read(self, principal: Principal) -> None:
        self.policy.require(principal, Capability.READ, None)

    def _run(
        self,
        principal: Principal,
        action: str,
        resource_type: str,
        operation: Callable[[], T],
        *,
        resource_id: str | None = None,
        path: str | None = None,
    ) -> T:
        try:
            result = operation()
        except SangamError as error:
            outcome = (
                "denied"
                if isinstance(error, AuthorizationError)
                else "conflict"
                if isinstance(error, ConflictError)
                else "failed"
            )
            self.activity.record(
                principal=principal,
                action=action,
                resource_type=resource_type,
                resource_id=resource_id,
                path=path,
                outcome=outcome,
                error_code=error.code,
                details=error.details,
            )
            raise
        result_resource_id = resource_id
        result_path = path
        revision_id: str | None = None
        if isinstance(result, Document):
            result_resource_id = result.document_id
            result_path = result.path
            revision_id = result.current_revision_id
        if principal.identity_kind != "human" or action not in {
            "list",
            "search",
            "read",
            "history",
            "diff",
            "list_tags",
            "list_folders",
        }:
            self.activity.record(
                principal=principal,
                action=action,
                resource_type=resource_type,
                resource_id=result_resource_id,
                path=result_path,
                outcome="accepted",
                revision_id=revision_id,
            )
        return result
