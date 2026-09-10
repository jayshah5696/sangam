# Chat Agent Evals & Autonomy Policy

Sangam embeds an AI chat agent capable of reading documents, proposing structured updates with SHA-256 base-digest binding, answering questions across the workspace, and executing safe multi-document organization plans. This feature verifies both deterministic policy safeguards and empirical LLM tool-calling accuracy.

## Sub-features

- `agent-edit`: Precise document mutations (`read_document`, `propose_update`) verifying diff generation, heading insertion, and typo fixing without hallucinated truncation.
- `agent-retrieval`: Multi-hop search across workspace documents, cross-referencing internal owners, SLAs, and expense workflows.
- `agent-organization`: Workspace inspection (`inspect_workspace_organization`) and batched action execution (`apply_workspace_organization_action`) for moving, grouping, and tagging documents.
- `agent-policy-lifecycle`: Enforces human review approval requirements, digest conflicts, and prompt injection resistance (ignoring document-embedded prompt overrides).

## How to get to it (user POV)

- **Web UI**: The Chat Assistant drawer in the workspace editor. Users ask questions, request revisions, or ask the agent to organize tags and folders.
- **REST API**: `/api/v1/chat/threads`, `/api/v1/chat/messages`, and `/api/v1/chat/runs`.
- **Eval Harness**: `scripts/run_chat_evals.py` and `just eval-chat` evaluating all 17 standardized workspace benchmark tasks.

## Driving it with control-sangam

Preconditions:
- Instance is healthy via `./scripts/control-sangam.sh doctor`.

### 1. Run Unified Verification with Agent Eval
```bash
# Runs doctor, seeding, latency benchmark, deterministic policy check, and smoke agent evals
just verify-behavior 8765 15 3
```

### 2. Run Dedicated Agent Evaluation via Harness
```bash
# Evaluates using the default model openai/gpt-5.6-luna
./scripts/control-sangam.sh eval "openai/gpt-5.6-luna" 5

# Or run full 17-item evaluation suite:
./scripts/control-sangam.sh eval "openai/gpt-5.6-luna"
```

Evidence output is captured in JSON at:
`artifacts/verify-sangam/<RUN_ID>/agent-eval.json`

### 3. Run Deterministic Policy Checks (Offline / Local)
```bash
just eval-chat-policy
```
Verifies:
- Document updates require human approval in `review` mode.
- Replayed tool outputs match expected hash signatures.
- Workspace autonomy mode permissions enforce strict file sandboxing.

## Expected Verification Standards

| Check | Target |
|---|---|
| **Pass Rate** | 100% (17 / 17 items) |
| **Edit Accuracy** | 100% (3 / 3 edit items generate valid proposals) |
| **Tool Calling Efficiency** | ≤ 4 average rounds per task |
| **Average Latency** | ≤ 7s per evaluation item |
| **Error Rate** | 0 errors |

## Gotchas

- **OpenRouter Credential**: Running live agent evaluations requires `SANGAM_OPENROUTER_API_KEY` (or `OPENROUTER_API_KEY`) in the environment or `.env`. When run without an API key, `control-sangam.sh eval` verifies deterministic capability policies and logs an informational notice.
- **Base Digest Binding**: The agent cannot blindly overwrite documents; every update must supply `base_digest` matching the current revision head.
