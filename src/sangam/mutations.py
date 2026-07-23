from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager


class MutationCoordinator:
    """Coordinates document pipelines with generation-consistent snapshots.

    Document mutations may proceed concurrently for different documents, but a
    mutation for one document owns its complete database/materialization/search
    pipeline. Backups take an exclusive generation barrier and therefore observe
    neither half of an in-flight mutation.
    """

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._active_mutations = 0
        self._backup_active = False
        self._waiting_backups = 0
        self._document_locks: dict[str, threading.RLock] = {}
        self._document_lock_users: dict[str, int] = {}
        self._creation_lock = threading.RLock()

    @contextmanager
    def creation(self) -> Iterator[None]:
        """Serialize idempotent identity selection for newly created documents."""
        with self._creation_lock:
            yield

    @contextmanager
    def document(self, document_id: str) -> Iterator[None]:
        lock = self._retain_document_lock(document_id)
        try:
            with lock, self.mutation():
                yield
        finally:
            self._release_document_lock(document_id)

    @contextmanager
    def mutation(self) -> Iterator[None]:
        """Enter a mutation generation without requiring a document identity."""
        with self._condition:
            while self._backup_active or self._waiting_backups:
                self._condition.wait()
            self._active_mutations += 1
        try:
            yield
        finally:
            with self._condition:
                self._active_mutations -= 1
                if self._active_mutations == 0:
                    self._condition.notify_all()

    @contextmanager
    def backup(self) -> Iterator[None]:
        """Exclude mutations while a database/workspace generation is captured."""
        with self._condition:
            self._waiting_backups += 1
            try:
                while self._backup_active or self._active_mutations:
                    self._condition.wait()
            finally:
                self._waiting_backups -= 1
            self._backup_active = True
        try:
            yield
        finally:
            with self._condition:
                self._backup_active = False
                self._condition.notify_all()

    def _retain_document_lock(self, document_id: str) -> threading.RLock:
        with self._condition:
            lock = self._document_locks.setdefault(document_id, threading.RLock())
            self._document_lock_users[document_id] = (
                self._document_lock_users.get(document_id, 0) + 1
            )
            return lock

    def _release_document_lock(self, document_id: str) -> None:
        with self._condition:
            remaining = self._document_lock_users[document_id] - 1
            if remaining:
                self._document_lock_users[document_id] = remaining
            else:
                del self._document_lock_users[document_id]
                del self._document_locks[document_id]
