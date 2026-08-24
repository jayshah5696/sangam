# UI consistency rules

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
- Run formatting, UI lint, build, unit tests, and `test:e2e` before updating verified screenshots.
