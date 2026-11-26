# Sangam

<!-- markdownlint-disable MD033 -->
<p align="center">
  <img src="https://raw.githubusercontent.com/jayshah5696/sangam/main/frontend/public/sangam-mark.svg" alt="Sangam logo" width="112" />
  <br />
  <a href="https://github.com/jayshah5696/sangam/releases/latest"><img src="https://img.shields.io/github/v/release/jayshah5696/sangam?display_name=tag&sort=semver" alt="Release" /></a>
  <a href="https://github.com/jayshah5696/sangam/actions/workflows/ci.yml"><img src="https://github.com/jayshah5696/sangam/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/jayshah5696/sangam/pkgs/container/sangam"><img src="https://img.shields.io/badge/GHCR-linux%2Famd64%20%7C%20linux%2Farm64-2496ED?logo=docker&logoColor=white" alt="Container" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/jayshah5696/sangam" alt="License" /></a>
</p>
<!-- markdownlint-enable MD033 -->

Sangam is a single-user, self-hosted document workspace where a human author and
identified AI agents work on ordinary files through the same revision-aware API.
Document edits carry an actor identity, an idempotency key, and a revision
guard. A stale edit returns a conflict or failed precondition. The activity
ledger records workspace mutations and agent reads. Chat suggests edits to
existing documents as proposals. Review mode leaves them pending for review.
YOLO mode can apply them under the requester's authority.

![Sangam demo: opening a document, searching the workspace, reviewing agent activity](./docs/assets/demo.gif)

[Watch demo video (MP4)](./docs/assets/demo.mp4)

## What Sangam does

- Document workbench for Markdown and safe HTML with Mermaid preview, SQLite
  FTS5 search with located passages, immutable revisions with diff and restore,
  folders, tags, and split editor groups.
- Projects and persistent reviews to group drafts, sources, saved workbench
  layouts, collected PDF passages, return briefings, and server-owned review
  assignments.
- PDF research with immutable PDF imports, background page-text extraction,
  annotations, and page-pinned citations.
- Revision-pinned publishing at stable custom slugs as private, unlisted, or
  public pages.
- Scoped agent access with bearer tokens limited by capability, path prefix,
  and expiry. Every instance exposes `/llms.txt`, `/skills/sangam/SKILL.md`,
  and OpenAPI 3.1 for credential-free discovery.
- Workspace-grounded chat using ChatKit and the OpenAI Agents SDK against
  OpenRouter or any OpenAI-compatible endpoint, with revision-pinned citations,
  approval for durable effects by default, and optional web research.
- Experimental MCP workspace exposing restricted Python Code Mode, a
  self-contained MCP App, centralized skills, and assistant requests.
- Karakeep bookmark bridge for selective import as editable Markdown with
  preserved source provenance.
- Recovery-focused operations with generation-consistent paired backups,
  database-to-file reconciliation, and separate health and readiness endpoints.

## Quickstart

Docker is required. The container bundles the web client, API server, database
migrations, background workers, and CLI, and runs as unprivileged user
`10001:10001`.

```sh
docker compose up   # from the repository root; binds to 127.0.0.1:8000
```

You can also run the published image directly:

```sh
docker run --rm -p 127.0.0.1:8000:8000 \
  -v "$PWD/data/database:/data/database" \
  -v "$PWD/data/workspace:/data/workspace" \
  -v "$PWD/data/backups:/data/backups" \
  ghcr.io/jayshah5696/sangam:0.14.3
```

Open <http://127.0.0.1:8000> once the container starts.
The mounted directories must be writable by UID and GID `10001` inside the
container.

## Production deployment

Use `deploy/compose.prod.yaml` with a signed image pinned by digest and an
authenticated reverse proxy. See [Deployment](docs/operations/deploy.md) for
required settings, signature verification, and startup checks.

## Documentation

Browse the full index in [docs/README.md](docs/README.md), or jump straight to a
topic below.

### Operate and configure

| Doc | Contents |
| --- | --- |
| [docs/operations/deploy.md](docs/operations/deploy.md) | Local dev, Docker, production Compose, and Cloudflare Access |
| [docs/configuration.md](docs/configuration.md) | Server settings and defaults |
| [docs/operations/backups.md](docs/operations/backups.md) | Paired backups, restore drills, upgrades, and rollback |
| [docs/operations/agent-access.md](docs/operations/agent-access.md) | Scoped tokens, discovery endpoints, CLI usage, and incident response |
| [docs/operations/integrations.md](docs/operations/integrations.md) | Karakeep bridge, ChatKit domain allowlist, LLM providers, and web research |

### Workflows and architecture

| Doc | Contents |
| --- | --- |
| [PRODUCT.md](PRODUCT.md) | Target user, core workflows, principles, and non-goals |
| [docs/architecture.md](docs/architecture.md) | Core concepts, write path, trust model, and storage |
| [docs/projects.md](docs/projects.md) | Projects, document roles, saved layouts, and API |
| [docs/project-assignments.md](docs/project-assignments.md) | Persistent project reviews and return briefings |
| [docs/chat-capabilities.md](docs/chat-capabilities.md) | Chat capabilities, approvals, memory, and editorial review |
| [docs/mcp.md](docs/mcp.md) | Experimental MCP Code Mode, MCP App, and centralized skills |
| [.agents/skills/sangam-agent-guide/SKILL.md](.agents/skills/sangam-agent-guide/SKILL.md) | Portable skill for AI agents operating a deployed Sangam instance |

### Contribute and verify

| Doc | Contents |
| --- | --- |
| [docs/contributing.md](docs/contributing.md) | Setup, verification gates, and repository conventions |
| [docs/adr/README.md](docs/adr/README.md) | Architecture Decision Records for non-obvious invariants |
| [docs/api-contract.md](docs/api-contract.md) | OpenAPI compatibility policy, resource limits, and pagination |
| [docs/coding-standards.md](docs/coding-standards.md) | Enforced Python, TypeScript, CSS, and comment rules |
| [DESIGN.md](DESIGN.md) and [docs/ui-system.md](docs/ui-system.md) | Design contract, tokens, layout, and visual verification |
| [docs/brand.md](docs/brand.md) | Brand identity, logos, and SVG rules |
| [docs/chat-evals.md](docs/chat-evals.md) | Live chat agent evaluation harness |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Development

Use `just` recipes for local setup, serving, and verification:

```sh
just setup      # install locked Python and frontend dependencies
just serve      # API on 127.0.0.1:8000, Vite on 127.0.0.1:5173
just test       # Python lint, format, mypy, OpenAPI, pytest + frontend build, lint, vitest
just test-docs  # docs links, repo references, Mermaid fences, markdownlint
just test-e2e   # Playwright browser and accessibility suite
just check      # full local gate: test, test-docs, compose, distribution, package smoke
```

See [docs/contributing.md](docs/contributing.md) for conventions and test gates.

## Security

Sangam is pre-1.0 self-hosted software. Report vulnerabilities privately via
[SECURITY.md](SECURITY.md). See [docs/architecture.md](docs/architecture.md) for
the trust model.

## License

[Apache-2.0](LICENSE)
