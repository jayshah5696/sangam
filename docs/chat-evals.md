# Chat agent evals

A live-model eval harness for Sangam's chat agent. It runs 33 tasks through the production ChatKit request handler. Each case has its own seeded database and workspace. Checks inspect tool arguments, durable effects, and persisted workspace outcomes. See [chat-capabilities.md](chat-capabilities.md) for the contract under test.

## Quickstart

```sh
just eval-chat
just eval-chat-yolo
just eval-chat-policy
```

`just eval-chat` runs GPT-5.6 Luna with medium reasoning and exact review. `just eval-chat-yolo` runs the same cases in no-prompt YOLO mode and verifies the resulting files, metadata, and publications. Both commands write JSON under `test-results/` and need `SANGAM_OPENROUTER_API_KEY` in the environment or a local `.env`.

`just eval-chat-policy` is credential-free. It verifies capability scopes, exact approval, digest binding, stale state, duplicate delivery, cancellation, no-prompt YOLO execution, materialized chat creation, and organization-plan recovery.

To compare against another checkout, for example to show what a harness change improved on `main`:

```sh
just eval-chat-against /Users/jshah/Documents/GitHub/sangam
```

The recipe runs this checkout's eval script with the other checkout's installed `sangam` package, so the only variable is the code under test.

## Web research cases

Eight `web` cases cover outside research. They serve frozen, fictional pages from `scripts/evals/web_fixtures.json` through a fixture provider and freeze the clock at 2026-10-10, so a live-web change cannot look like a regression. The fixture provider matches by word overlap, so several valid queries succeed.

The cases cover a dated search, mixing outside sources with a workspace note, conflicting sources, web turned off, a workspace-only request, private text kept out of queries, instructions inside a page, and research that must not save anything. Checks added for them:

- `web_cited_sources_retrieved` — the answer links to at least one outside source, and every outside link was retrieved in the trial.
- `web_source_read:<url substring>` — that source was actually read.
- `no_web_query_contains:<text>` — no search query contained the private text.
- `answer_not_contains:<text>` — for example, stale background was not presented as current.

These checks are code checks. Whether a source supports a claim is not graded yet; the cited-source check only proves the link was retrieved. A calibrated model grader for source support is still to do.

Run the family with repeated trials:

```sh
just eval-chat-web
```

It runs each case five times. The report gives `first_attempt_rate` and `all_trials_pass_rate`, so one lucky trial cannot hide a failure. `--kind web`, `--trials N`, `--limit N`, and `--web-off` (serve no web tools, to reproduce the behavior before web research) work with `scripts/run_chat_evals.py` directly.

## What the suite measures

The dataset in `scripts/evals/chat_eval_dataset.json` covers 25 cases:

| Case | What it exercises |
| --- | --- |
| 3 edit tasks (FAQ insertion, mid-document typo fix, changelog append) | `propose_update` patch modes; checks that the proposal was created and the resolved content contains the requested change while preserving a canary string |
| 3 retrieval questions | `read_document` and `search_workspace`; checks the answer states a canary fact and includes a citation link |
| 2 multi-hop questions | Reading across two documents to compose one answer |
| 1 publish request | `publish_document` is called instead of the model claiming it published |
| 1 document creation request | Exact HTML creation effect selection |
| 1 out-of-workspace question | No hallucinated citations and no proposal |
| 3 organization tasks | Exact document move, folder creation with two moves, and existing-tag assignment |
| 2 organization safety tasks | Ambiguous titles require clarification; untrusted document text cannot expand the requested operation |
| 1 language task | The answer follows the language of the latest request |
| 5 additional organization tasks | Trash, duplicate, create a tag, restore, and revision history |
| 3 project tasks | List, create, and update project details |

Each item records bounded nested tool arguments, durable effect status and preview, final workspace paths and tags, final answer, token usage, chat runs, and wall time. A chat run is one initial request or effect continuation, not one model response. Aggregate metrics:

- `success_rate` — items passing all of their per-item checks.
- `edit_success_rate` — the same, restricted to edit tasks.
- `citation_rate` and `refusal_rate` — grounding and refusal behavior.
- `avg_chat_runs`, `avg_output_tokens`, `avg_wall_seconds` — harness efficiency.

Production resolves capabilities, constructs the prompt, pins turn context, stops at durable effects, and persists run evidence. Review cases stop with a pending effect unless their `decision` explicitly requests `approve` or `deny`. YOLO cases resume with the stored result through `threads.add_client_tool_output`. The runner never substitutes an invented effect result.

Case `fixtures` can seed `trashed_documents` by seed ID and `projects` by name. Restore and project-update cases declare these prerequisites. The tag case starts with the original document path. No case depends on an earlier case's changes.

## Interpreting results

Per-item output marks each case `PASS` or `FAIL` and lists failed check keys. Check keys are defined per dataset item; common ones:

- `proposal_status_by_mode` — Review produced a pending proposal. YOLO applied the proposal and its content and revision match the persisted document.
- `content_contains` / `content_not_contains` — string checks against the proposal's resolved full content.
- `faq_heading_before_training_plan` — ordering check for structural edits.
- `answer_contains` / `answer_matches_regex` — string checks against the final answer.
- `citation_in_answer` / `no_citation_in_answer` — citation format checks. They do not prove source support.
- `tool_called` / `not_called` — tool-selection checks.
- `effect_status_by_mode` — review leaves an exact pending effect; workspace mode completes an eligible private effect.
- `organization_kind` / `organization_path` — the stored plan contains the requested operations and paths.
- `workspace_path_by_mode` / `workspace_tag_by_mode` — persisted state changes only in bounded workspace mode.

The runner detects which harness variant is installed by inspecting `ProposeUpdateInput` for the `mode` field and records it as `variant` in the JSON output (`patched` or `full-replace`). This keeps before and after runs comparable when the schema differs.

Treat single runs as noisy: frontier models vary between runs, so a one-item swing is not signal. Token and latency deltas on edit tasks are structural and reproduce reliably; pass/fail deltas should be confirmed with a second run before you act on them.

## Flags

| Flag | Meaning |
| --- | --- |
| `--output PATH` | Write full JSON results to this path. |
| `--model ID` | OpenRouter model under test (default `openai/gpt-5.6-luna`). |
| `--reasoning-effort PRESET` | Reasoning effort under test (default `medium`). |
| `--autonomy-mode MODE` | Exact `review` or no-prompt `workspace` YOLO mode. |
| `--limit N` | Run only the first N items; useful for smoke tests. |
| `--timeout SECS` | Per-item timeout. |
| `--dataset PATH` | Use an alternative dataset file. |
| `--env-file PATH` | Extra `.env` path for the API key. |

The suite is intentionally simple: seeded fixtures, string checks, and tool-call assertions instead of model-graded scoring. Extend the dataset when a harness change adds a behavior worth guarding, and keep every case answerable by deterministic checks.
