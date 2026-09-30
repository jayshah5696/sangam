# PR 353 browser evidence

These are screenshots of running Sangam instances with API-seeded fixtures.
They are PR evidence, not screenshot regression baselines.

The before version is commit `c2e3ce5`, immediately after PR 342 merged.
The after version is PR 353, including the briefing link target-size fix.
Both use the same titles, source content, document updates, and stale-proposal
fixture. IDs and timestamps differ because each run has isolated storage.

Desktop captures use Chromium at 1440 by 900. Touch-mobile captures use the
configured Pixel 7 profile at 390 by 844 with mobile and touch enabled.
Screenshots of Home and review show the viewport of the application's scrolling
content. Separate region captures show the full briefing and assignment form.

## Before and after

| Workflow | Before | After |
| --- | --- | --- |
| Project Home, desktop | [Before](before-home-desktop.png) | [After](after-home-desktop.png) |
| Stale proposal, desktop | [Before](before-stale-proposal-desktop.png) | [After](after-stale-proposal-desktop.png) |
| Project Home, touch-mobile | [Before](before-home-touch-mobile.png) | [After](after-home-touch-mobile.png) |
| Stale proposal, touch-mobile | [Before](before-stale-proposal-touch-mobile.png) | [After](after-stale-proposal-touch-mobile.png) |

Additional captures show the [intervening human edits](after-intervening-edits-desktop.png),
[mobile briefing](after-briefing-touch-mobile.png), and review assignment form on
[desktop](after-review-assignment-desktop.png) and [touch-mobile](after-review-assignment-touch-mobile.png).

## Reproduce

Run in the PR checkout. For the base checkout, copy only the capture spec into an
isolated worktree at `c2e3ce5` and set `SANGAM_CAPTURE_BASE=1` as well.

```bash
SANGAM_CAPTURE_REVIEW=1 just test-e2e 'capture-projects-screenshots --project=chromium-desktop --project=chromium-touch-mobile'
```

The capture spec waits for the visible workflow, loaded fonts, and zero horizontal
overflow. It writes only ignored test artifacts. Maintained images here are copied
explicitly after inspection. Run capture commands separately from other browser
checks because the canonical recipe rebuilds the frontend and resets test artifacts.

The proposal fixture proves UI state and is not a live model result. Live inference,
server restarts, output reconciliation, and preservation of newer human edits are
verified separately by `just verify-assignments`.
The [saved live verification report](live-verification.json) records the five
successful checks, configured model, persisted artifact identity, and reported
token usage. Its storage was ephemeral and has been cleaned up.
