from __future__ import annotations

from dataclasses import dataclass

from sangam.access import WorkspaceAccessService
from sangam.activity import ActivityService
from sangam.actors import ActorService
from sangam.authorization import AuthorizationPolicy
from sangam.backup import BackupManager
from sangam.backup_service import BackupService
from sangam.config import Settings
from sangam.db import Database, utc_now
from sangam.idempotency import IdempotencyStore
from sangam.karakeep import KarakeepService
from sangam.karakeep_extraction import KarakeepExtractor
from sangam.karakeep_gateway import KarakeepClient
from sangam.karakeep_repository import KarakeepRepository
from sangam.organization import WorkspaceOrganizationService
from sangam.pdf_research import PdfResearchService
from sangam.publication import PreviewTokenService, PublicationService
from sangam.reconciliation import ReconciliationPlanner, ReconciliationService
from sangam.search import SearchIndex
from sangam.security import AuthenticationService, CloudflareAccessVerifier, IdentityService
from sangam.service import DocumentService
from sangam.workspace import DiskWorkspaceFilesystem


@dataclass(frozen=True)
class ApplicationServices:
    """Application-level services assembled at the process boundary."""

    documents: DocumentService
    organization: WorkspaceOrganizationService
    reconciliation: ReconciliationService
    backups: BackupService
    workspace_access: WorkspaceAccessService
    identity: IdentityService
    authentication: AuthenticationService
    activity: ActivityService
    authorization: AuthorizationPolicy
    publications: PublicationService
    pdf_research: PdfResearchService
    karakeep: KarakeepService


def build_application_services(settings: Settings) -> ApplicationServices:
    """Construct Sangam's adapters and services in one explicit composition root."""
    settings.prepare()
    database = Database(settings.database_path)
    database.initialize()
    _bootstrap_actors(database, settings)
    workspace = DiskWorkspaceFilesystem(settings.workspace_root)
    idempotency = IdempotencyStore(database)
    actors = ActorService()
    organization = WorkspaceOrganizationService(
        database=database,
        workspace=workspace,
        idempotency=idempotency,
        actors=actors,
    )
    search_index = SearchIndex(database)
    documents = DocumentService(
        database=database,
        workspace=workspace,
        idempotency=idempotency,
        actors=actors,
        organization=organization,
        search_index=search_index,
        max_document_bytes=settings.max_document_bytes,
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
        actors=actors,
    )
    reconciliation = ReconciliationService(
        database=database,
        workspace=workspace,
        documents=documents,
        planner=ReconciliationPlanner(),
    )
    identity = IdentityService(database)
    access_verifier = None
    if settings.auth_mode == "cloudflare_access":
        if not all(
            (
                settings.cloudflare_access_team_domain,
                settings.cloudflare_access_audience,
                settings.cloudflare_access_email,
            )
        ):
            raise ValueError(
                "Cloudflare Access mode requires team domain, audience, and allowed email"
            )
        access_verifier = CloudflareAccessVerifier(
            team_domain=settings.cloudflare_access_team_domain or "",
            audience=settings.cloudflare_access_audience or "",
            allowed_email=settings.cloudflare_access_email or "",
        )
    authentication = AuthenticationService(
        identity=identity,
        auth_mode=settings.auth_mode,
        trusted_identity_value=settings.trusted_identity_value,
        trusted_human_actor_id=settings.trusted_human_actor_id,
        trusted_human_display_name=settings.trusted_human_display_name,
        access_identity_verifier=access_verifier,
    )
    activity = ActivityService(database)
    authorization = AuthorizationPolicy()
    publications = PublicationService(
        database=database,
        documents=documents,
        idempotency=idempotency,
        preview_tokens=PreviewTokenService(
            secret=settings.preview_hmac_secret.get_secret_value(),
            ttl_seconds=settings.preview_token_ttl_seconds,
            base_url=settings.trusted_preview_base_url,
        ),
        workspace=workspace,
        max_asset_bytes=settings.max_publication_asset_bytes,
        publication_base_url=settings.publication_base_url,
    )
    pdf_research = PdfResearchService(
        database=database,
        workspace=workspace,
        documents=documents,
        idempotency=idempotency,
        actors=actors,
        search_index=search_index,
        max_pdf_bytes=settings.max_pdf_bytes,
    )
    karakeep_client = None
    if settings.karakeep_base_url and settings.karakeep_api_key:
        karakeep_client = KarakeepClient(
            base_url=settings.karakeep_base_url,
            api_key=settings.karakeep_api_key.get_secret_value(),
            timeout_seconds=settings.karakeep_timeout_seconds,
        )
    karakeep = KarakeepService(
        documents=documents,
        organization=organization,
        client=karakeep_client,
        extractor=KarakeepExtractor(max_source_bytes=settings.max_karakeep_source_bytes),
        repository=KarakeepRepository(database),
    )
    karakeep.recover_interrupted_imports()
    workspace_access = WorkspaceAccessService(
        documents=documents,
        organization=organization,
        policy=authorization,
        activity=activity,
        publications=publications,
        pdf_research=pdf_research,
    )
    return ApplicationServices(
        documents=documents,
        organization=organization,
        reconciliation=reconciliation,
        backups=backups,
        workspace_access=workspace_access,
        identity=identity,
        authentication=authentication,
        activity=activity,
        authorization=authorization,
        publications=publications,
        pdf_research=pdf_research,
        karakeep=karakeep,
    )


def _bootstrap_actors(database: Database, settings: Settings) -> None:
    actors = (
        (
            settings.trusted_human_actor_id,
            settings.trusted_human_display_name,
            "human",
            "human",
        ),
        ("client:cli", "Sangam CLI", "client", "client"),
        ("system", "Sangam system", "system", "system"),
        ("system:reconcile", "Filesystem reconciliation", "system", "system"),
        ("integration:karakeep", "Karakeep importer", "client", "integration"),
    )
    with database.transaction() as connection:
        for actor_id, display_name, actor_type, identity_kind in actors:
            connection.execute(
                """
                INSERT INTO actors(
                    actor_id, display_name, actor_type, created_at, identity_kind
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(actor_id) DO UPDATE SET
                    display_name = excluded.display_name,
                    identity_kind = excluded.identity_kind
                """,
                (actor_id, display_name, actor_type, utc_now(), identity_kind),
            )
