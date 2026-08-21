# UI consistency rules

- Read `docs/UI_SYSTEM.md` and search existing components and CSS before changing application UI.
- Reuse shared tokens for fonts, type sizes, spacing, radii, colors, and control heights.
- Do not introduce hard-coded UI dimensions when an existing semantic token applies.
- Keep application chrome on `var(--font-ui)`; reserve display and mono fonts for documented roles.
- Reuse established button, field, badge, rail, panel, menu, and empty-state anatomy.
- Use `StateMessage` for shared loading, empty, error, success, and offline states.
- Settings search must focus the exact destination row; keep destination IDs stable.
- Editor and preview surfaces must fill available space and own overflow where appropriate.
- Validate UI changes at desktop and narrow viewports with an actual browser.
- Run formatting, UI lint, build, unit tests, and `test:e2e` before updating verified screenshots.
