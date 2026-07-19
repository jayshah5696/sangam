from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import PurePosixPath

from sangam.actors import ActorService
from sangam.db import Database, utc_now
from sangam.errors import ConflictError, NotFoundError, ValidationError
from sangam.idempotency import IdempotencyStore, request_hash
from sangam.schemas import Folder, Tag
from sangam.workspace import WorkspaceFilesystem


class WorkspaceOrganizationService:
    """Owns folder, tag, and organization metadata transactions."""

    def __init__(
        self,
        *,
        database: Database,
        workspace: WorkspaceFilesystem,
        idempotency: IdempotencyStore,
        actors: ActorService,
    ) -> None:
        self.database = database
        self.workspace = workspace
        self.idempotency = idempotency
        self.actors = actors

    def normalize_folder_path(self, raw_path: str) -> str:
        return self.workspace.normalize_folder_path(raw_path)

    def ensure_document_folder_hierarchy(
        self, connection: sqlite3.Connection, document_path: str
    ) -> None:
        parent = PurePosixPath(document_path).parent
        if parent != PurePosixPath("."):
            self.ensure_folder_path_hierarchy(connection, parent.as_posix())

    @staticmethod
    def ensure_folder_path_hierarchy(connection: sqlite3.Connection, folder_path: str) -> None:
        now = utc_now()
        parts: list[str] = []
        for part in PurePosixPath(folder_path).parts:
            parts.append(part)
            current_path = "/".join(parts)
            connection.execute(
                """
                INSERT OR IGNORE INTO folders(
                    folder_id, path, name, category, metadata_version, created_at, updated_at
                ) VALUES (?, ?, ?, NULL, 0, ?, ?)
                """,
                (str(uuid.uuid4()), current_path, part, now, now),
            )

    @staticmethod
    def validate_tag_ids(connection: sqlite3.Connection, tag_ids: list[str]) -> list[str]:
        unique_ids = list(dict.fromkeys(tag_ids))
        if not unique_ids:
            return []
        placeholders = ",".join("?" for _ in unique_ids)
        rows = connection.execute(
            f"SELECT tag_id FROM tags WHERE tag_id IN ({placeholders})", unique_ids
        ).fetchall()
        found = {row["tag_id"] for row in rows}
        missing = [tag_id for tag_id in unique_ids if tag_id not in found]
        if missing:
            raise ValidationError("One or more tags do not exist", details={"tag_ids": missing})
        return unique_ids

    def list_tags(self) -> list[Tag]:
        with self.database.connection() as connection:
            rows = connection.execute("SELECT * FROM tags ORDER BY name COLLATE NOCASE").fetchall()
        return [Tag.model_validate(dict(row)) for row in rows]

    def create_tag(self, *, name: str, color: str, actor_id: str, idempotency_key: str) -> Tag:
        normalized_name = " ".join(name.strip().split())
        if not normalized_name:
            raise ValidationError("Tag name cannot be blank")
        normalized_color = color.lower()
        fingerprint = request_hash({"name": normalized_name, "color": normalized_color})
        with self.database.transaction() as connection:
            self.actors.require_known(connection, actor_id)
            duplicate = self.idempotency.mutation_record(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="create_tag",
                request_hash=fingerprint,
            )
            if duplicate:
                tag_id = duplicate.resource_id
            else:
                existing = connection.execute(
                    "SELECT * FROM tags WHERE name = ? COLLATE NOCASE", (normalized_name,)
                ).fetchone()
                if existing:
                    tag_id = existing["tag_id"]
                else:
                    now = utc_now()
                    tag_id = str(uuid.uuid4())
                    connection.execute(
                        "INSERT INTO tags(tag_id, name, color, created_at) VALUES (?, ?, ?, ?)",
                        (tag_id, normalized_name, normalized_color, now),
                    )
                    after = {
                        "tag_id": tag_id,
                        "name": normalized_name,
                        "color": normalized_color,
                        "created_at": now,
                    }
                    connection.execute(
                        """
                        INSERT INTO metadata_events(
                            event_id, entity_type, entity_id, actor_id,
                            operation, before_json, after_json, created_at
                        ) VALUES (?, 'tag', ?, ?, 'create', NULL, ?, ?)
                        """,
                        (str(uuid.uuid4()), tag_id, actor_id, json.dumps(after), now),
                    )
                self.idempotency.record_mutation(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="create_tag",
                    request_hash=fingerprint,
                    resource_type="tag",
                    resource_id=tag_id,
                )
            row = connection.execute("SELECT * FROM tags WHERE tag_id = ?", (tag_id,)).fetchone()
            if row is None:
                raise RuntimeError("Idempotent tag result could not be reloaded")
            return Tag.model_validate(dict(row))

    def list_folders(self) -> list[Folder]:
        with self.database.connection() as connection:
            rows = connection.execute(
                "SELECT * FROM folders ORDER BY path COLLATE NOCASE"
            ).fetchall()
            return [self._folder_from_row(connection, row) for row in rows]

    def create_folder(
        self,
        *,
        path: str,
        category: str | None,
        tag_ids: list[str],
        actor_id: str,
        idempotency_key: str,
    ) -> Folder:
        normalized_path = self.normalize_folder_path(path)
        normalized_category = category.strip() if category and category.strip() else None
        fingerprint = request_hash(
            {
                "path": normalized_path,
                "category": normalized_category,
                "tag_ids": sorted(set(tag_ids)),
            }
        )
        with self.database.transaction() as connection:
            self.actors.require_known(connection, actor_id)
            duplicate = self.idempotency.mutation_record(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="create_folder",
                request_hash=fingerprint,
            )
            if duplicate:
                folder_id = duplicate.resource_id
            else:
                valid_tag_ids = self.validate_tag_ids(connection, tag_ids)
                target_existed = (
                    connection.execute(
                        "SELECT 1 FROM folders WHERE path = ?", (normalized_path,)
                    ).fetchone()
                    is not None
                )
                self.ensure_folder_path_hierarchy(connection, normalized_path)
                row = connection.execute(
                    "SELECT * FROM folders WHERE path = ?", (normalized_path,)
                ).fetchone()
                if row is None:
                    raise RuntimeError("Folder hierarchy creation did not return its target")
                folder_id = row["folder_id"]
                current_tag_rows = connection.execute(
                    "SELECT tag_id FROM folder_tags WHERE folder_id = ? ORDER BY tag_id",
                    (folder_id,),
                ).fetchall()
                current_tag_ids = [tag_row["tag_id"] for tag_row in current_tag_rows]
                metadata_unchanged = (
                    target_existed
                    and row["category"] == normalized_category
                    and set(current_tag_ids) == set(valid_tag_ids)
                )
                if not metadata_unchanged:
                    self._write_folder_metadata(
                        connection,
                        row=row,
                        category=normalized_category,
                        tag_ids=valid_tag_ids,
                        actor_id=actor_id,
                        operation="create_or_organize",
                    )
                self.idempotency.record_mutation(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="create_folder",
                    request_hash=fingerprint,
                    resource_type="folder",
                    resource_id=folder_id,
                )
            row = connection.execute(
                "SELECT * FROM folders WHERE folder_id = ?", (folder_id,)
            ).fetchone()
            if row is None:
                raise RuntimeError("Idempotent folder result could not be reloaded")
            result = self._folder_from_row(connection, row)
        self.workspace.create_folder(normalized_path)
        return result

    def update_folder_metadata(
        self,
        *,
        folder_id: str,
        expected_metadata_version: int,
        category: str | None,
        tag_ids: list[str],
        actor_id: str,
        idempotency_key: str,
    ) -> Folder:
        normalized_category = category.strip() if category and category.strip() else None
        fingerprint = request_hash(
            {
                "folder_id": folder_id,
                "expected_metadata_version": expected_metadata_version,
                "category": normalized_category,
                "tag_ids": sorted(set(tag_ids)),
            }
        )
        with self.database.transaction() as connection:
            self.actors.require_known(connection, actor_id)
            duplicate = self.idempotency.mutation_record(
                connection,
                actor_id=actor_id,
                key=idempotency_key,
                operation="update_folder_metadata",
                request_hash=fingerprint,
            )
            row = connection.execute(
                "SELECT * FROM folders WHERE folder_id = ?", (folder_id,)
            ).fetchone()
            if not row:
                raise NotFoundError(f"Folder not found: {folder_id}")
            if duplicate is None:
                if row["metadata_version"] != expected_metadata_version:
                    raise ConflictError(
                        "Folder metadata changed since it was read",
                        details={
                            "folder_id": folder_id,
                            "expected_metadata_version": expected_metadata_version,
                            "current_metadata_version": row["metadata_version"],
                        },
                    )
                valid_tag_ids = self.validate_tag_ids(connection, tag_ids)
                self._write_folder_metadata(
                    connection,
                    row=row,
                    category=normalized_category,
                    tag_ids=valid_tag_ids,
                    actor_id=actor_id,
                    operation="organize",
                )
                self.idempotency.record_mutation(
                    connection,
                    actor_id=actor_id,
                    key=idempotency_key,
                    operation="update_folder_metadata",
                    request_hash=fingerprint,
                    resource_type="folder",
                    resource_id=folder_id,
                )
            updated = connection.execute(
                "SELECT * FROM folders WHERE folder_id = ?", (folder_id,)
            ).fetchone()
            if updated is None:
                raise RuntimeError("Updated folder could not be reloaded")
            return self._folder_from_row(connection, updated)

    @staticmethod
    def _folder_from_row(connection: sqlite3.Connection, row: sqlite3.Row) -> Folder:
        tag_rows = connection.execute(
            """
            SELECT t.* FROM tags t
            JOIN folder_tags ft ON ft.tag_id = t.tag_id
            WHERE ft.folder_id = ?
            ORDER BY t.name COLLATE NOCASE
            """,
            (row["folder_id"],),
        ).fetchall()
        count = connection.execute(
            """
            SELECT count(*) FROM documents
            WHERE deleted = 0 AND path LIKE ?
            """,
            (f"{row['path']}/%",),
        ).fetchone()[0]
        return Folder(
            folder_id=row["folder_id"],
            path=row["path"],
            name=row["name"],
            category=row["category"],
            metadata_version=row["metadata_version"],
            tags=[Tag.model_validate(dict(tag_row)) for tag_row in tag_rows],
            document_count=count,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _write_folder_metadata(
        connection: sqlite3.Connection,
        *,
        row: sqlite3.Row,
        category: str | None,
        tag_ids: list[str],
        actor_id: str,
        operation: str,
    ) -> None:
        folder_id = row["folder_id"]
        current_tags = connection.execute(
            "SELECT tag_id FROM folder_tags WHERE folder_id = ? ORDER BY tag_id", (folder_id,)
        ).fetchall()
        before = {
            "path": row["path"],
            "category": row["category"],
            "tag_ids": [tag["tag_id"] for tag in current_tags],
            "metadata_version": row["metadata_version"],
        }
        now = utc_now()
        connection.execute(
            """
            UPDATE folders
            SET category = ?, metadata_version = metadata_version + 1, updated_at = ?
            WHERE folder_id = ?
            """,
            (category, now, folder_id),
        )
        connection.execute("DELETE FROM folder_tags WHERE folder_id = ?", (folder_id,))
        connection.executemany(
            "INSERT INTO folder_tags(folder_id, tag_id) VALUES (?, ?)",
            [(folder_id, tag_id) for tag_id in tag_ids],
        )
        after = {
            "path": row["path"],
            "category": category,
            "tag_ids": tag_ids,
            "metadata_version": row["metadata_version"] + 1,
        }
        connection.execute(
            """
            INSERT INTO metadata_events(
                event_id, entity_type, entity_id, actor_id,
                operation, before_json, after_json, created_at
            ) VALUES (?, 'folder', ?, ?, ?, ?, ?, ?)
            """,
            (
                str(uuid.uuid4()),
                folder_id,
                actor_id,
                operation,
                json.dumps(before),
                json.dumps(after),
                now,
            ),
        )
