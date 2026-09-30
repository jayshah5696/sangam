from __future__ import annotations

import hashlib
import os
from pathlib import Path
from types import TracebackType

if os.name == "nt":
    import msvcrt
else:
    import fcntl


class StorageOwnershipError(RuntimeError):
    """Raised when another process already owns one of Sangam's storage roots."""


_process_lifetime_ownerships: list[StorageOwnership] = []


class StorageOwnership:
    """Hold exclusive process locks for the database, workspace, and backup roots."""

    def __init__(self, resources: tuple[Path, ...]) -> None:
        self._descriptors: list[int] = []
        identities = sorted({path.expanduser().resolve() for path in resources}, key=str)
        try:
            for identity in identities:
                self._lock(identity)
            # Path locks cover first boot; an inode lock also rejects hard-link
            # aliases of an existing SQLite file, even with different roots.
            database = resources[0].expanduser().resolve()
            self._lock_descriptor(database, os.open(database, os.O_CREAT | os.O_RDWR, 0o600))
        except Exception:
            self.close()
            raise

    def _lock(self, identity: Path) -> None:
        identity.parent.mkdir(parents=True, exist_ok=True)
        digest = hashlib.sha256(os.fsencode(identity)).hexdigest()
        lock_path = identity.parent / f".sangam-owner-{digest}.lock"
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        self._lock_descriptor(identity, descriptor)

    def _lock_descriptor(self, identity: Path, descriptor: int) -> None:
        try:
            if os.name == "nt":
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            os.close(descriptor)
            raise StorageOwnershipError(
                f"Sangam storage at {identity} is already in use by another process"
            ) from error
        self._descriptors.append(descriptor)

    def close(self) -> None:
        while self._descriptors:
            os.close(self._descriptors.pop())

    def retain_until_process_exit(self) -> None:
        """Keep locks held when shutdown cannot prove all storage writers have stopped."""
        _process_lifetime_ownerships.append(self)

    def __enter__(self) -> StorageOwnership:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def __del__(self) -> None:
        self.close()
