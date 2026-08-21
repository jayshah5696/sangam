# Changelog

All notable changes to Sangam are documented in this file. Releases follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

See the generated notes attached to each GitHub Release.

## [0.4.0] - 2026-08-20

### Added

- Provider-neutral AI architecture foundation decoupling model configuration and runtime execution from hardcoded OpenRouter assumptions.
- Sharpened workspace UI system with refined typography, semantic design tokens, border contrast, and standardized control geometry.
- Reusable `StateMessage` component for unified, accessible empty, error, and informational states.
- Automated Playwright end-to-end test suite and screenshot visual verification pipeline.

### Changed

- Modernized Command Palette, Appearance settings preview, and workbench split borders for high-density desktop and narrow viewports.

## [0.3.0] - 2026-08-20

### Added

- Direct interactive HTML & JavaScript preview execution without restrictive DOMPurify stripping or CSP blocks.
- Dynamic custom model slug support: add any OpenRouter model slug directly from the Models settings UI.
- Updated curated model catalog with Claude Sonnet 5, Gemini 3.7 Flash, Gemini 3.5 Flash Lite, and set GPT-5.6 Luna as default.
- Modern React synchronization via `useSyncExternalStore` for browser media queries and event subscriptions.

### Changed

- Streamlined self-hosting documentation and deployment removing separate preview hostname/HMAC token dependencies.
- Simplified DocumentWorkspace and DocumentInspector removing trust-state gating and redundant preview modals.

## [0.2.0] - 2026-08-16

### Added

- Native near-black workspace styling with Midnight dark theme as default, semantic typography tokens, and responsive transitions.
- Dedicated `ActionDialog` with ARIA modal focus trapping, DOM document order navigation, and synchronous focus restoration.
- Persistent active document Chat Context banner and visible context switch notification.
- Actionable empty workspace and explorer states with quick document creation and PDF import CTAs.
- Responsive PDF research workspace toolbar eliminating narrow viewport overflow.
- 2-tier settings navigation dividing Workspace Preferences from Operations & AI with progressive disclosure for agent capabilities.
- Enforced split-editor minimum group dimensions policy.
- Security updates for container runtime, cryptography, and pypdf dependencies.

## [0.1.0] - 2026-07-22

### Added

- A SQLite-canonical document workspace with immutable revisions, materialized
  files, search, reconciliation, trash, and verified paired backups.
- Scoped agent authentication and activity audit, HTML publishing and isolated
  trusted preview, PDF research, Karakeep import, and workspace-grounded chat.
- A responsive React workbench with split editing, preview, revision comparison,
  settings, activity, backup, reconciliation, import, research, and chat flows.
- Container-first release automation with clean-install artifacts, multi-platform
  GHCR images, blocking vulnerability scans, SBOM and provenance attestations,
  keyless signing, and GitHub Release assets.

[Unreleased]: https://github.com/jayshah5696/sangam/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.4.0
[0.3.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.3.0
[0.2.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.2.0
[0.1.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.1.0
