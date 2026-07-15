from __future__ import annotations

from dataclasses import dataclass

from sangam.backup import BackupManager
from sangam.backup_service import BackupService
from sangam.config import Settings
from sangam.db import Database, utc_now
from sangam.idempotency import IdempotencyStore
from sangam.organization import WorkspaceOrganizationService
from sangam.reconciliation import ReconciliationPlanner, ReconciliationService
from sangam.search import SearchIndex
from sangam.service import DocumentService
from sangam.workspace import DiskWorkspaceFilesystem


@dataclass(frozen=True)
class ApplicationServices:
    """Application-level services assembled at the process boundary."""

    documents: DocumentService
    organization: WorkspaceOrganizationService
    reconciliation: ReconciliationService
    backups: BackupService


def build_application_services(settings: Settings) -> ApplicationServices:
    """Construct Sangam's adapters and services in one explicit composition root."""
    settings.prepare()
    database = Database(settings.database_path)
    database.initialize()
    _bootstrap_actors(database)
    workspace = DiskWorkspaceFilesystem(settings.workspace_root)
    idempotency = IdempotencyStore(database)
    organization = WorkspaceOrganizationService(
        database=database,
        workspace=workspace,
        idempotency=idempotency,
    )
    search_index = SearchIndex(database)
    documents = DocumentService(
        database=database,
        workspace=workspace,
        idempotency=idempotency,
        organization=organization,
        search_index=search_index,
    )
    search_index.rebuild(documents.list_documents(include_deleted=True))
    backup_manager = BackupManager(
        database=database,
        workspace_root=settings.workspace_root,
        backup_root=settings.backup_root,
        retention_count=settings.backup_retention_count,
    )
    backups = BackupService(
        database=database,
        idempotency=idempotency,
        manager=backup_manager,
    )
    reconciliation = ReconciliationService(
        database=database,
        workspace=workspace,
        documents=documents,
        planner=ReconciliationPlanner(),
    )
    return ApplicationServices(
        documents=documents,
        organization=organization,
        reconciliation=reconciliation,
        backups=backups,
    )


def _bootstrap_actors(database: Database) -> None:
    actors = (
        ("human:jay", "Jay", "human"),
        ("client:cli", "Sangam CLI", "client"),
        ("system", "Sangam system", "system"),
        ("system:reconcile", "Filesystem reconciliation", "system"),
    )
    with database.transaction() as connection:
        for actor_id, display_name, actor_type in actors:
            connection.execute(
                """
                INSERT OR IGNORE INTO actors(actor_id, display_name, actor_type, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (actor_id, display_name, actor_type, utc_now()),
            )
