from __future__ import annotations

from sangam.actors import ActorService
from sangam.backup import BackupManager
from sangam.db import Database
from sangam.errors import NotFoundError
from sangam.idempotency import IdempotencyStore, request_hash
from sangam.schemas import BackupSet, BackupVerification


class BackupService:
    """Coordinates backup policy while the manager owns backup artifacts."""

    def __init__(
        self,
        *,
        database: Database,
        idempotency: IdempotencyStore,
        manager: BackupManager,
        actors: ActorService,
    ) -> None:
        self.database = database
        self.idempotency = idempotency
        self.manager = manager
        self.actors = actors

    def list(self) -> list[BackupSet]:
        return self.manager.list()

    def create(self, *, actor_id: str, idempotency_key: str) -> BackupSet:
        fingerprint = request_hash({"operation": "create_backup"})
        with self.database.transaction() as connection:
            self.actors.require_known(connection, actor_id)
            duplicate = self.idempotency.mutation_record(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="create_backup",
                request_hash=fingerprint,
            )
            if duplicate:
                backup_id = duplicate.resource_id
                completed = duplicate.completed_at is not None
            else:
                backup_id = self.manager.new_backup_id()
                completed = False
                self.idempotency.record_mutation(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="create_backup",
                    request_hash=fingerprint,
                    resource_type="backup",
                    resource_id=backup_id,
                    completed=False,
                )
        try:
            backup = self.manager.get(backup_id)
        except NotFoundError:
            if completed:
                raise NotFoundError("Idempotent backup result is no longer retained") from None
            backup = self.manager.create(backup_id=backup_id)
        if backup.verified_at is None:
            self.manager.verify(backup_id)
            backup = self.manager.get(backup_id)
        if not completed:
            self.idempotency.complete_mutation(
                actor_id=actor_id, key=idempotency_key, resource_id=backup_id
            )
        return backup

    def verify(self, backup_id: str) -> BackupVerification:
        return self.manager.verify(backup_id)

    def create_if_due(self) -> BackupSet | None:
        return self.manager.create_if_due()
