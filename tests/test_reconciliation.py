from __future__ import annotations

from sangam.reconciliation import (
    MaterializedDocumentSnapshot,
    PlannedConflict,
    ReconciliationPlanner,
)


def snapshot(document_id: str, path: str, content_hash: str) -> MaterializedDocumentSnapshot:
    return MaterializedDocumentSnapshot(
        document_id=document_id,
        path=path,
        content_hash=content_hash,
    )


def test_missing_document_without_move_candidate_is_rematerialized() -> None:
    plan = ReconciliationPlanner().plan([snapshot("document-1", "missing.md", "head")], {})

    assert plan.rematerialize_document_ids == ("document-1",)
    assert plan.conflicts == ()


def test_unique_move_candidate_is_identified() -> None:
    plan = ReconciliationPlanner().plan(
        [snapshot("document-1", "old.md", "same")],
        {"new.md": "same"},
    )

    assert plan.rematerialize_document_ids == ()
    assert plan.conflicts == (
        PlannedConflict(
            conflict_type="possible_move",
            document_id="document-1",
            path="old.md",
            candidate_path="new.md",
            expected_hash="same",
            actual_hash="same",
        ),
    )


def test_move_candidate_is_ambiguous_when_multiple_documents_share_a_hash() -> None:
    plan = ReconciliationPlanner().plan(
        [
            snapshot("document-1", "first.md", "same"),
            snapshot("document-2", "second.md", "same"),
        ],
        {"moved.md": "same"},
    )

    assert [conflict.candidate_path for conflict in plan.conflicts] == [None, None]
    assert {conflict.document_id for conflict in plan.conflicts} == {
        "document-1",
        "document-2",
    }


def test_hash_mismatch_and_unrelated_file_become_conflicts() -> None:
    plan = ReconciliationPlanner().plan(
        [snapshot("document-1", "known.md", "expected")],
        {"known.md": "changed", "unknown.md": "other"},
    )

    assert plan.rematerialize_document_ids == ()
    assert plan.conflicts == (
        PlannedConflict(
            conflict_type="unexpected_hash",
            document_id="document-1",
            path="known.md",
            expected_hash="expected",
            actual_hash="changed",
        ),
        PlannedConflict(
            conflict_type="unknown_file",
            document_id=None,
            path="unknown.md",
            actual_hash="other",
        ),
    )
