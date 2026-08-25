# Changelog

All notable changes to Sangam are documented in this file. Releases follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

See the generated notes attached to each GitHub Release.

## [0.9.1] - 2026-08-24

### Added

- **User-Configurable Typography Preferences**:
  - Added interface font, interface density, and editor font size customization in **Settings > Appearance > Typography** (#126, #128).
  - Pre-paint bootstrap script (`typography-bootstrap.js`) loads stored preferences before first paint to prevent layout shifts while complying with Content Security Policy (#128).
- **Custom Theme Studio & Theme Sharing**:
  - Interactive Theme Studio in **Settings > Appearance > Create theme** allowing full customization of eight semantic color roles (app background, surface, raised surface, text, muted text, sidebar, sidebar text, accent) with real-time workspace preview (#128).
  - JSON import and export support for sharing custom themes across instances and browsers (#128).
  - Named theme cards with live wireframe previews and graceful fallback on active theme removal (#128).
- **ChatKit Typography & Density Synchronization**:
  - Propagates workspace font family, mono family, base font size, and density preferences directly into the ChatKit assistant iframe using memoized configuration to prevent frame re-initialization (#128).
- **Tokenized Fluid Display Type Scale**:
  - Consolidated ad-hoc display-header clamps into fluid `--text-display-sm` and `--text-display` design tokens (#125, #127).
  - Converted icon sizing tokens to `rem` units so icons scale seamlessly with user font preferences (#127).
  - Extended automated UI linting (`check-ui-system`) to strictly enforce design token usage and block hardcoded font sizes outside tokens (#127).

### Changed

- **Documentation Architecture & Hygiene**:
  - Standardized documentation naming to lowercase kebab-case (`chat-capabilities.md`, `ui-system.md`) (#124).
  - Relocated interactive lifecycle diagrams to `docs/assets/` and cleaned legacy assets (#124).
  - Connected documentation cross-links across architecture, chat capabilities, and operations guides (#124).

### Fixed

- **Theme Import Contrast Accessibility**:
  - Resolved WCAG AA color contrast defect in theme import summary under dark themes using high-contrast text styling with accent underlines (#128).

## [0.9.0] - 2026-08-23

### Added

- **Durable Chat Capability Lifecycle & Side Effects Architecture**:
  - Full capability registry and tool execution planner backed by database migration `018_chat_capabilities_and_effects.sql` (#121).
  - Explicit mutation lifecycle (staged, applied, rejected, rolled back) ensuring AI-driven edits require human review and can be safely audited (#121).
  - Citation evidence tracking linking workspace context and PDF page citations directly to chat turns and proposed edits (#121).
  - Comprehensive lifecycle validation suite and adversarial conversation evaluation fixtures (#121).
- **Streamlined Chat UI & Compact Document Controls**:
  - Unified compact chat controls, model selectors, and tool status cards across standalone `/chat` and Document Inspector tabs (#121).
  - Preserved active conversation context across workbench tab navigation and document switching (#121).
- **Design System & Semantic Token Consistency**:
  - Semantic icon role audit aligning Lucide icon tokens across file tree, settings sidebar, PDF viewer, secrets modal, and workbench controls (#121).
  - Automated UI token compliance checks enforcing visual hierarchy (#121).
- **Chat Capabilities Architecture Documentation**:
  - Published `docs/chat-capabilities.md` detailing capability contracts, turn state machines, and side-effect boundaries (#121).
  - Added interactive visual lifecycle flow diagrams and documentation media assets (#121).

## [0.8.1] - 2026-08-22

### Added

- **Zero-Configuration Agent Discovery & Onboarding**:
  - Direct agent discovery endpoints: `GET /llms.txt`, `GET /llms-full.txt`, `GET /agent.json`, and `GET /skills/sangam/SKILL.md` exposing complete instance capabilities, conventions, and tool definitions without requiring secrets (#114).
  - Integrated skill guide download and setup instructions directly inside the Agent Access settings interface (#114).
  - Enhanced one-time secret view dialog for newly generated bearer tokens (#114).
- **Consolidated Documentation & Demo Media**:
  - Streamlined operational guides covering deployment, configuration, backups, agent access, and integrations (#115).
  - Added new visual demo assets and automated demo recording scripts (#115).
  - Added ChatKit domain registration and allowlisting deployment guide (#113).

## [0.8.0] - 2026-08-22

### Added

- **First-Class Workspace Chat & Compact Document Chat**:
  - Full-featured standalone workspace chat on `/chat` with rich markdown formatting, model selector, tool execution status, document creation preview, and touch interactions (#105).
  - Compact document chat tab inside Document Inspector for inline assistance alongside documents (#105).
  - Robust ChatKit loading and session readiness with timeout handling and clear retry states.
- **Isolated HTML JavaScript Runtime**:
  - Configurable HTML JavaScript execution setting backed by database migration `017_html_javascript_settings.sql` (#103, #107).
  - Sandboxed iframe runtime support enabling safe, interactive JavaScript rendering in document previews and published pages (#107).
  - Workspace preferences and Document Inspector settings controls for toggling HTML JavaScript execution.
- **Unified Settings Navigation**:
  - Integrated `SettingsSidebar` drawer navigation ensuring fluid, accessible movement between workspace documents and settings across desktop and mobile screens (#104, #108).
- **Browser Verification Skill**:
  - Project `.agents/skills/browser-verification` skill defining desktop, narrow-desktop, true touch-mobile, and visual evidence gates (#99).

### Fixed

- **Inline File & Folder Renaming Visibility**:
  - Scoped Pierre unsafeCSS styling rules with `:not(:has([data-item-rename-input]))` in `FileExplorer` so the inline rename text input remains visible and focused during rename mode (#100, #109).
  - Prevented static pseudo-element label from obscuring the rename input field during inline renaming.

## [0.7.0] - 2026-08-22

### Added

- **Continuous PDF reader & in-page annotations**:
  - Continuous vertical scroll view with lazy PDF.js canvas and text-layer rendering near the viewport (`IntersectionObserver`).
  - Floating selection toolbar with 5 quick highlight colors, note composer, plain text copy, and Markdown citation copy (`sangam://` link).
  - Margin gutter pins for page notes, comments, bookmarks, and citations with interactive hover and keyboard focus preview cards.
  - PDF session state persistence: active page, zoom scale, zoom mode, and scroll position are preserved across workbench tab switches.
  - Sub-pixel normalized digital highlighter overlays with `multiply` (light) and `screen` (dark) blend modes.
  - Integrated PDF Research Rail directly into the unified Document Inspector as a dedicated `research` tab with container-aware auto-fit scaling (`ResizeObserver`).
- **Workspace Chat**:
  - Standalone workspace chat accessible without opening a document via `/chat`, home welcome screen actions, and command palette (`⌘K` $\rightarrow$ "Open workspace chat").
  - Grounded in whole-workspace context with `X-Sangam-Workspace-Context` header support, model selection, and tool access (`search_workspace`, `read_document`, `read_pdf_page`, `create_document`).
- **Publications Dashboard**:
  - Centralized `/publications` overview to audit, filter (by search query, access policy, and status), and manage all published HTML documents across the workspace.
  - Direct actions for URL copy, live page view, metadata/slug editing, unlisted access token rotation with single-use credential reveal, and unpublishing.
- **Agent token administration & Activity date filters**:
  - In-place editing of active agent tokens (`PATCH /api/v1/agent-tokens/{token_id}`) with expected-version optimistic concurrency control, audit trail snapshots in `actor_token_events`, and safety confirmations for high-impact capabilities.
  - Operational date range filtering on `/activity` review log (presets: All time, Today, Last 7 days, Last 30 days, Custom ISO range) with UTC normalization and indexed queries.

### Fixed

- Fixed middle truncation text corruption in primary sidebar file explorer.
- Fixed sidebar tree item action and context menu clipping by using floating coordinate positioning.
- Added close buttons (`X` on tab and group menu) for split editor panes containing single tabs.
- Added right-click and keyboard (`F2`) renaming support for files and folders.
- Relocated replacement PDF controls from research rail to Document Inspector Properties.

## [0.6.0] - 2026-08-21

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

[Unreleased]: https://github.com/jayshah5696/sangam/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/jayshah5696/sangam/releases/tag/v0.9.1
[0.9.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.9.0
[0.8.1]: https://github.com/jayshah5696/sangam/releases/tag/v0.8.1
[0.8.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.8.0
[0.7.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.7.0
[0.6.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.6.0
[0.5.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.5.0
[0.4.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.4.0
[0.3.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.3.0
[0.2.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.2.0
[0.1.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.1.0
