# Sangam UI system

Sangam uses one visual grammar across the workbench, both sidebars, settings,
activity, menus, and embedded Pierre components. A dark navigation rail and a
light inspector rail are valid theme roles; they must still share typography,
spacing, control dimensions, and component anatomy.

The interface should feel quiet, dense, and obvious. Use whitespace to separate
regions, one-pixel borders to show structure, and color to communicate selection
or status. Do not wrap every group in a raised card. A card is appropriate only
when its contents are one distinct task, such as choosing a theme or resolving a
conflict.

## Typography

- `--font-ui`: all application chrome, controls, navigation, labels, and menus.
- `--font-display`: document titles, rendered Markdown headings, and major display headings only.
- `--font-mono`: editor content, diffs, paths, identifiers, shortcuts, and code.
- `--text-meta` (11px): timestamps, IDs, secondary descriptions, and badges.
- `--text-label` (12px): section labels and field labels.
- `--text-control` (13px): buttons, inputs, tabs, menu items, and tree rows.
- `--text-body` (14px): primary UI values and descriptions.
- `--text-editor` (14px): editable document content.
- `--text-display-sm` (22–31px, fluid): document route headers in normal and split modes.
- `--text-display` (36–64px, fluid): full-page heroes such as the welcome and publication pages.

Interactive text must not be smaller than `--text-control` (13px). New styles must use
these semantic tokens instead of hard-coded font sizes. Raw `px`, `rem`, and `clamp()`
font sizes are rejected by lint outside `tokens.css`; the one sanctioned exception is
the relative `0.9em` on inline code inside rendered Markdown, which tracks its parent
text size. Icon tokens use `rem` so icons scale with the user's root font size.

### Typography preferences

Settings > Appearance > Typography lets each browser choose the interface font
(`data-ui-font`), interface density (`data-ui-density`), and editor text size
(`data-editor-size`). There is no separate code-font choice: the interface font
applies to all chrome and the editor keeps the shared mono stack for alignment.
The choices are stored with the other workspace preferences in `localStorage`
and applied as `data-*` attributes on `<html>` by an external bootstrap script
in `index.html` before first paint, so there is no flash of the default type.
The override blocks live in `tokens.css` next to the defaults and are the only
place raw font values are allowed. Density multiplies the chrome text tokens;
it never scales `--text-editor`, which has its own control. Touch targets stay
at least `--control-touch` tall in every density.

### Create theme

Settings > Appearance > Create theme is a theme studio: start a theme from one
of the four base palettes, edit its color roles (app background, surface,
raised surface, text, muted text, sidebar, sidebar text, accent) with live
preview on the real workspace, then keep editing or export it as JSON for
sharing. Import theme JSON recreates a shared theme. Custom themes are stored
in the workspace preferences as `customThemes` and applied before first paint:
`data-theme` is set to the theme's base palette while each overridden color
role is injected as an inline custom property on `<html>`, with
`--accent-soft` and a luminance-derived `--accent-text` derived from the
accent. Custom themes appear as cards in the Theme grid and are
browser-scoped like the rest of Appearance.

## Dimensions

- Spacing uses `--space-1` through `--space-5`: 4, 8, 12, 16, and 24px.
- Standard controls use `--control-height` (32px).
- Deliberately compact controls use `--control-compact` (28px).
- Controls use `--radius-control` (6px).
- Panels and popovers use `--radius-panel` (8px).
- Badges and status pills use `--radius-pill`.

## Icons

Lucide icons in application chrome use one semantic size role. Set the `size`
prop to the matching CSS custom property. Do not use a raw number.

- `--icon-detail` (12px): status markers and secondary indicators.
- `--icon-inline` (14px): icons paired with text in buttons, menus, badges, and compact rows.
- `--icon-control` (16px): icon-only buttons, navigation controls, search fields, and rail controls.
- `--icon-section` (18px): settings sections and other section-level identifiers.
- `--icon-page` (24px): route headers and intentional empty-state illustrations.

The icon role does not set the interactive target. Keep icon-only controls on
`--control-height`, `--control-compact`, or `--control-touch` as required. These
roles do not apply to the Sangam logo, document SVG, Mermaid output, PDF content,
PDF overlays, or embedded component internals.

## Rails

Both sidebars use the shared `ui-rail` and `ui-rail-header` anatomy. Use
`ui-rail--inverse` for dark navigation surfaces and `ui-rail--surface` for light
inspection surfaces. Rail-specific CSS may change layout or color, but must not
introduce a new type scale, control height, or radius system.

The document inspector rail supports continuous resizing between 290px and
720px. Embedded tools such as compact ChatKit must reflow inside
`.inspector-chat-surface` across the entire supported rail width without
overflowing the rail or producing page-level horizontal scrollbars.

## Workspace tabs

Open-document tabs in an editor group use equal-width fluid distribution:

