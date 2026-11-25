# Sangam documentation

Sangam is a single-user, self-hosted document workspace where a human author and
scoped AI agents edit ordinary files through one revision-aware API.

## Start here

| Document | Audience | Contents |
| --- | --- | --- |
| [README](../README.md) | Everyone | Overview, Docker quickstart, and top-level links |
| [Product context](../PRODUCT.md) | Everyone | Target user, core workflows, product principles, and non-goals |
| [Architecture](architecture.md) | Operators and contributors | Core concepts, write path, trust model, storage, search, chat, and recovery |
| [Configuration](configuration.md) | Operators | Server settings, defaults, and production rules |

## Operations and deployment

| Document | Contents |
| --- | --- |
| [Deployment](operations/deploy.md) | Local development, Docker, production Compose, auth modes, and Cloudflare Tunnel |
| [Backups, upgrades, and rollback](operations/backups.md) | Paired backups, automated restore drills, forward-only upgrades, and rollback |
| [Agent access](operations/agent-access.md) | Discovery endpoints, scoped bearer tokens, CLI usage, conditional HTTP, and incident response |
| [Integrations](operations/integrations.md) | Karakeep bookmark bridge, ChatKit and LLM providers, and Brave web research |
| [Release checklist](operations/release-checklist.md) | Required pre-tag, backup, attestation, and production acceptance checks |

## Workflows and AI features

| Document | Contents |
| --- | --- |
| [Projects and ongoing work](projects.md) | Project briefs, document roles, saved workbench layouts, collected passages, and API |
| [Persistent project reviews](project-assignments.md) | Server-owned review assignments, stale-proposal refresh, and return briefings |
| [Chat capabilities and durable effects](chat-capabilities.md) | Capability registry, approval lifecycle, saved instructions, facts, history, and editorial review |
| [MCP document workspace](mcp.md) | Experimental Code Mode tools, self-contained MCP App, centralized skills, and recovery |
| [Agent operating guide](../.agents/skills/sangam-agent-guide/SKILL.md) | Portable skill for AI agents operating a deployed Sangam instance |

## Architecture, design, and contributing

| Document | Contents |
| --- | --- |
| [Architecture Decision Records](adr/README.md) | Non-obvious invariants, lock ordering, security boundaries, and subsystem trade-offs |
| [API contract compatibility](api-contract.md) | OpenAPI baseline policy, runtime resource limits, and revision pagination |
| [Contributing](contributing.md) | Setup, verification gates, and repository conventions |
| [Coding standards](coding-standards.md) | Enforced Python, TypeScript, CSS, and comment lint rules |
| [Chat agent evals](chat-evals.md) | Live-model evaluation suite, web fixtures, and source-support grading |
| [Design system](../DESIGN.md) | Quick-reference visual contract, tokens, and accessibility rules |
| [UI system](ui-system.md) | Detailed typography, themes, layout, motion, and screenshot verification rules |
| [Brand identity](brand.md) | Logos, palette definitions, and SVG usage rules |
