---
name: browser-verification
description: Verify Sangam user-visible browser changes and browser defects with Playwright behavior tests, true touch-mobile coverage, breakpoint checks, and visual evidence. Use before calling frontend work verified, when fixing UI or browser bugs, or when capturing or updating screenshots.
compatibility: Sangam repository with Node, uv, and Playwright browsers installed.
---

# Browser verification

Treat browser verification as a proof, not a tour of the happy path. Agent-browser, computer use, and one-off Playwright scripts are useful for discovery. Durable verification comes from committed Playwright behavior tests.

## 1. Classify the change

Read `docs/ui-system.md`, the affected components and styles, and the existing specs under `frontend/e2e/`.

Write down which surfaces apply:

- desktop Chromium;
- narrow desktop with a fine pointer;
- touch-mobile Chromium when configured or added for the affected workflow;
- mobile Safari for mobile-sensitive browser behavior when configured or added;
- one pixel on each side of an affected CSS breakpoint;
- landscape or the 320px minimum width for horizontally dense controls;
- a physical phone when emulation cannot reproduce the behavior.

Read [references/mobile-matrix.md](references/mobile-matrix.md) when a compact layout, touch interaction, responsive breakpoint, mobile browser, PDF, drawer, sheet, overlay, or virtual keyboard can affect the result.

Completion criterion: every affected surface is selected or excluded with a concrete reason.

## 2. Establish behavioral proof

For a defect, first add or identify a Playwright assertion that fails for the reported behavior. For new behavior, state the user-visible outcome before implementing the test.

- Seed prerequisites through API fixtures against the isolated E2E server.
- Reach the behavior through user-facing roles, labels, and actions.
- Assert the visible result and persisted state when the workflow mutates data.
- Assert focus, viewport containment, scroll ownership, and the reverse action when they apply.
- Wait for observable UI, network, or application state. A larger timeout or arbitrary sleep is not a synchronization fix.
- Keep live ChatKit, OpenRouter, Karakeep, tunnels, and physical-device checks outside deterministic CI. Report them as separate opt-in checks.

Run the smallest relevant spec and configured project while iterating. If a required surface has no project, add focused coverage or report it as `unverified`; never substitute narrow desktop for touch-mobile. Inspect the Playwright trace, DOM snapshot, network, console, screenshot, video, and server log before changing code after a failure.

Completion criterion: the focused regression passes on every selected deterministic surface and fails for the intended reason when the defect is reintroduced.

## 3. Perform visual review

Behavioral assertions come first. Read [references/visual-review.md](references/visual-review.md) for layout or styling changes, overlays, screenshots, visual snapshots, motion, streaming, resizing, or timing behavior.

- Use `toHaveScreenshot()` only for stable, high-value application states.
- Keep documentation and PR evidence separate from visual-regression baselines.
- Capture affected desktop and true touch-mobile states.
- Use video for motion, timing, streaming, or resize behavior that a still image cannot prove.
- Normal test runs must leave tracked screenshots unchanged.
- Update tracked screenshots only through their explicit update command after behavior tests pass, then inspect every changed image.

Completion criterion: each changed image has been inspected against the checklist, not merely generated or accepted.

## 4. Run the handoff gates

Run the focused tests first, then the complete applicable gates:

```bash
just test-frontend
just test-e2e
```

Or run the full local verification suite:

```bash
just test
```

When visual screenshot baselines need updating for verified changes, run `just update-screenshots`.

Completion criterion: all required commands pass, or the handoff names each failure and why it remains.

## 5. Report without inflating the claim

Report:

- exact commands;
- pass, fail, and skip counts;
- tested browser projects, pointer modes, viewport or device profiles, and affected breakpoints;
- visual snapshots, screenshots, videos, traces, or other evidence inspected;
- live integrations and physical-device behavior that remain unverified;
- whether the test run changed tracked screenshot assets.

Use precise labels:

```text
Bad: Resized Desktop Chrome to 390x844. Mobile verified.
Good: Narrow desktop passed at 390x844. Touch-mobile Chromium passed with
      isMobile and hasTouch enabled. Physical mobile was not run.
```

```text
Bad: The screenshot looks fine.
Good: Inspected the touch-mobile inspector image. The sheet stays within the
      viewport, all tabs remain reachable, controls meet the touch target,
      focus returns to the trigger, and page-level horizontal overflow is zero.
```

Do not call browser behavior verified when the required browser could not run. State the blocker and use `unverified`.
