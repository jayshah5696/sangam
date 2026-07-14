from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class MaterializedDocumentSnapshot:
    document_id: str
    path: str
    content_hash: str


@dataclass(frozen=True)
class PlannedConflict:
    conflict_type: Literal["unexpected_hash", "possible_move", "unknown_file"]
    document_id: str | None
    path: str
    candidate_path: str | None = None
    expected_hash: str | None = None
    actual_hash: str | None = None


@dataclass(frozen=True)
class ReconciliationPlan:
    rematerialize_document_ids: tuple[str, ...]
    conflicts: tuple[PlannedConflict, ...]


class ReconciliationPlanner:
    def plan(
        self,
        documents: Sequence[MaterializedDocumentSnapshot],
        disk_files: Mapping[str, str],
    ) -> ReconciliationPlan:
        known_paths = {document.path for document in documents}
        unknown_paths = sorted(path for path in disk_files if path not in known_paths)
        missing = [document for document in documents if document.path not in disk_files]

        unknown_paths_by_hash: dict[str, list[str]] = defaultdict(list)
        for path in unknown_paths:
            unknown_paths_by_hash[disk_files[path]].append(path)

        missing_documents_by_hash: dict[str, list[MaterializedDocumentSnapshot]] = defaultdict(list)
        for document in missing:
            missing_documents_by_hash[document.content_hash].append(document)

        rematerialize: list[str] = []
        conflicts: list[PlannedConflict] = []
        move_candidate_paths: set[str] = set()
        for document in missing:
            matches = unknown_paths_by_hash.get(document.content_hash, [])
            if not matches:
                rematerialize.append(document.document_id)
                continue
            move_candidate_paths.update(matches)
            unambiguous = (
                len(matches) == 1
                and len(missing_documents_by_hash[document.content_hash]) == 1
            )
            conflicts.append(
                PlannedConflict(
                    conflict_type="possible_move",
                    document_id=document.document_id,
                    path=document.path,
                    candidate_path=matches[0] if unambiguous else None,
                    expected_hash=document.content_hash,
                    actual_hash=document.content_hash,
                )
            )

        for document in documents:
            actual_hash = disk_files.get(document.path)
            if actual_hash is not None and actual_hash != document.content_hash:
                conflicts.append(
                    PlannedConflict(
                        conflict_type="unexpected_hash",
                        document_id=document.document_id,
                        path=document.path,
                        expected_hash=document.content_hash,
                        actual_hash=actual_hash,
                    )
                )

        for path in unknown_paths:
            if path not in move_candidate_paths:
                conflicts.append(
                    PlannedConflict(
                        conflict_type="unknown_file",
                        document_id=None,
                        path=path,
                        actual_hash=disk_files[path],
                    )
                )

        return ReconciliationPlan(
            rematerialize_document_ids=tuple(rematerialize),
            conflicts=tuple(conflicts),
        )
