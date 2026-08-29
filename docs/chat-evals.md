# Chat agent evals

A deterministic eval harness for Sangam's chat agent. It runs 17 question, edit, organization, safety, and language tasks against a seeded throwaway workspace. Checks inspect tool arguments, durable effects, and persisted workspace outcomes rather than trusting model prose. See [chat-capabilities.md](chat-capabilities.md) for the contract under test.

## Quickstart

```sh
just eval-chat
just eval-chat-yolo
just eval-chat-policy
```

`just eval-chat` runs GPT-5.6 Sol with medium reasoning and exact review. `just eval-chat-yolo` runs the same cases in no-prompt YOLO mode and verifies the resulting files, metadata, and publications. Both commands write JSON under `test-results/` and need `SANGAM_OPENROUTER_API_KEY` in the environment or a local `.env`.

`just eval-chat-policy` is credential-free. It verifies capability scopes, exact approval, digest binding, stale state, duplicate delivery, cancellation, no-prompt YOLO execution, materialized chat creation, and organization-plan recovery.

To compare against another checkout, for example to show what a harness change improved on `main`:

```sh
just eval-chat-against /Users/jshah/Documents/GitHub/sangam
```

The recipe runs this checkout's eval script with the other checkout's installed `sangam` package, so the only variable is the code under test.

## What the suite measures

The dataset in `scripts/evals/chat_eval_dataset.json` covers 17 cases:

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

Each item records bounded nested tool arguments, durable effect status and preview, final workspace paths and tags, final answer, token usage, tool rounds, and wall time. Aggregate metrics:

- `success_rate` — items passing all of their per-item checks.
- `edit_success_rate` — the same, restricted to edit tasks.
- `citation_rate` and `refusal_rate` — grounding and refusal behavior.
- `avg_tool_rounds`, `avg_output_tokens`, `avg_wall_seconds` — harness efficiency.

## Interpreting results

Per-item output marks each case `PASS` or `FAIL` and lists failed check keys. Check keys are defined per dataset item; common ones:

- `proposal_created` — an edit task produced a pending proposal.
- `content_contains` / `content_not_contains` — string checks against the proposal's resolved full content.
- `faq_heading_before_training_plan` — ordering check for structural edits.
- `answer_contains` / `answer_matches_regex` — string checks against the final answer.
- `citation_in_answer` / `no_citation_in_answer` — grounding checks.
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
| `--model ID` | OpenRouter model under test (default `openai/gpt-5.6-sol`). |
| `--reasoning-effort PRESET` | Reasoning effort under test (default `medium`). |
| `--autonomy-mode MODE` | Exact `review` or no-prompt `workspace` YOLO mode. |
| `--limit N` | Run only the first N items; useful for smoke tests. |
| `--timeout SECS` | Per-item timeout. |
| `--dataset PATH` | Use an alternative dataset file. |
| `--env-file PATH` | Extra `.env` path for the API key. |

The suite is intentionally simple: seeded fixtures, string checks, and tool-call assertions instead of model-graded scoring. Extend the dataset when a harness change adds a behavior worth guarding, and keep every case answerable by deterministic checks.
