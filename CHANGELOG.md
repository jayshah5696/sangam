# Changelog

All notable changes to Sangam are documented in this file. Releases follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Workspace chat no longer disappears silently: the ChatKit script load times out
  with a retryable error, a frame that never reports ready (for example after a
  stale saved conversation or a blocked network request) surfaces a visible
  recovery notice, and reloading the chat clears the stored thread safely.
- Document tabs now open in preview mode by default. The last mode you pick is
  remembered per workspace and survives reloads instead of snapping back to edit.

### Added

- Inline search on the home page: type to filter documents live, press Enter to
  open the top result.
- Press <kbd>/</kbd> anywhere to jump straight to workspace search in the sidebar;
  ⌘K/Ctrl+K still opens the command palette for files and actions.

## [0.5.0] - 2026-08-21

### Added

- Enhanced mobile touch UX/UI across document workbench, PDF viewer, and settings optimized for narrow mobile viewports (e.g. 390px iPhone width).
- Smooth horizontal tab scrolling and mobile-adaptive document action toolbar.
- Standardized touch target dimensions (≥44px) across interactive buttons, switches, and navigation controls.
- Mobile PDF research workspace optimizations with responsive toolbar and page controls.
- Verified desktop and collapsible mobile screenshot galleries in documentation.

### Changed

- Center-aligned brand logo and refreshed responsive visual previews in README.
- Refined responsive padding, font sizing, and drawer transitions on mobile devices.

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

[Unreleased]: https://github.com/jayshah5696/sangam/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.5.0
[0.4.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.4.0
[0.3.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.3.0
[0.2.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.2.0
[0.1.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.1.0