- Open tabs share available width equally up to the maximum width (220px).
- When space is constrained, tabs shrink together down to the minimum width
  (118px). Below that threshold, the tab strip enables horizontal scrolling
  while keeping tab widths uniform.
- Pinned tabs use the same outer width as unpinned tabs.
- Hovering or focusing close controls never causes layout shift or tab width
  changes.
- Activating an offscreen tab via pointer, keyboard navigation, route
  restoration, or tab reopen scrolls the active tab into view.

## Interaction states

Every interactive surface must define the states that apply to it. Reuse the
shared button, field, row, tab, badge, and `StateMessage` anatomy before creating
a local variant.

- **Rest and hover:** the default state stays visually quiet; hover adds only
  enough contrast to show that the item is interactive.
- **Focus:** keyboard focus uses the shared focus ring and is never conveyed by
  color alone. Destination focus may use a short pulse when reduced motion is
  not requested.
- **Active and selected:** use the accent edge, background, or marker defined by
  the component. Use `aria-current`, `aria-selected`, `aria-pressed`, or the
  appropriate native state at the same time.
- **Pending and saving:** keep the current value visible and label the work in
  progress. Disable only the action that cannot safely be repeated.
- **Success:** confirm completion near the action. Do not leave a permanent
  success banner for routine autosaves.
- **Empty:** say what is absent and offer the most useful next action when one
  exists.
- **Error and conflict:** explain what failed, preserve the user's work, and
  offer retry, close, or resolution controls. Never replace real data with a
  successful-looking fallback.
- **Offline and stale:** retain readable local state and mark freshness
  explicitly. The workspace rail owns global refresh and connectivity status.
- **Disabled:** use the shared disabled treatment and keep the label readable.
- **Narrow and touch:** reflow instead of clipping. Coarse-pointer targets must
  be at least `--control-touch` tall.

Use `StateMessage` for loading, empty, error, success, and offline messages on
utility routes and recoverable workbench surfaces. Use compact mode inside a
row or panel; use the standard mode when the state replaces the page content.

## Motion

Motion in Sangam is restrained, functional, and semantic. It exists to explain state
and spatial relationships rather than decorate the workbench. If removing motion loses
no information, keep it subtle or omit it.

### Principles

1. **Motion explains a state or spatial relationship:** It clarifies where a panel
   or menu came from, which tab became active, whether work is running/complete/failed,
   or how expanded content relates to its trigger.
2. **Immediate interaction results:** Animation must not delay input readiness,
   keyboard focus, navigation, saving, approvals, or error recovery.
3. **Composite performance:** Large surfaces animate using `transform` and `opacity`
   to avoid triggering layout recalculations on every frame.
4. **Direct pointer response:** User-driven resizing on desktop split handles has
   direct response with zero easing between the pointer and the rail position.
5. **Geometry preservation:** A moving indicator or active state must preserve the
   control's geometry. Hover, focus, selection, and dirty status must not resize tabs or rows.
6. **Paired entry and exit:** An overlay that enters from an edge or origin pairs
   with an intuitive reverse action, backdrop click, Escape key dismiss, and focus return.
7. **Active work representation:** Loading animation runs during real asynchronous
   work and stops immediately when work completes, fails, or unmounts.
8. **Reduced-motion parity:** `prefers-reduced-motion: reduce` strips travel, scale,
   blur, and infinite animation while keeping final states (open, selected, success,
   error) fully visible and functional without delay.
9. **No document content animation:** Document text and code surfaces do not animate
   merely because adjacent application chrome changed.
10. **ChatKit boundary:** ChatKit owns motion inside its iframe; Sangam owns the
    surrounding host chrome, proposals, context banner, and tool status.

### Tokens

- `--motion-instant` (80ms): instant feedback, micro-interactions, and brief delays.
- `--motion-fast` (120ms): tooltips, split handle feedback, badges, and small menu popovers.
- `--motion-control` (160ms): standard buttons, inputs, tabs, and interactive state transitions.
- `--motion-panel` (220ms): drawers, dialog overlays, command palette, and bottom sheets.
- `--ease-ui-out` (`cubic-bezier(0.16, 1, 0.3, 1)`): standard decelerating curve for natural entries and overlays.
- `--ease-ui-in-out` (`cubic-bezier(0.4, 0, 0.2, 1)`): smooth balanced curve for continuous element transitions.
- `--transition-fast` (`var(--motion-control) ease`): compatibility alias for legacy controls.

### Implementation and dependencies

CSS custom properties, CSS transitions, and `@keyframes` are sufficient for Sangam's
workbench interactions. Do not install external motion libraries without concrete evidence
that platform CSS and standard Web APIs are inadequate, including bundle impact and
performance benchmarks.

### Prohibited patterns

