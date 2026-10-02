# Repository rules

- Always use `just` recipes as the canonical interface for testing, formatting, linting, building, and running Sangam. Do not assemble ad-hoc shell commands or bypass `justfile`.

## Verifiable behavior rules

- For backend, CLI, API, data-integrity, or performance changes, use the project `verify-sangam` skill (`just verify-behavior`) to establish empirical proof against an isolated instance before calling the work verified.
- Do not rely on mocked units or unexercised assertions when live driving against an ephemeral instance is available.
- For user-visible browser changes or browser defect reviews, use the project `browser-verification` skill (`just test-e2e`) before calling the work verified. It defines the desktop, narrow-desktop, true touch-mobile, affected-breakpoint, and visual evidence gates.
- Run `just format`, `just test`, and `just test-e2e` before updating verified screenshots.

## Chat parity rules

- A user-facing workspace action should also be a chat capability unless `docs/chat-capabilities.md` lists it as unavailable by design.
- Chat capabilities call the same `WorkspaceAccessService` operations as the app and run with the requester's authority. See `docs/chat-capabilities.md` before adding one.

## UI consistency rules

- Read `docs/ui-system.md` and search existing components and CSS before changing application UI.
- Reuse shared tokens for fonts, type sizes, spacing, radii, colors, and control heights.
- Do not introduce hard-coded UI dimensions when an existing semantic token applies.
- Keep application chrome on `var(--font-ui)`; reserve display and mono fonts for documented roles.
- Reuse established button, field, badge, rail, panel, menu, and empty-state anatomy.
- Use `StateMessage` for shared loading, empty, error, success, and offline states.
- Settings search must focus the exact destination row; keep destination IDs stable.
- Editor and preview surfaces must fill available space and own overflow where appropriate.

## Anti-slop and TypeScript evidence rules

- Reject low-evidence TypeScript and JavaScript patterns:
  - Do not use chained type assertions (`as unknown as T`).
  - Do not use non-const type assertions (`as T`) without a preceding `// SAFETY: <justification>` comment explaining why the invariant holds.
  - Do not widen known values to open dictionary or generic object types when precise inference or `satisfies` is available.
  - Parse and validate external or untrusted payloads at I/O boundaries (e.g. using Zod schemas) rather than using unconstrained dictionary types (`Record<string, unknown>`), loose runtime `typeof` branches, or functions exposing `unknown` parameters/returns.
  - Do not use conditional empty object spread (`...(condition ? { key: value } : {})`) or module mocking in application code.
- Run `just anti-slop` (or `just lint`) to verify all TypeScript and JavaScript files comply with the anti-slop Oxlint rules.

## Asset and documentation hygiene

- Do not commit ad-hoc PR screenshots, issue evidence folders, or prototype HTML files into `docs/` or `assets/`; write ephemeral test captures to Playwright artifact directories (`test.info().outputPath(...)`).
- Keep only canonical documentation and verified UI reference assets (`docs/assets/crisp-*.png`, lifecycle diagrams, demo media) tracked in git.
