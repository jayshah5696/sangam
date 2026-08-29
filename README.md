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

A single-user, self-hosted document workspace where a human and identified AI
agents work with ordinary files through the same small, revision-aware API.
Every mutation carries an actor, an expected revision, and an idempotency key,
so concurrent edits recover cleanly, external actions stay reviewable, and AI
edits arrive as proposals instead of invisible writes.

![Sangam demo: opening a document, searching the workspace, reviewing agent activity](./docs/assets/demo.gif)

[Watch demo video (MP4)](./docs/assets/demo.mp4)

## Features

- **Document workspace** - Markdown and safe HTML editing, Mermaid preview,
  FTS5 full-text search, immutable revisions with diff/restore, folders, tags,
  split editor groups
- **PDF research** - immutable PDF imports with page-text search, annotations,
  and page-pinned citation links
- **Publishing** - private, public, or unlisted pages at stable custom slugs
- **Scoped agent access** - bearer tokens with capabilities, path boundaries,
  expiry, rotation, and revocation; every instance exposes `/llms.txt`,
  `/skills/sangam/SKILL.md`, and OpenAPI 3.1 for secret-free discovery
- **Workspace-grounded chat** - ChatKit plus OpenAI Agents SDK against
  OpenRouter or any OpenAI-compatible endpoint, with revision-pinned citations
  and human-reviewed edit proposals
- **Karakeep bridge** - selective bookmark import as editable Markdown with
  provenance preserved
- **Recovery-aware ops** - generation-consistent paired backups, reconciliation
  of database against materialized files, separate health/readiness endpoints

## Quickstart

Requires Docker. The container includes the browser client, API, migrations,
background workers, and CLI, and runs as unprivileged `10001:10001`.

```sh
docker compose up   # from the repo root; binds to 127.0.0.1:8000
```

Or run the published image directly:

```sh
docker run --rm -p 127.0.0.1:8000:8000 \
  -v "$PWD/data/database:/data/database" \
  -v "$PWD/data/workspace:/data/workspace" \
  -v "$PWD/data/backups:/data/backups" \
  ghcr.io/jayshah5696/sangam:0.11.0
```

Then open <http://127.0.0.1:8000>.

## Production deployment

Pin an immutable image digest, set explicit environment
(`deploy/compose.prod.yaml` fails closed without it), and put Cloudflare Access
in front of the origin:

```sh
cosign verify ghcr.io/jayshah5696/sangam@sha256:5ade41bbd0d04c9058baec65173f046dc3f1b70d7b5c89a63b1a4b47cfd32cc0 \
  --certificate-identity-regexp '^https://github.com/jayshah5696/sangam/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Full walkthroughs live in [docs/operations/](docs/operations/deploy.md):
deployment, auth modes, backups and rollback, agent token management, and
integrations.

## Documentation

| Doc | Contents |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | Core concepts, trust model, data flow |
| [docs/chat-capabilities.md](docs/chat-capabilities.md) | Chat capability, turn context, effect, and evidence contract |
| [docs/ui-system.md](docs/ui-system.md) | Visual grammar for UI contributions |
| [docs/configuration.md](docs/configuration.md) | Every `SANGAM_*` environment variable |
| [docs/operations/deploy.md](docs/operations/deploy.md) | Dev setup, Docker, production, Cloudflare Access |
| [docs/operations/backups.md](docs/operations/backups.md) | Backup/verify drills, upgrades, rollback |
| [docs/operations/agent-access.md](docs/operations/agent-access.md) | Scoped tokens, discovery, incident response |
| [docs/operations/integrations.md](docs/operations/integrations.md) | Karakeep bridge, ChatKit domain allowlist, chat runtime |
| [docs/contributing.md](docs/contributing.md) | Development setup, conventions, and test gates |
| [docs/brand.md](docs/brand.md) | Brand identity, logos, and usage guidelines |
| [.agents/skills/sangam-agent-guide/SKILL.md](.agents/skills/sangam-agent-guide/SKILL.md) | Skill for AI agents operating a deployed Sangam |
| [CHANGELOG.md](CHANGELOG.md) | Release history |

## Development

```sh
uv sync --all-groups
npm --prefix frontend ci
just serve        # API on :8000, Vite on :5173
just check        # lint, format, typecheck
just test         # pytest + vitest
just test-e2e     # Playwright suite
```

See [docs/contributing.md](docs/contributing.md) for conventions and gates.

## Security

Sangam is pre-1.0 self-hosted beta software; report vulnerabilities privately
via [SECURITY.md](SECURITY.md). Agent access is scoped by design; see
[docs/architecture.md](docs/architecture.md) for the trust model.

## License

[Apache-2.0](LICENSE)