- Raw millisecond durations or custom `cubic-bezier()` curves defined outside `tokens.css`.
- Bouncy, elastic, or overshooting transforms that distract from content.
- Animated dimensions (`width`, `height`) during drag/resize interactions.
- Unbounded or unconstrained infinite animations when no work is active.

## Settings

Settings is a dedicated task surface inside the shared application chrome. The
existing workspace sidebar becomes route-aware: Settings replaces Files/Search
and the tree inside the same inverse rail. The container, persisted width,
resize handle, shared header, and drawer behavior do not change. Settings never
adds a second adjacent rail.

- The rail provides six stable categories and search across every setting.
- Search results name both the setting and its category.
- Arrow keys move through results; Enter opens the category and focuses the
  exact destination row.
- Each setting row owns a stable destination ID and keyboard focus target.
- A full-width Back action and Escape return to the preceding workspace route.
- Theme choices preview the real sidebar, editor, inspector, and focus colors;
  decorative swatches alone are not sufficient.
- On narrow and touch screens, Settings uses the existing sidebar drawer. The
  content remains free of page-level horizontal scrolling.

The workspace sidebar footer contains four compact primary destinations: Chat,
Publications, Trash, and Settings. Operational tools belong under Settings:
Agent activity under Agents & access; Reconciliation, Backups, and configured
Karakeep imports under Operations. Their direct URLs remain valid and the
command palette keeps them discoverable.

Agents & access begins with a compact server-backed health summary. The Settings
category shows an attention count only for current access conditions; healthy
workspaces do not carry a permanent success badge. One searchable Activity
destination links to the separate `/activity` investigation surface.

Activity has URL-persisted Insights and Activity views. Insights puts recent
problems before server-computed totals and keeps changed, read, and problem
document measures separate. Activity groups immutable events only by
`operation_id`, calls the group an operation, and retains explicit pagination.
Narrow layouts disclose filters, and touch layouts keep controls at least 44px
tall without creating page-level horizontal scrolling.

## Freshness and recovery

React Query owns server freshness. Queries become stale after 15 seconds and
refresh when the window regains focus or connectivity. The workspace footer is
quiet while healthy and idle. It appears only for exceptional or active states:
an active refresh count, `Offline`, or unresolved reconciliation conflicts.
Connectivity and query activity must never be described as workspace sync;
workspace integrity means unresolved differences between canonical data and
materialized files.

Persisted browser state may outlive a workspace database. If a saved tab points
to a missing document, show a specific recovery state with **Retry** and
**Close stale tab**. Do not strand the editor behind a generic error.

## File tree labels

File and folder labels in the workspace tree use one LTR text run with standard
end ellipsis (`text-overflow: ellipsis`). Sangam does not use middle truncation
or RTL layout for file extensions.

- The full file or folder name remains the accessible name (`aria-label`).
- The visible label is rendered via a `::after` pseudo-element reading
  `attr(aria-label)`. Do not cache a second label in component state, DOM data
  attributes, or mutation observers.
- The label yields space to the decoration, git, and action lanes without
  overlap. Decoration, git, and action sections use `order: 1` to stay after
  the pseudo-element.
- Rename mode (F2) hides the pseudo-element and restores Pierre's native
  content section, keeping the rename input visible and focused.
- Pierre's `MiddleTruncate` content section is hidden via `display: none` on
  `[data-item-section="content"]`, guarded by `:not(:has([data-item-rename-input]))`.
- Overrides live in the `unsafeCSS` boundary of `FileExplorer.tsx` and name
  the upstream issue (`pierrecomputer/pierre#939`) as the removal condition.
- Changes to tree label rendering require desktop, breakpoint, and true
  touch-mobile browser coverage.

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

## Verification and screenshots

Run the fast UI gate while working:

```bash
pnpm --dir frontend run format:check
pnpm --dir frontend run lint
pnpm --dir frontend run build
pnpm --dir frontend run test
```

Before merging an interaction or layout change, run the browser suite. It starts
an isolated Sangam instance, seeds real API data, checks the primary routes with
axe, and covers desktop and 390px layouts:

```bash
pnpm --dir frontend run test:e2e
```

After those checks pass, refresh the verified README assets and inspect all three
images before committing them:

```bash
pnpm --dir frontend run update:screenshots
```

This writes `docs/assets/crisp-workspace.png`, `crisp-chat.png`,
`crisp-workspace-narrow.png`, `crisp-inspector-narrow.png`,
`crisp-chat-narrow.png`, `crisp-settings.png`, `crisp-settings-narrow.png`, and,
when the PDF fixture is available, `phase-5-pdf-research-narrow.png`. Do not
hand-edit or crop these screenshots; they are browser output from an isolated
local fixture.

`pnpm --dir frontend run lint` enforces the compact type, font-family, radius,
and defined-custom-property rules so a new component cannot quietly introduce
a parallel UI scale or reference a missing design token.
