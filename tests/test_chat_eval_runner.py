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


WEB_URL = "https://vrweekly.example.com/meridian-flow-announced"


def _web_item() -> dict:
    return {
        "id": "web",
        "kind": "web",
        "web": "fixture",
        "question": "What is new in standalone headsets this October?",
        "checks": [
            "tool_called:search_web",
            "web_source_read:meridian-flow-announced",
            "web_cited_sources_retrieved",
            "no_web_query_contains:Falcon",
            "answer_not_contains:Orbit One",
            "no_effect",
        ],
    }


def _run_web_item(tmp_path: Path, answer: str) -> tuple[dict, dict]:
    from sangam.web_research import source_id

    async def exercise() -> tuple[dict, dict]:
        env = evals.EvalEnvironment("sk-test", tmp_path, "review")
        env.seed(evals._seed_documents())
        item = _web_item()
        env.seed_case(item)
        env.services.chat._model_provider = ScriptedModelProvider(
            [
                Call(
                    "search_web",
                    {"query": "standalone headset", "published_after": "2026-10-01"},
                ),
                Call("read_web_source", {"source_id": source_id(WEB_URL)}),
                Say(answer),
            ],
            [],
        )
        try:
            outcome = await evals.run_item(item, env, evals.DEFAULT_MODEL, "medium", 15)
        finally:
            await env.services.chat.close()
        outcome["autonomy_mode"] = "review"
        return item, outcome

    return asyncio.run(exercise())


def test_web_eval_grades_only_sources_retrieved_in_the_trial(tmp_path: Path) -> None:
    item, outcome = _run_web_item(tmp_path / "ok", f"Meridian announced the Flow. [src]({WEB_URL})")
    assert outcome["error"] is None
    # The frozen clock and date bound excluded the 2024 review from search results.
    assert "https://vrweekly.example.com/orbit-one-review" not in {
        s["url"] for s in outcome["web_sources"]
    }
    assert all(evals.evaluate_checks(item, outcome).values())

    _, fabricated = _run_web_item(
        tmp_path / "bad", "Meridian announced the Flow. [src](https://made-up.example.com/x)"
    )
    checks = evals.evaluate_checks(item, fabricated)
    assert checks["web_cited_sources_retrieved"] is False


def test_trials_report_first_attempt_and_all_trials_rates() -> None:
    def record(case: str, trial: int, passed: bool) -> dict:
        return {
            "id": case,
            "trial": trial,
            "kind": "web",
            "passed": passed,
            "checks": {},
            "final_text": "",
            "error": None,
            "chat_runs": 1,
            "output_tokens": 0,
            "wall_seconds": 0,
        }

    summary = evals.aggregate(
        [
            record("a", 0, True),
            record("a", 1, False),
            record("b", 0, True),
            record("b", 1, True),
        ]
    )
    assert summary["first_attempt_rate"] == 1.0
    assert summary["all_trials_pass_rate"] == 0.5
