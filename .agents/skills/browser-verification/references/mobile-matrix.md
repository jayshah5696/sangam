# Mobile and responsive matrix

Use the smallest matrix that covers the changed behavior. Narrow desktop and touch-mobile are different surfaces.

## Baseline surfaces

Inspect `frontend/playwright.config.ts` before selecting commands. Do not assume every surface already has a configured project.

| Surface | Profile | Input model | Required purpose |
| --- | --- | --- | --- |
| Desktop Chromium | Current `chromium-desktop` project | Fine pointer, keyboard | Full application chrome, split panes, keyboard and focus behavior |
| Narrow desktop | Current `chromium-narrow` project at 390x844 | Fine pointer | A resized desktop browser and compact layout without mobile emulation |
| Touch-mobile Chromium | Pixel device profile | `isMobile`, `hasTouch`, coarse pointer | Touch rules, mobile viewport behavior, sheets, drawers, overlays, and target sizes |
| Mobile Safari | iPhone WebKit device profile | Touch and mobile WebKit | Focused Safari checks for fixed positioning, viewport height, nested scrolling, selection, clipboard, and forms |

Sangam's current `chromium-narrow` project spreads `Desktop Chrome` over a 390x844 viewport. It is narrow desktop, not mobile. Playwright device profiles also emulate the user agent, screen, touch capability, and mobile viewport behavior.

If an affected touch-mobile or WebKit profile is not configured, add focused project coverage as part of the browser-facing change or report that surface as `unverified`. A small desktop viewport cannot substitute for it.

## Breakpoint sentinels

Sangam currently has responsive rules around 1100, 940, 900, 860, 800, 768, 650, and 600 CSS pixels. Inspect the styles changed by the task. For every affected boundary, test one pixel above and below it.

Example:

```text
769px: expanded workbench rule
767px: compact workbench rule
```

Do not multiply the full suite across every breakpoint. Add a focused test for the component or workflow that changes at that boundary.

Also include:

- landscape, roughly 844x390, when controls are horizontally dense;
- 320x568 when the change can affect the minimum supported width;
- long labels, model IDs, paths, titles, or translated-looking text when wrapping or truncation matters.

## Touch-mobile checks

Select each applicable check and assert it:

- coarse-pointer controls use at least `--control-touch` or 44 CSS pixels;
- every hover-only action has a tap or explicit menu path;
- drawers, sheets, menus, dialogs, and popovers remain inside the viewport;
- backdrop dismissal and the visible close control work;
- focus returns to the invoking control after an overlay closes;
- fixed and sticky controls do not cover content or input fields;
- the page has no unintended horizontal scroll;
- editor, preview, PDF, chat, and modal surfaces own their intended scrolling;
- text selection and annotation toolbars stay in bounds;
- destructive actions expose confirmation and cancellation;
- drag or resize behavior has a non-drag alternative;
- reduced-motion mode preserves state and meaning;
- changing route, tab, or orientation does not lose relevant persisted state.

## Workflow probes

| Area | Probe |
| --- | --- |
| Shell | Open and close the workspace drawer, navigate, dismiss the backdrop, verify focus return |
| Workbench | Open a document, switch edit and preview, verify save state, open the inspector sheet |
| Settings | Navigate categories, search to an exact destination, exercise long values and dialogs |
| PDF | Fit width, scroll pages, select text, open annotation controls, open research in the sheet |
| Chat | Keep the composer visible, scroll messages, change context, and close the inspector sheet |
| Menus | Open by tap, keep the menu in bounds, dismiss it, and cancel destructive confirmation |
| Utility routes | Reflow cards and exercise loading, empty, error, offline, or confirmation states that changed |

## When emulation is insufficient

Require a physical iOS or Android pass when the result depends on:

- the virtual keyboard or visual viewport resizing;
- native text selection handles;
- clipboard or file-picker permissions;
- camera or photo-library input;
- safe-area insets;
- mobile browser chrome changing viewport height;
- momentum scrolling or overscroll;
- pinch zoom or native PDF gestures.

Until device infrastructure exists, record this as a manual check. Never report physical-mobile verification from Playwright emulation alone.
