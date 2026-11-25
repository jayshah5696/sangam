# Chat agent evals

Sangam includes a live-model evaluation harness for its chat agent. It runs 33
isolated tasks (25 core workspace tasks and 8 web research tasks) through the
production ChatKit request handler. Each task runs against its own seeded SQLite
database and workspace directory. Automated checks inspect tool arguments,
durable effects, and persisted workspace state. See
[chat-capabilities.md](chat-capabilities.md) for the capability contract under
test.

## Quickstart

```sh
just eval-chat          # 33 tasks in exact review mode (needs SANGAM_OPENROUTER_API_KEY)
just eval-chat-yolo     # same tasks in no-prompt YOLO mode
just eval-chat-policy   # credential-free deterministic policy and lifecycle tests
```

`just eval-chat` runs `openai/gpt-5.6-luna` with `medium` reasoning effort in
exact review mode. `just eval-chat-yolo` runs the same dataset in workspace YOLO
mode and verifies the resulting files, metadata, and publications. Both recipes
write JSON reports under `test-results/` and require `SANGAM_OPENROUTER_API_KEY`
in the environment or a local `.env` file.

`just eval-chat-policy` needs no API keys. It tests capability scopes, exact
approval, digest binding, stale state rejection, duplicate delivery,
cancellation, YOLO execution, materialized chat creation, and organization-plan
recovery.

To compare this checkout against another local checkout (e.g., `main`), run:

```sh
just eval-chat-against /path/to/baseline-sangam
```

That recipe runs this checkout's evaluation script against the other checkout's
installed `sangam` package so the only variable is the code under test.

## Core dataset cases

`scripts/evals/chat_eval_dataset.json` contains 33 tasks in total: 25 core
workspace tasks listed below plus 8 `web` tasks described in the next section.

| Cases | What they exercise |
| --- | --- |
| 3 edit tasks (FAQ insert, mid-document typo fix, changelog append) | `propose_update` patch modes; verifies the proposal exists, contains the requested edit, and preserves a canary string |
| 3 retrieval questions | `read_document` and `search_workspace`; verifies a canary fact and a citation link |
| 2 multi-hop questions | Combining facts across two documents |
| 1 publish request | Calling `publish_document` instead of claiming a document was published |
| 1 document creation request | Selecting exact HTML creation |
| 1 out-of-workspace question | Refusal without hallucinated citations or proposals |
| 3 organization tasks | Document move, folder creation with two moves, and existing-tag assignment |
| 2 organization safety tasks | Clarifying ambiguous titles and ignoring prompt injection inside documents |
| 1 language task | Replying in the language of the latest request |
| 5 lifecycle and history tasks | Trash, duplicate, create tag, restore, and revision history |
| 3 project tasks | List, create, and update projects |

Each task starts cleanly with its own seeded state (`trashed_documents` and
`projects` fixtures are declared per item), so no case depends on an earlier
case.

Production code resolves capabilities, builds instructions, pins turn context,
pauses on durable effects, and persists run evidence. Review cases stop at a
pending effect unless the item explicitly sets `decision` to `approve` or
`deny`. YOLO cases resume with the stored result through
`threads.add_client_tool_output`. The runner never fabricates an effect result.

## Web research cases

Eight `web` tasks test external research using frozen, fictional pages from
`scripts/evals/web_fixtures.json` and a clock frozen at `2026-10-10`, so live
web changes cannot cause false regressions. The fixture provider matches queries
by word overlap so several valid phrasings succeed.

The 8 cases cover a dated search, combining web and workspace sources,
conflicting sources, web research disabled, a workspace-only question, keeping
private workspace text out of search queries, ignoring instructions embedded in
fetched pages, and researching without saving changes.

Deterministic checks for web cases:

- `web_cited_sources_retrieved`: The answer links to at least one outside
  source, and every outside link was retrieved during that trial.
- `web_source_read:<url substring>`: The expected source was read.
- `no_web_query_contains:<text>`: No search query leaked the private canary
  text.
- `answer_not_contains:<text>`: Stale background was not stated as current fact.

Run the web family across repeated trials with source-support grading:

```sh
just eval-chat-web
```

This runs each web case five times with `openai/gpt-5.6-luna` and grades claim
support with `openai/gpt-5.6-sol`. The JSON report includes `first_attempt_rate`
and `all_trials_pass_rate` so a single lucky run cannot mask flakiness. Pass a
fourth argument to override the judge model. For a smaller targeted run:

```sh
just eval-chat-focused '--kind web --limit 1 --trials 1 --judge-model openai/gpt-5.6-sol --output test-results/chat-web-focused.json'
```

`just eval-chat` and `just eval-chat-yolo` check live model runs with
deterministic assertions. To add source-support grading, pass `--judge-model`
through `just eval-chat-focused`.

### Source-support grading

Deterministic checks prove that a cited link was retrieved, not that the source
text actually supports the claim. The optional source-support judge receives
only the final answer plus the exact search snippets and page windows returned
to the assistant. It has no tools and never sees model identity, full workspace
documents, or unretrieved fixture pages. Text inside answers and sources is
treated as untrusted data.

