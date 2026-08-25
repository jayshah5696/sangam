# Chat agent evals

A small, deterministic eval suite for Sangam's chat agent. It runs ten question and edit tasks against a seeded throwaway workspace, scores them with simple string and tool-use checks, and prints per-item and aggregate metrics. Use it to measure capability or harness changes before and after a modification to the agent toolset, prompts, or runtime budgets. See [chat-capabilities.md](chat-capabilities.md) for the tool contract under test.

## Quickstart

```sh
just eval-chat
```

This seeds a temporary workspace, runs all ten items through the real model, and writes full JSON results to `test-results/chat-evals.json`. The suite needs `SANGAM_OPENROUTER_API_KEY` in the environment or in a local `.env`; without it the runner exits with a clear message. One full run costs roughly 30 to 60 seconds and a few cents of inference.

To compare against another checkout, for example to show what a harness change improved on `main`:

```sh
just eval-chat-against /Users/jshah/Documents/GitHub/sangam
```

The recipe runs this checkout's eval script with the other checkout's installed `sangam` package, so the only variable is the code under test.

## What the suite measures

The dataset in `scripts/evals/chat_eval_dataset.json` covers ten cases:

| Case | What it exercises |
| --- | --- |
| 3 edit tasks (FAQ insertion, mid-document typo fix, changelog append) | `propose_update` patch modes; checks that the proposal was created and the resolved content contains the requested change while preserving a canary string |
| 3 retrieval questions | `read_document` and `search_workspace`; checks the answer states a canary fact and includes a citation link |
| 2 multi-hop questions | Reading across two documents to compose one answer |
| 1 publish request | `publish_document` is called instead of the model claiming it published |
| 1 out-of-workspace question | No hallucinated citations and no proposal |

Each item records the tools called, tool arguments, final answer, token usage, tool rounds, and wall time. Aggregate metrics:

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

The runner detects which harness variant is installed by inspecting `ProposeUpdateInput` for the `mode` field and records it as `variant` in the JSON output (`patched` or `full-replace`). This keeps before and after runs comparable when the schema differs.

Treat single runs as noisy: frontier models vary between runs, so a one-item swing is not signal. Token and latency deltas on edit tasks are structural and reproduce reliably; pass/fail deltas should be confirmed with a second run before you act on them.

## Flags

| Flag | Meaning |
| --- | --- |
| `--output PATH` | Write full JSON results to this path. |
| `--model ID` | OpenRouter model under test (default `openai/gpt-5.4-mini`). |
| `--limit N` | Run only the first N items; useful for smoke tests. |
| `--timeout SECS` | Per-item timeout. |
| `--dataset PATH` | Use an alternative dataset file. |
| `--env-file PATH` | Extra `.env` path for the API key. |

The suite is intentionally simple: seeded fixtures, string checks, and tool-call assertions instead of model-graded scoring. Extend the dataset when a harness change adds a behavior worth guarding, and keep every case answerable by deterministic checks.
