# Repository rules

- Always use `just` recipes as the canonical interface for testing, formatting, linting, building, and running Sangam. Do not assemble ad-hoc shell commands or bypass `justfile`.

## UI consistency rules

- Read `docs/ui-system.md` and search existing components and CSS before changing application UI.
- Reuse shared tokens for fonts, type sizes, spacing, radii, colors, and control heights.
- Do not introduce hard-coded UI dimensions when an existing semantic token applies.
- Keep application chrome on `var(--font-ui)`; reserve display and mono fonts for documented roles.
- Reuse established button, field, badge, rail, panel, menu, and empty-state anatomy.
- Use `StateMessage` for shared loading, empty, error, success, and offline states.
- Settings search must focus the exact destination row; keep destination IDs stable.
- Editor and preview surfaces must fill available space and own overflow where appropriate.
- For user-visible browser changes or browser defect reviews, use the project
  `browser-verification` skill before calling the work verified. It defines the
  desktop, narrow-desktop, true touch-mobile, affected-breakpoint, and visual
  evidence gates.
- Run `just format`, `just test`, and `just test-e2e` before updating verified screenshots.

## Anti-slop and TypeScript evidence rules

- Reject low-evidence TypeScript and JavaScript patterns:
  - Do not use chained type assertions (`as unknown as T`).
  - Do not use non-const type assertions (`as T`) without a preceding `// SAFETY: <justification>` comment explaining why the invariant holds.
  - Do not widen known values to open dictionary or generic object types when precise inference or `satisfies` is available.
  - Parse and validate external or untrusted payloads at I/O boundaries (e.g. using Zod schemas) rather than using unconstrained dictionary types (`Record<string, unknown>`), loose runtime `typeof` branches, or functions exposing `unknown` parameters/returns.
  - Do not use conditional empty object spread (`...(condition ? { key: value } : {})`) or module mocking in application code.
- Run `just anti-slop` (or `just lint`) to verify all TypeScript and JavaScript files comply with the anti-slop Oxlint rules.

