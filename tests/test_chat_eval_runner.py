"""Exercise eval lifecycle failures through production ChatKit with scripted inference."""

from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path

import pytest

from sangam.chat_models import Call, Say, ScriptedModelProvider

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "run_chat_evals.py"
spec = importlib.util.spec_from_file_location("run_chat_evals", SCRIPT)
assert spec is not None and spec.loader is not None
evals = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = evals
spec.loader.exec_module(evals)


@pytest.mark.parametrize(
    "mode,status,persisted_content,persisted_revision,passed",
    [
        ("review", "pending", "original", "old", True),
        ("review", "applied", "edited", "new", False),
        ("workspace", "applied", "edited", "new", True),
        ("workspace", "pending", "original", "old", False),
        ("workspace", "applied", "different", "new", False),
        ("workspace", "applied", "edited", "later", False),
    ],
)
def test_edit_grading_matches_policy_and_persisted_revision(
    mode: str,
    status: str,
    persisted_content: str,
    persisted_revision: str,
    passed: bool,
) -> None:
    outcome = {
        "final_text": "",
        "tool_calls": [],
        "effects": [],
        "autonomy_mode": mode,
        "proposal": {"status": status, "content": "edited", "applied_revision_id": "new"},
        "edited_document_content": persisted_content,
        "edited_document_revision_id": persisted_revision,
    }
    assert evals.evaluate_checks({"checks": ["proposal_status_by_mode"]}, outcome) == {
        "proposal_status_by_mode": passed
    }


@pytest.mark.parametrize(
    "mode,decision,status",
    [
        ("review", None, "pending_approval"),
        ("review", "approve", "completed"),
        ("review", "deny", "denied"),
        ("workspace", None, "completed"),
    ],
)
def test_eval_stops_at_effect_and_resumes_only_with_stored_result(
    tmp_path: Path, mode: str, decision: str | None, status: str
) -> None:
    async def exercise() -> None:
        env = evals.EvalEnvironment("sk-test", tmp_path, mode)
        env.seed(evals._seed_documents())
        seen = []
        steps = [
            Call(
                "update_project",
                {
                    "change": {"kind": "create_project", "name": "Atlas", "create_brief": False},
                },
            )
        ]
        if decision or mode == "workspace":
            steps.append(Say("The stored result is available."))
        env.services.chat._model_provider = ScriptedModelProvider(steps, seen)
        item = {"id": "create", "question": "Create Atlas", "decision": decision}
        try:
            outcome = await evals.run_item(item, env, evals.DEFAULT_MODEL, "medium", 15)
            assert outcome["error"] is None
            assert outcome["effects"][0]["status"] == status
            assert len(seen) == (2 if decision or mode == "workspace" else 1)
            projects = env.services.projects.list_projects(env.principal)
            assert [project.name for project in projects] == (
                ["Atlas"] if status == "completed" else []
            )
            if len(seen) == 2:
                assert any(
                    value.get("type") == "function_call_output"
                    for value in seen[1]
                    if isinstance(value, dict)
                )
            else:
                assert outcome["final_text"] == ""
        finally:
            await env.services.chat.close()

    asyncio.run(exercise())


def test_independent_case_fixtures_do_not_inherit_mutations(tmp_path: Path) -> None:
    async def exercise() -> None:
        first = evals.EvalEnvironment("sk-test", tmp_path / "first", "workspace")
        second = evals.EvalEnvironment("sk-test", tmp_path / "second", "workspace")
        try:
            first.seed(evals._seed_documents())
            first.seed_case({"fixtures": {"trashed_documents": ["release-notes"]}})
            second.seed(evals._seed_documents())
            second.seed_case({"fixtures": {"projects": [{"name": "Market sizing"}]}})
            assert first.services.workspace_access.get_document(
                first.principal,
                first.documents_by_seed["release-notes"].document_id,
                include_deleted=True,
            ).deleted
            assert not second.services.workspace_access.get_document(
                second.principal, second.documents_by_seed["release-notes"].document_id
            ).deleted
            assert first.services.projects.list_projects(first.principal) == []
            assert [
                project.name for project in second.services.projects.list_projects(second.principal)
            ] == ["Market sizing"]
        finally:
            await first.services.chat.close()
            await second.services.chat.close()

    asyncio.run(exercise())