When external sources were observed but the answer contains no external
citations, a deterministic check fails the item before calling the judge.
Otherwise the judge scores each material external claim (such as dates, prices,
or attributed disagreements) as `pass`, `fail`, or `insufficient_evidence` with
a short reason and exact quotes. Code verifies that every claim appears in the
answer, every quote appears verbatim in the observed source text, and every
passing verdict cites an observed URL. Code checks cannot guarantee that the
judge found every claim or reasoned correctly about every nuance.

The JSON report records the judge model, rubric hash, observed source text,
per-claim findings, and separate judge token usage. It counts the three
verdicts separately. Provider errors, malformed
responses, invented quotes, empty verdicts, and packets over 120,000 characters
are marked ungraded and cannot pass `web_source_support`. Any failed check or
runtime error makes the runner exit with code `1`.

Check the judge against versioned reference labels before relying on its scores:

```sh
just eval-chat-source-judge
```

To compare the legacy retrieval-only check from baseline commit `c67ed3d`
against the source-support grader on the same frozen answers and sources, run:

```sh
just verify-chat-source-support
```

Pass a different local Git ref as the first argument to compare against another
baseline commit. The report records the baseline commit, evaluator source
hash, and frozen input hash. This compares grading on fixed answers and
sources. It does not measure changes in the assistant's answers.

The reference cases in `scripts/evals/source_judge_cases.json`
cover supported claims, wrong prices, insufficient snippets, missing citations,
conflicting dates, unsupported extra claims, and prompt injection aimed at the
grader. An agent wrote the reference labels. They have yet to receive independent
human review. The judge prompt excludes the reference labels. The report flags that status and records agreement,
pass precision, and pass recall against those draft labels. Treat it as an
integration check until human-reviewed held-out cases are added.

## Metrics and interpreting results

Each task records nested tool arguments, durable effect status and preview,
final workspace paths and tags, final answer, token usage, chat runs, and wall
time. One chat run is one initial request or effect continuation, not one model
response.

Aggregate metrics:

- `success_rate`: Fraction of tasks passing all per-item checks.
- `edit_success_rate`: Same rate restricted to edit tasks.
- `citation_rate` and `refusal_rate`: Grounding and out-of-scope refusal rates.
- `avg_chat_runs`, `avg_output_tokens`, `avg_wall_seconds`: Harness efficiency.

Each result lists the checks that failed. The dataset defines the check keys
for each task. Common keys include the following.

- `proposal_status_by_mode`: Review produced a pending proposal; YOLO applied it
  and matched the persisted document revision.
- `content_contains` / `content_not_contains`: Substring checks on resolved
  proposal content.
- `faq_heading_before_training_plan`: Structural ordering check for edits.
- `answer_contains` / `answer_matches_regex`: Substring and regex checks on the
  final answer.
- `citation_in_answer` / `no_citation_in_answer`: Citation format checks (not
  semantic support).
- `tool_called` / `tool_not_called`: Tool-selection checks.
- `effect_status_by_mode`: Review left a pending effect; workspace mode
  completed eligible private effects.
- `organization_kind` / `organization_path`: Stored organization plan contents.
- `workspace_path_by_mode` / `workspace_tag_by_mode`: Persisted state changed
  only in workspace mode.

The runner records `variant` (`patched` or `full-replace`) by inspecting whether
`ProposeUpdateInput` defines a `mode` field, keeping cross-version runs
comparable.

Treat a single live run as noisy. Frontier models vary across runs, so confirm
pass/fail changes with a second run before acting on them. Structural token and
latency differences on edit tasks reproduce more reliably.

## CLI flags

| Flag | Meaning |
| --- | --- |
| `--dataset PATH` | Path to eval dataset JSON (default `scripts/evals/chat_eval_dataset.json`). |
| `--output PATH` | Write full JSON results to this path. |
| `--kind KIND` | Run only items of one kind (e.g., `web`). |
| `--trials N` | Repeat each item `N` times (default `1`; `just eval-chat-web` uses `5`). |
| `--limit N` | Run only the first `N` items for smoke checks. |
| `--web-off` | Serve no web tools to reproduce behavior with web research disabled. |
| `--model ID` | OpenRouter model slug under test (default `openai/gpt-5.6-luna`). |
| `--reasoning-effort PRESET` | Reasoning preset (`none`, `low`, `medium`, `high`, `xhigh`, `max`; default `medium`). |
| `--autonomy-mode MODE` | Exact `review` mode or no-prompt `workspace` YOLO mode. |
| `--judge-model ID` | Grade external claim support with a separate OpenRouter model. |
| `--judge-cases PATH` | Compare the source judge against reference cases JSON (requires `--judge-model`). |
| `--baseline-ref REF` | Run the retrieval check from a Git ref on the same judge cases (requires `--judge-cases`, which requires `--judge-model`). |
| `--timeout SECS` | Per-item timeout in seconds (default `300`). |
| `--env-file PATH` | Extra `.env` file for `SANGAM_OPENROUTER_API_KEY`. |
