# Sangam UI system

Sangam uses one visual grammar across the workbench, both sidebars, settings,
activity, menus, and embedded Pierre components. A dark navigation rail and a
light inspector rail are valid theme roles; they must still share typography,
spacing, control dimensions, and component anatomy.

## Typography

- `--font-ui`: all application chrome, controls, navigation, labels, and menus.
- `--font-display`: document titles, rendered Markdown headings, and major display headings only.
- `--font-mono`: editor content, diffs, paths, identifiers, shortcuts, and code.
- `--text-meta` (10px): timestamps, IDs, secondary descriptions, and badges.
- `--text-label` (11px): section labels and field labels.
- `--text-control` (12px): buttons, inputs, tabs, menu items, and tree rows.
- `--text-body` (13px): primary UI values and compact body copy.
- `--text-editor` (14px): editable document content.

Interactive text must not be smaller than `--text-control`. New styles must use
these semantic tokens instead of hard-coded font sizes.

## Dimensions

- Spacing uses `--space-1` through `--space-5`: 4, 8, 12, 16, and 24px.
- Standard controls use `--control-height` (32px).
- Deliberately compact controls use `--control-compact` (28px).
- Controls use `--radius-control` (6px).
- Panels and popovers use `--radius-panel` (8px).
- Badges and status pills use `--radius-pill`.

## Rails

Both sidebars use the shared `ui-rail` and `ui-rail-header` anatomy. Use
`ui-rail--inverse` for dark navigation surfaces and `ui-rail--surface` for light
inspection surfaces. Rail-specific CSS may change layout or color, but must not
introduce a new type scale, control height, or radius system.

## Embedded components

Pierre Trees and Diffs receive the same font stacks, sizes, and radii through
their CSS custom-property APIs. Overrides belong in `ui-system.css` so embedded
components remain synchronized with native Sangam controls.

## Adding UI

1. Pick the semantic text role before writing a selector.
2. Use the shared spacing, control, and radius tokens.
3. Reuse existing rail, tab, field, button, row, badge, or menu behavior.
4. Add new tokens only when the role is genuinely absent, not to match a single mockup.
5. Check every theme and both desktop and narrow layouts before merging.

`npm --prefix frontend run lint` enforces the compact type, font-family, radius,
and defined-custom-property rules so a new component cannot quietly introduce
a parallel UI scale or reference a missing design token.
