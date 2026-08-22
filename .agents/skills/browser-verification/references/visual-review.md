# Visual review

Visual evidence supports behavioral assertions. It does not replace them.

## Deterministic capture

Before taking a baseline or maintained screenshot:

- use the isolated E2E server and deterministic API-seeded data;
- fix the browser project, viewport or device, theme, and reduced-motion setting;
- wait for the expected state with a web-first assertion;
- wait for `document.fonts.ready` when typography affects the result;
- disable animations for visual snapshots;
- stabilize dates, times, random identifiers, cursors, and external content;
- mask only volatile content unrelated to the layout under review;
- prefer CSS-pixel screenshot scale;
- generate and compare baselines in the same operating system and browser environment.

Do not hide a real defect by widening pixel tolerances. A tolerance needs a narrow, written reason.

## What to capture

For an affected workflow, capture the natural set among:

1. default state;
2. changed interaction state;
3. stress state, such as long text, open overlay, error, conflict, or narrow width;
4. reverse state after close, cancel, retry, or browser back.

Capture the affected state on desktop and touch-mobile. Add landscape or a breakpoint sentinel when the layout changes there.

Use:

- full viewport screenshots for shell and scroll ownership;
- component screenshots for menus, toolbars, cards, and panels;
- video for animation, streaming, delayed state, resizing, drag, or timing defects;
- Playwright traces to diagnose failures, not as a substitute for maintained evidence.

## Visual regression policy

Use `expect(page).toHaveScreenshot()` or locator snapshots for stable, high-value states only. Good candidates include:

- workbench chrome;
- mobile inspector or workspace drawer;
- settings navigation and exact destination focus;
- PDF reader, selection toolbar, and annotation preview;
- menu, popover, dialog, conflict, offline, and error states.

Avoid snapshots of volatile feeds, live provider content, timestamps, random IDs, or entire route matrices that produce noise without protecting a design contract.

Baseline updates are a review event:

1. run the behavior tests;
2. update only the intended baselines;
3. inspect the actual, expected, and diff images;
4. explain every material changed region;
5. run the comparison again without update mode;
6. confirm no unrelated tracked images changed.

## Documentation and PR evidence

Documentation screenshots and PR evidence are not test baselines.

- Ordinary `test:e2e` must not write tracked documentation assets.
- Generate documentation assets only with the explicit screenshot update command.
- Keep PR-only captures outside tracked product assets.
- UI changes should show before and after images when a before state is available.
- Motion and timing changes should include a short video.

## Inspection checklist

Inspect each image at its native size. Record the result for every applicable item:

- no unintended clipping or overlap;
- no page-level horizontal overflow;
- expected scroll container owns overflow;
- headings, labels, values, and controls wrap or truncate deliberately;
- fixed controls do not obscure content;
- menus, tooltips, popovers, dialogs, and sheets stay inside the viewport;
- spacing, typography, radii, colors, and control heights use the Sangam UI grammar;
- focus is visible and returns correctly;
- touch targets meet the mobile requirement;
- destructive, loading, empty, error, conflict, success, stale, and offline states read truthfully;
- dark and light roles retain contrast where the change applies;
- no cursor, transient toast, skeleton, half-loaded font, or animation frame polluted the capture.

A valid report names what was inspected. `Looks good` is not a visual review.

## Example

```ts
await page.getByRole('button', { name: 'Open document inspector' }).click()
const inspector = page.locator('.document-inspector')
await expect(inspector).toBeVisible()
await expectNoHorizontalOverflow(page)
await page.evaluate(() => document.fonts.ready)
await expect(page).toHaveScreenshot('touch-mobile-document-inspector.png', {
  animations: 'disabled',
  scale: 'css',
})
```
