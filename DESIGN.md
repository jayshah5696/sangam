# Sangam Design System

Sangam is a single-user, self-hosted document workbench where a human and
identified AI agents work on the same files. This file is the quick-reference
design contract for UI work. Detailed subsystem guidance lives in
[docs/ui-system.md](docs/ui-system.md) and [docs/brand.md](docs/brand.md).

## Aesthetic Direction

- **Quiet, dense, and obvious.** The document is the primary subject; chrome
  stays subdued and predictable.
- **Structure through whitespace and 1px hairlines.** Use whitespace to group
  regions, `1px solid var(--line)` borders to define boundaries, and accent
  color only for selection, focus, or active status.
- **No card-stacking.** Do not wrap every group of controls in a raised card or
  nested bordered box. Reserve cards for distinct tasks such as theme selection
  or conflict resolution, and separate sections inside a form with `1px`
  dividers.

## Brand Identity

- Primary mark: [`frontend/public/sangam-mark.svg`](frontend/public/sangam-mark.svg)
  (Ink `#102A43` and Cobalt `#2F80ED` with equal visual weight on a light field).
- Monochrome mark:
  [`frontend/public/sangam-mark-monochrome.svg`](frontend/public/sangam-mark-monochrome.svg)
  for dark surfaces or single-color contexts.
- Render `Sangam` as live text beside the mark; never add gradients, glows, or
  independent animation to the mark.

## Color and Contrast

- All colors come from semantic custom properties in
  [`frontend/src/styles/tokens.css`](frontend/src/styles/tokens.css). Raw hex,
  `rgb()`, and `rgba()` values outside `tokens.css` are rejected by lint.
- 16 built-in themes (dark and light pairs) plus user-created themes follow the
  same contrast floor:
  - Body text, muted text, and sidebar text: at least **4.5:1** (WCAG AA).
  - Accent against surface: at least **3:1**.
- A dark navigation rail (`ui-rail--inverse`) paired with a light editor and
  inspector (`ui-rail--surface`) is intentional; both rails share typography,
  spacing, radii, and control dimensions.

## Typography

- `--font-ui`: application chrome, controls, navigation, labels, and menus.
- `--font-display`: document titles, rendered Markdown headings, and page
  display headings only.
- `--font-mono`: editor content, diffs, case-sensitive workspace paths,
  identifiers, keyboard shortcuts, and code. Never uppercase paths or IDs.
- Type scale tokens:
  - `--text-meta` (`11px`): timestamps, IDs, badges, secondary metadata.
  - `--text-label` (`12px`): section and field labels.
  - `--text-control` (`13px`): buttons, inputs, tabs, menu items, tree rows.
  - `--text-body` (`14px`): primary UI copy and descriptions.
  - `--text-editor` (`14px`): editable document content.
  - `--text-input-mobile` (`16px`): form inputs and textareas on narrow or
    coarse-pointer viewports to prevent mobile Safari auto-zoom.
  - `--text-display-sm` (`22–31px` fluid) and `--text-display` (`36–64px`
    fluid): document headers and full-page headings.
- Interactive text must never be smaller than `--text-control` (`13px`).
- Headings use `text-wrap: balance`; body paragraphs use `text-wrap: pretty`;
  timestamps, counts, and metric values use `font-variant-numeric: tabular-nums`.

## Spacing, Geometry, and Elevation

- Spacing tokens: `--space-1` (`4px`), `--space-2` (`8px`), `--space-3`
  (`12px`), `--space-4` (`16px`), `--space-5` (`24px`).
- Control heights: `--control-height` (`32px`), `--control-compact` (`28px`),
  `--control-touch` (`44px` minimum on coarse pointers).
- Radii: `--radius-control` (`6px`), `--radius-panel` (`8px`), `--radius-pill`
  (`999px`).
- Icons use semantic Lucide size tokens: `--icon-detail` (`12px`),
  `--icon-inline` (`14px`), `--icon-control` (`16px`), `--icon-section`
  (`18px`), `--icon-page` (`24px`).
- Elevation relies on crisp `1px solid var(--line)` borders and a single soft
  `var(--shadow-panel)` drop shadow on floating overlays. Avoid decorative inner
  highlight rings.

## Motion and Accessibility

- Motion tokens live in `tokens.css`:
  - `--motion-none` (`0ms`)
  - `--motion-instant` (`80ms`)
  - `--motion-fast` (`120ms`)
  - `--motion-control` (`160ms`)
  - `--motion-panel` (`220ms`)
  - `--motion-tooltip-delay` (`400ms`)
  - `--ease-ui-out` (`cubic-bezier(0.16, 1, 0.3, 1)`)
  - `--ease-ui-in-out` (`cubic-bezier(0.4, 0, 0.2, 1)`)
- Animate only composite-friendly properties (`transform`, `opacity`) and color
  or border states; never use `transition: all` or animate layout dimensions.
- Popovers (`ActionMenu`, `ActionDialog`) set `data-side` (`top` / `bottom`)
  and `data-align` (`left` / `right`) so `transform-origin` matches the trigger.
- Pointer-only `:hover` rules belong inside
  `@media (hover: hover) and (pointer: fine)` so touch devices never get stuck
  hover states. Keep `:focus-visible`, `.active`, `[aria-selected="true"]`, and
  `[aria-expanded="true"]` unconditional.
- Honor both `@media (prefers-reduced-motion: reduce)` and
  `@media (prefers-reduced-transparency: reduce)` (removing backdrop blur when
  reduced transparency is requested).

## Prohibited Patterns

- Raw `px`, `rem`, `clamp()` font sizes, raw color literals, raw `ms`/`s`
  transitions, or custom `cubic-bezier()` curves outside `tokens.css`.
- Bouncy, spring-overshoot, or ambient infinite animations when no real
  asynchronous work is running.
- Decorative left-accent stripes on non-quote list items or cards.
- Generic marketing fluff, unstyled JSX class names, or parallel UI scales.

## Verification

- `just test-frontend`: formatting, Oxlint + anti-slop, UI system token checks,
  production build, and Vitest unit tests.
- `just test-e2e`: Playwright desktop, narrow (`390px`), touch-mobile, motion,
  and axe accessibility checks.
- `just update-screenshots`: regenerates README screenshots from isolated
  fixtures; inspect every updated PNG visually before committing.
