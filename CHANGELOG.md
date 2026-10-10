# Changelog

All notable changes to Sangam are documented in this file. Releases follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

See the generated notes attached to each GitHub Release.

## [0.13.6] - 2026-10-09

### Added

- Twelve built-in themes: dark and light variants of Indigo Ink, Moss, Ember, Lagoon, Plum, and Brass, for 16 themes in total. Every new palette meets WCAG contrast minimums (4.5:1 for text, 3:1 for the accent) (#443).
- Theme contrast check: a collapsed readability summary under the theme picker lists the WCAG ratios for the active theme.

### Changed

- Theme picker: a Dark/Light switch and compact preview cards replace the four large cards. Switching between Dark and Light also swaps the active theme to its other variant.
- Create theme: pick a background and an accent, and Sangam derives the remaining colors and keeps them readable. A new theme starts from the theme in use. Other color roles sit under "Fine-tune other colors" (#443).
- Code blocks, diffs, and PDF highlights now follow the real theme brightness, including custom themes, instead of treating only Midnight as dark.

## [0.13.5] - 2026-10-08

### Added

- Claim versus source matrix view: project-level evidence synthesis table displaying claims against referenced sources with confidence badges, inline verification, and direct citation navigation (#324, #416).
- Alternative draft exploration: branching workflow to explore alternative conclusions, drafts, or counter-hypotheses without overwriting the original document (#325, #416).
- Interactive explorables: capability to attach rich interactive simulations, explorable explanations, and widgets directly to documents (#327, #416).
- Composable workspace agent primitives: decomposed workspace agent capabilities into modular, reusable primitives for inspection, generation, and multi-step tasks (#341, #416).

### Security

- Hardened activity audit provenance and detail tracking: auto-populated `action_type`, `target_file`, and diff metrics (lines added/removed) across document operations, with expanded regex sanitization for credentials, environment variables, and connection secrets (#436, #438).
- Agent document comment read auditing: wrapped `list_comments` and `get_comment` operations in `WorkspaceAccessService` under audited execution and enforced path-scope authorization (403 forbidden) for scoped agent tokens (#424, #438).

### Fixed

- Exception-safe file descriptor cleanup: ensured file descriptors from `tempfile.mkstemp` are reliably closed on failure before re-raising exceptions across workspace files, backup archives, folder manifests, and PDF text extraction (#435, #438).
- Comment resolution optimistic concurrency control: enforced atomic database precondition (`WHERE comment_id = ? AND version = ?`) on comment resolution to prevent concurrent resolution races from silently succeeding without conflict (#422, #438).
- Published HTML viewport scaling: resolved publication display defect so published HTML pages expand to fill the full viewport height (#437).
- Alternative draft dialog layout: ensured modal dialog and form controls stay within viewport bounds on narrow screens (#420).

### Dependencies

- Consolidated backend dependency upgrades: bumped FastAPI to 0.143.0, openai-agents to 0.23.1, PyJWT[crypto] to 2.15.1, MyPy to 2.4.0, and Ruff to 0.16.10 (#439).
- Consolidated frontend dependency upgrades: bumped lucide-react to 1.52.0, @openai/chatkit to 1.9.0, @codemirror/view to 6.43.13, react-resizable-panels to 4.14.3, and ESLint to 10.12.0 (#439).

## [0.13.4] - 2026-10-06

### Added

- Source change detection and passage recheck analysis: automatic detection when a cited source document or paper changes revision, inline warning callout (`<aside className="source-recheck-callout">`), accessible side-by-side comparison modal (`SourceVersionComparisonModal`) showing pinned vs. current head passages, and project-level dependent conclusion listings (#323, #406).
- Dedicated mobile single working surface workflow: replaced cramped multi-pane split layouts on mobile viewports (<= 768px or coarse pointer) with a focused single working surface, tactile pill switcher tabs (`Draft` vs. `Source`), and DOM-preserved mounting to maintain cursors, selections, undo/redo history, scroll positions, and PDF canvases (#312, #408).
- Mobile companion bar and navigation polish: connected companion bar with instant one-tap switching between draft and source surfaces, touch manipulation ergonomics (`touch-action: manipulation`, `viewport-fit=cover`, overscroll prevention), and restored drawer navigation for settings (#312, #408).

### Security

- Input sanitization for document comment fields: enforced `validate_metadata_text` on `CreateDocumentCommentRequest` fields (`exact`, `prefix`, `suffix`, `body`) in `DocumentCommentService.create_comment` to reject null bytes and ASCII control characters (#402, #412).
- Hardened agent token path scope matching: normalized path scope prefixes and target paths by stripping trailing slashes in `path_matches` (`src/sangam/security.py`), enforcing strict directory component boundary matching to prevent trailing-slash anomalies and partial directory prefix bypasses (#407, #412).
- Hardened activity audit provenance and sensitive parameter sanitization: auto-populated `action_type` and `target_file` across structured mutation audit events in `ActivityService` and `WorkspaceAccessService`, and expanded regex redaction for environment variable assignments and sensitive credential keys in audit logs and traces (#404, #409, #412).

### Fixed

- Resilient and atomic PDF text extraction: refactored PDF parser script output writer in `src/sangam/pdf_parser.py` using `tempfile.mkstemp`, `os.fsync`, and atomic `os.replace` with cleanup in a `finally` block to prevent partial JSON writes and eliminate extraction race conditions (#403, #410, #411, #412).
- Passage remapping and pin safety: enforced passage remapping for evidence rail citations and handled unmapped pins gracefully (#406).
- Type tightening on briefing changes: strengthened `BriefingChange` `revision_id` typing and project testing assertions (#406).

## [0.13.3] - 2026-10-04

### Added

- Right rail question presets and published evidence drawer: connects workspace layouts to inspector presets (Writing, Research, Review); published reader evidence slide-over drawer with zero reading space intrusion, claim / verbatim excerpt / context notes, privacy chips, search filter, and pulse glow locator (#309, #329, #401).
- Passage-anchored comments on Markdown and HTML documents: persistent passage locators (`exact`, `prefix`, `suffix`), detached state detection across revisions, resolution status filter tabs (`Open`, `Resolved`, `All`), and selection toolbar integration (#370, #397).
- Unified reviewed action state machines: consolidated proposal and effect lifecycle handling, canonical payload verification via `ActionDigest`, actor ownership validation, retry safety classification, and atomic run cancellation (#388, #389, #396).
- Scriptable model provider test harness (`ScriptedModelProvider`, `ScriptedModel`, `Say`, `Call`, `Step`) for deterministic multi-turn agent simulation and chat policy evals (#388, #396).
- Simplified Workspace Home: unified "New document" action with Markdown and HTML choices, co-located project context and recent/pinned documents, and capture integration inside Inbox (#375, #394).
- Configurable sidebar footer navigation: granular visibility toggle controls for all 6 sidebar footer tools in Settings -> Workbench with dynamic responsive layout (#374, #395).
- Chat capabilities and parity expansion: requester authority, project and tag tools, annotations, publications, chat-origin activity filter (`via=chat`), and pathless document creation retry idempotency (#376, #379, #382, #383, #384, #385, #386, #387, #391, #393, #395).
- Database migrations: chat effect requester token `030`, document comments `031`, and publication evidence `032` (#393, #397, #401).

### Security

- Server-side request forgery (SSRF) client protections: DNS-pinned connections, prohibited IP ranges (loopbacks, RFC1918, RFC6598, link-local, cloud metadata, IPv6/IPv4-mapped), redirect hop revalidation, 10MB streaming size limits, and `POST /api/v1/captures/url` endpoint (#371, #400).
- Enforced agent path scoping and structured audit logging on trusted preview token issuance (#381).
- Document asset filename sanitization against ASCII control characters and null bytes in `DocumentAssetService.store` (#398).
- Sensitive data sanitization hardening: stripped sensitive headers, key-value secret redaction, and pattern matching in `security.py` (#379, #392).

### Fixed

- Folder manifest synchronization across folder hierarchy moves (`rename_folder`), ensuring `.sangam-folder.json` manifests stay consistent for moved descendant folders (#399).
- Backup archive reliability: excluded ephemeral readiness probe files and handled transient files gracefully during workspace tar archiving (#400).
- Unified modal dialog anatomy: created shared `ModalDialog` component (`<dialog>` semantics, Escape dismiss, focus trapping/restoration) and eliminated off-token colors/radii across all stylesheets (#390, #400).
- HTML preview layout and navigation: fixed collapsed disclosure height, preserved split-pane alignment, restored Settings Operations navigation, and resolved Files sidebar search button redundancy (#373, #377, #378, #380).
- Chat cancellation scope: scoped cancellable run IDs strictly to pending chat effects and uncommitted proposals (#396, #397).
- Coordinated folder mutations with generation barriers in `create_folder` and `update_folder_metadata` to prevent filesystem race conditions with folder moves and backups (#399).

### Changed

- Unified workspace write path and ledger architecture: single `audited` entry point and single document write path replacing duplicated methods; chat feature parity with app capabilities; revoked-token rejection mid-run; UI stylesheet class validation in `check-ui-system` (#379).
- Dependency audit policy: ignore unpatched dev-dependency advisory GHSA-vfj7-8cjw-p6xm in `pnpm audit` (#395).


## [0.13.2] - 2026-10-01

### Added

- Streamlined document canvas, location popover controls, and document backlinks inspector (#308, #317, #319, #355).
- Located search passages with paragraph-level deep linking and overlay-dismissal focus coordination (#310, #369).
- Audited server-backed saved views synchronized across devices (#311, #369).
- Persistent project reviews, stale proposal recovery across document edits, and visit briefings (#353).
- Capture Inbox with responsive single-row mobile actions and pinned publications support (#318, #320, #321, #369).
- Root-relative image attachment storage (`/attachments/<name>-<sha16>.<ext>`) preserving image references across document moves and folder renames (#322, #369).
- Database migrations: project assignments migration `027`, publication revision pinning migration `028`, and server-backed saved views migration `029` (#353, #369).

### Security

- Hardened sensitive data sanitization: expanded credential redaction for Bearer tokens, embedded URI credentials, key-value secret assignments, and credential payload keys (#367).
- Hardened workspace path canonicalization and agent token scope prefix normalization against Windows/system reserved device names and invalid characters (#365).
- Audit provenance hardening: captured resource IDs and paths for folder operations, moves, publications, and workspace organization plans (#365).

### Fixed

- Eliminated disk write race conditions in folder creation and metadata updates by acquiring path mutation locks on `.sangam-folder.json` (#368).
- Coordinated workspace path locks across text document mutations, creations, updates, moves, deletions, duplicates, and restorations to prevent filesystem races and silent disk overwrites (#365).
- Retained search passage highlighting by waiting for narrow/touch drawer and inspector overlays to close before revealing passage (#369).

### Changed

- Dependency updates: `@tanstack/react-query` to 5.104.0, `eslint` to 10.11.0, `eslint-plugin-react-refresh` to 0.5.7, `vite` to 8.3.1, `uvicorn[standard]` to 0.54.0, `pyjwt[crypto]` to 2.15.0, and `httpx2` to 2.13.1 (#365).
- Documentation hygiene: cleaned up obsolete PR screenshots, unreferenced prototype HTML files, and duplicate documents; added asset hygiene rules in `AGENTS.md` (#366).

## [0.13.1] - 2026-09-30

### Added

- Persistent Project home and membership management: reference-based project model, double-bezel cards and bento layout, project session, draft, and split restoration, context pins, and pass-through PDF inspection (#306, #331, #347).
- Reusable workspace evidence: cross-workspace evidence rail, source pins, literal citation titles, evidence locator handoff, and safe cursor insertion (#330, #332, #347).
- Editorial review activity: review changes inbox, exact-wording proposal application, and feedback handoff to ChatPanel (#314, #333, #347).
- HTTP conditional concurrency headers: `ETag` and `If-Match` support for document concurrency control (#305, #347).
- Database migrations: assigned projects migration `024` and editorial review migration `025` (#347).

### Security

- Hardened project metadata text inputs (name, description, document notes) against null bytes and ASCII control characters (#348).
- Hardened sensitive header provenance and audit payload data sanitization (#304, #347).
- Hardened agent wildcard token path scope normalization and aligned tag scoping (#303, #347).

### Fixed

- Fixed keyboard accessibility for `@pierre/trees` virtualized file tree scroll container (`[data-file-tree-virtualized-scroll="true"]`), resolving WCAG 2.1.1 `scrollable-region-focusable` violations across primary routes.
- Ordered mutation generation entry before document locks to prevent crossed duplicate-replay lock cycles (#347).
- Bounded mutation replay and corrected oversized audit reservation handling under high contention (#347).
- Preserved native text selection during unchanged Markdown re-renders and fixed mobile citation navigation behind the inspector (#347).
- Restored unopened-draft recovery, exact historical citations, and error-state retention during chat mounting polls (#347).

### Changed

- Resolved dependency advisory for `undici` by updating override to `8.11.2` (#347).
- Upgraded `brace-expansion` to `5.0.12` (#348).
- Upgraded `urllib3` to `2.8.0` to resolve runtime dependency security advisories.


## [0.13.0] - 2026-09-27

### Added

- Scaled SQLite concurrency with audit group commit and keyed locks: batched durable mutation ledger writes via dedicated commit worker and Future barriers (#295, #300).
- Enabled granular mutation concurrency by narrowing document creation locks to `(actor_id, idempotency_key)`, unlocking parallel document creation across distinct actors (#295, #300).
- Thread-offloaded synchronous SQLite ChatKit queries via `asyncio.to_thread` for non-blocking read and query execution (#295, #300).
- Added dedicated concurrency benchmark suite (`scripts/benchmark_concurrency.py`, `just benchmark-concurrency`) verifying saturation, 1:1 event payload checks, zero errors, and streaming under contention (#296, #300).
- Made workspace flows reviewable and included diff marker content in mutation audit line totals (#285, #294).

### Security

- Hardened activity audit provenance recording, header redaction, and sensitive data sanitization across mutations, bearer tokens, headers, and payloads (#299, #300).
- Hardened folder descendant document count query against SQL wildcard pattern matching characters (`%`, `_`) (#296, #297, #300).
- Hardened metadata text input sanitization against null bytes and control characters across connections, proposals, and effects (#288, #291, #294).
- Prevented silent overwrites in concurrent document moves and restores by replacing non-atomic `os.replace` with atomic `os.link` and failure cleanup (#298, #300).
- Guaranteed atomic backup manifest replacement and content hash validation under concurrent writes (#286, #289, #294).
- Enforced path coordination for PDF imports: locked per-path via `MutationCoordinator` and verified database document existence before creation and on cleanup (#296, #300).

### Fixed

- Decoupled mutation transaction locks from audit queue draining, enforcing dynamic byte reservations with strict memory bounds without silent error swallowing (#296, #300).
- Implemented `BoundedThreadRunner` to retain concurrency permits during coroutine cancellation and cleanly drain during shutdown (#296, #300).
- Guaranteed progress on audit capacity expansion with provisional FIFO credits, preventing circular waits, and added direct persistence fallback (#296, #300).
- Preserved complete untruncated unified diffs computed via `difflib` for document creates, updates, and restores, preserving line endings and trailing newline annotations (#296, #300).
- Recovered mobile toolbar layout into a clean single line and fixed materialize bar flex wrapping overflow (#285, #294).
- Restored mobile inspector trigger focus and stabilized mobile touch tree interactions (#285, #294).
- Resolved WCAG AA color contrast violations on activity links and summaries (#285, #294).
- Kept PDF text selection state coherent on scroll and stabilized mobile PDF text selection (#285, #294).
- Fixed compact chat width containment and synchronized compact chat resize assertions (#294).
- Bounded document loading and isolated large search fixtures for workspace-scale paged search (#265).

### Changed

- Upgraded frontend dependencies: `@openai/chatkit-react` to 1.6.1, `lucide-react` to 1.48.0, `vite` to 8.3.0, `@testing-library/react` to 16.3.3, `@playwright/test` to 1.63.0 (#294).
- Upgraded backend dependencies: `uvicorn[standard]` to >=0.53.0, `pyjwt[crypto]` to >=2.14.0, `pypdf` to 6.19.0, `openai-agents` to 0.22.3, `ruff` to 0.16.8 (#294).
- Upgraded CI and build tooling: `docker/setup-buildx-action` to 4.4.1, `docker/setup-qemu-action` to 4.4.0, `docker/build-push-action` to 7.4.0, `astral-sh/setup-uv` to 10.2.0, `extractions/setup-just` to 4.0.0 (#294).


## [0.12.3] - 2026-09-21

### Security

- Hardened workspace trash paths against path traversal, control characters, null bytes, and non-relative escaping (#259).
- Hardened metadata text inputs to reject null bytes and control characters across all metadata surfaces (#215, #258).
- Sanitized whitespace and special path components to prevent path traversal across workspace operations (#227, #258).
- Hardened backup archive extraction to strictly reject traversal and absolute paths during restore operations (#221, #230).
- Enforced document parent containment for publication assets to prevent cross-document asset exposure (#224, #230).
- Fixed agent identity scoping to allow administrator identity to decide and acknowledge agent chat effects (#218, #230).
- Overrode transitive `lodash-es` in `frontend/pnpm-workspace.yaml` to patch prototype pollution vulnerability GHSA-r5fr-rjxr-66jc (#260).

### Fixed

- Resolved file hash validation timing race condition in `DiskWorkspaceFilesystem` atomic staging operations (#258).
- Guaranteed atomic replacement for folder metadata writes and automatic target file unlinking upon hash mismatch failures (#222, #229, #230).
- Hardened mutation audit provenance recording, header redaction, and audit trail sanitization (#228, #258).
- Fixed TypeScript type compatibility for `token.attrGet()` following `markdown-it` 15 upgrade (#260).

### Changed

- Upgraded frontend dependencies: `@tanstack/react-router` to 1.170.38, `@tanstack/history` to 1.162.4, `mermaid` to 12.0.0, `markdown-it` to 15.0.2, `@pierre/diffs` to 1.4.1, `@codemirror/view` to 6.43.11, `@codemirror/lang-markdown` to 6.5.2, and `@vitejs/plugin-react` to 6.1.1 (#231, #260).
- Upgraded backend dependencies and tooling: `pypdf` to 6.18.1, `openai-agents` to 0.22.2, `httpx2` to 2.13.0, and `ruff` to 0.16.7 (#231, #258).
- Updated GitHub Actions automation: `astral-sh/setup-uv` to 10.1.0, `pnpm/action-setup` to 6.1.0, and `docker/setup-qemu-action` to 4.3.0 (#231, #258).


## [0.12.2] - 2026-09-09

### Added

- Unified verifiable behavior harness (`scripts/control-sangam.sh`, `just verify-behavior`): automated 5-stage pipeline covering isolated launch, SQLite doctor health checks, deterministic multi-modal data seeding, write/search latency benchmarking, and live agent evaluations (#200).
- Automated multi-modal verification data seeding (`scripts/seed_verification.py`): generates rich Markdown documents, sandboxed HTML widgets for trusted preview isolation validation, multi-page searchable PDFs, and scoped agent bearer tokens (#200).
- Live chat agent evaluations and capability lifecycle verification embedded into the automated test pipeline, achieving a 100% pass rate across all 17 agent tasks on `openai/gpt-5.6-luna` (#200).
- Comprehensive behavioral feature maps in `.agents/skills/verify-sangam/features/` documenting boundaries for chat agent evals, agent tokens and security, file materialization, trusted preview, document creation, search, revisions, and performance benchmarking (#200).
- Interactive visual architecture explainer documented in `docs/verifiable-architecture.html` (#200).
- Immediate visual and screen-reader copy URL feedback on publication cards with dynamic aria-label announcements (#193).

### Changed

- Migrated default chat model from `openai/gpt-5.6-sol` to `openai/gpt-5.6-luna` across server configuration, environment templates, evaluators, and documentation (#200).
- Optimized workspace tree sorting by precomputing directory modification timestamps, eliminating repetitive linear scans and reducing sort complexity from O(N * M log N) to O(N log N) (#194).
- Consolidated and upgraded backend dependencies (`typer` 0.27.2, `ruff` 0.16.5) and frontend dependencies (`react` / `react-dom` 19.2.8, `zod` 4.5.4, `mermaid` 11.17.2, `react-resizable-panels` 4.12.4, `globals` 17.12.0, `pnpm/action-setup`) (#183, #201).

### Fixed

- Enforced path-scoped read capability checks on trusted preview issuance (`POST /api/v1/documents/{document_id}/trusted-preview`) to prevent authorization bypass for scoped agent tokens (#195).
- Hardened workspace path canonicalization and agent token scope prefix validation to explicitly reject null bytes, control characters, and reserved directory locations (#196).
- Guaranteed cleanup of orphaned temporary manifest files during backup failures and added concurrency safety tests for atomic document operations (#197).
- Hardened mutation audit provenance tracking, sensitive authorization header and bearer token stripping, and structured JSON Lines audit log export (#198).
- Overrode `smol-toml` to >=1.7.1 to remediate advisory GHSA-7w5x-hrqm-74c2 (#199).

## [0.12.1] - 2026-09-04

### Added

- Operations center for agent access and activity: `Settings > Agents & access` now provides outcome-first visibility into active, expired, expiring-soon, and recently denied tokens alongside last-activity timestamps (#175, #190).
- Dedicated Activity interface within the Settings navigation rail featuring route-aware Insights and Activity tabs, responsive metrics, and a two-series activity trend chart (#175, #190).
- Operator attention acknowledgement workflow: review and acknowledge attention items with reversible dismissal, synchronized badge counts, and automatic reopening when newer matching failures occur without altering immutable audit records (#175, #190).
- Server-backed agent and token selectors, URL-persisted investigative filters, and anchored refresh controls that avoid continuous request loops (#175, #190).
- Support for extending expiration on expired agent tokens, reactivating existing secrets immediately without runner configuration redeployments (#191).
- Safe rotation for expired tokens with automatic duration calculation (minimum 7 days) and distinct confirmation modals separating renewal, scope editing, and key rotation (#191).
- Collapsible inactive and rotated token history drawer to declutter the active agent access table (#191).

### Changed

- Replaced raw actor and token ID text inputs with server-populated dropdowns and fallback deep-link support across Activity views (#175, #190).
- Aligned Activity typography with the Settings UI design system, replacing verbose text labels with accessible, titled icon actions and ensuring 44px touch targets (#175, #190).

### Upgrade notes

- Database migration `021_activity_investigation_indexes.sql` adds targeted indexes on `operation_events` for token, resource, action, and error queries.
- Database migration `022_activity_problem_acknowledgements.sql` adds the `activity_problem_acknowledgements` table for durable presentation state of reviewed attention items.
- Activity APIs remain strictly administrator-only and ledger records remain append-only.

## [0.12.0] - 2026-09-01

### Added

- Consistent workspace organization for PDF documents: PDFs now participate in organization plans, drag-and-drop, context menu actions (Move to..., Rename, Duplicate, Edit tags and category..., Move to trash), keyboard actions (F2 rename), and Trash restoration (#176).
- Managed PDF trash storage with immutable byte retention in `.sangam-trash`, conflict-safe restoration, and reconciliation scan protection (#176).
- Recoverable and dismissible chat effects: failed or rejected chat tool effects now surface in an interactive effect tray with dismiss controls, retry workflows, bounded error summaries, and durable acknowledgement tracking (#177).

### Changed

- Migrated frontend package management and repository tooling from npm to pnpm (v11.24.0) with store caching across local justfile recipes, Docker builds, and CI workflows (#178).

### Upgrade notes

- Database migration `020_chat_effect_acknowledgement.sql` stores durable dismissal and acknowledgement state for failed chat effects.

## [0.11.1] - 2026-08-29

### Added

- Markdown preview and reading views now apply comfortable reading measure constraints and typography refinements for long-form documents (#173).
- Added `just bundle-report` command and lightweight bundle analysis script to report initial Vite entry graphs and lazy chunks (#173).

### Changed

- Workspace inspector and workbench views refine document metadata headers, tags editing, selection chips, and drawer transitions (#173).

### Upgrade notes

- This release has no database migrations, security-specific changes, new required configuration, manual upgrade steps, or release-specific known limits. Replace the running container with the 0.11.1 image.

## [0.11.0] - 2026-08-29

### Added

- The workspace explorer now supports canonical folder selection, file and folder drag-and-drop, full Pierre multi-selection, a searchable **Move to…** dialog, supported pointer and keyboard row actions, bulk tags/category updates, and bulk Trash. The command palette exposes the same organization actions (#162).
- Chat can inspect bounded organization metadata and prepare exact plans for folder creation, draft materialization, document and folder moves, metadata updates, and Trash. Plans use stable IDs, stale-state checks, resumable idempotent execution, and dedicated review cards (#163).
- AI settings now default to GPT-5.6 Sol with medium reasoning and offer Review or YOLO modes. Review pauses every effect for a decision. YOLO runs every authorized effect immediately, including publication. Deterministic policy tests and 17 live provider evals cover both modes (#163).

### Changed

- Completed chat effects collapse into one expandable summary, active runs provide a persistent **Stop** control, and replies follow the language of the latest user request (#167).
- Durable chat effects stop and resume sequentially, so multi-create review cannot leave duplicate approval cards and YOLO does not emit an interim missing-result message (#167).

### Upgrade notes

- Database migration `019_organization_plans_and_chat_autonomy.sql` stores organization execution recovery, chat permission mode, and run cancellation state. Existing installations start in review mode.

## [0.10.1] - 2026-08-25

### Added

- Workspace files can now be sorted by last modified time, name A-Z, or name
  Z-A. The selected order persists in the browser, and folders stay with their
  descendants (#143).

### Fixed

- Chat can now create HTML documents as well as Markdown documents. The review
  dialog identifies the selected format before the document is approved (#144).
- File-tree labels now use one left-to-right text run with end truncation. This
  prevents overlapping text and reversed extension fragments in narrow sidebars
  while preserving the full accessible name and inline rename behavior (#143).
- The file-tree context menu now closes after a click outside the menu. A
  secondary click on empty tree space no longer opens it (#143).

### Upgrade notes

- This release has no database migrations, security-specific changes, new
  required configuration, manual upgrade steps, or release-specific known
  limits. Replace the running container with the 0.10.1 image.

## [0.10.0] - 2026-08-25

### Added

- Chat edit proposals can now replace a unique anchor, insert before or after an
  anchor, or append content. The server resolves each patch against the pinned
  document revision before creating the proposal, so review and stale-revision
  checks still use the complete proposed document (#132).
- `read_document` and `search_workspace` now support pagination. Read-only chat
  tools can run in parallel, the maximum output budget is 16,384 tokens, and the
  default tool-round limit is 24 (#132).
- `just eval-chat` runs a 10-case live chat suite for edits, cited answers,
  multi-step tasks, publishing safety, and workspace boundaries (#132).
- Shared motion tokens now cover menus, dialogs, drawers, tabs, and controls.
  Reduced-motion preferences disable these animations (#137).

### Changed

- Workspace tabs share the available width and scroll the active tab into view.
  Compact inspector chat now fits the full supported 290 px to 720 px rail range
  without horizontal overflow (#136).
- `just` recipes are now the canonical interface for formatting, tests, browser
  checks, Compose validation, and screenshot updates (#135).

### Fixed

- File-tree indent guides no longer appear when the tree is hovered or a row is
  active (#131).

### Upgrade notes

- This release has no database migrations, security-specific changes, or new
  required configuration. Replace the running container with the 0.10.0 image.
- The optional live chat eval suite requires `SANGAM_OPENROUTER_API_KEY` and makes
  paid provider requests. It is not part of the runtime upgrade.

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

[Unreleased]: https://github.com/jayshah5696/sangam/compare/v0.13.5...HEAD
[0.13.5]: https://github.com/jayshah5696/sangam/compare/v0.13.4...v0.13.5
[0.13.4]: https://github.com/jayshah5696/sangam/compare/v0.13.3...v0.13.4
[0.13.3]: https://github.com/jayshah5696/sangam/compare/v0.13.2...v0.13.3
[0.13.2]: https://github.com/jayshah5696/sangam/compare/v0.13.1...v0.13.2
[0.13.1]: https://github.com/jayshah5696/sangam/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/jayshah5696/sangam/compare/v0.12.3...v0.13.0
[0.12.3]: https://github.com/jayshah5696/sangam/compare/v0.12.2...v0.12.3
[0.12.2]: https://github.com/jayshah5696/sangam/releases/tag/v0.12.2
[0.12.1]: https://github.com/jayshah5696/sangam/releases/tag/v0.12.1
[0.12.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.12.0
[0.11.1]: https://github.com/jayshah5696/sangam/releases/tag/v0.11.1
[0.11.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.11.0
[0.10.1]: https://github.com/jayshah5696/sangam/releases/tag/v0.10.1
[0.10.0]: https://github.com/jayshah5696/sangam/releases/tag/v0.10.0
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
