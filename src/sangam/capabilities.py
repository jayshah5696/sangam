from __future__ import annotations

from enum import StrEnum


class Capability(StrEnum):
    """Workspace authority names shared by API schemas and authorization policy."""

    READ = "read"
    SEARCH = "search"
    CREATE = "create"
    UPDATE = "update"
    MOVE = "move"
    TAG = "tag"
    RESTORE = "restore"
    DELETE = "delete"
