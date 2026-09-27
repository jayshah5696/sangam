# Design audit acceptance checklist

This checklist turns the seven practical and four radical recommendations into
reviewable behavior. It is an audit artifact for the implementation and PR
review; it is not a product roadmap promise.

## Practical improvements

1. **Create flows lead to writing**
   - Creating a Markdown document opens the document in Edit mode.
   - The editor receives focus and a new document can be typed into immediately.
   - Existing documents preserve the user's chosen mode where that is already a
     supported preference.
   - The title is directly editable and the create flow does not open the
     inspector by default.
   - Playwright proof: desktop, narrow desktop, and touch-mobile where the
     create control is available; assert mode, focus, and persisted content.

2. **Save language is truthful**
   - A new local draft uses one consistent saved-draft label.
   - Choosing a filesystem location is a distinct move/materialize action.
   - Autosave and materialization states identify the action in progress and
     report success or failure near the action.
   - Playwright/API proof: create, edit, reload, and materialize; assert content
     and path state survive the round trip.

3. **Document content gets the primary canvas**
   - The default document view keeps the inspector closed unless the user has
     explicitly opened it or a document type requires it.
   - Outline, history, chat, and properties remain reachable by labeled controls.
   - The writing/reading surface owns its overflow and does not create page-level
     horizontal scrolling.
   - Visual proof: inspect desktop and touch-mobile default and inspector-open
     states for clipping, focus, and content visibility.

4. **Reduce visual layers around content**
   - The document header and content area use existing UI-system typography,
     spacing, borders, radii, and control tokens.
   - Redundant nested frames are removed without losing region boundaries or
     keyboard landmarks.
   - Visual proof: desktop and narrow screenshots inspected at native size;
     verify no unintended overlap, clipping, or contrast regression.

5. **Tags and organization work in context**
   - Users can create and apply a tag from the document inspector without being
     redirected to Settings.
   - Save feedback is adjacent to the tag control and survives reload.
   - Existing bulk organization and Settings administration remain functional.
   - API/E2E proof: create tag, assign it, reload, and verify document metadata;
     include a long tag label and touch-mobile target checks.

6. **Home is useful after first visit**
   - Populated home leads with recent or pinned documents and useful review work.
   - New document and import actions remain discoverable.
   - Empty and populated states have distinct next actions and truthful copy.
   - E2E proof: seed empty and populated instances; assert the first actionable
     controls and route targets on desktop and narrow desktop.

7. **Mobile is a reading and action surface**
   - Compact mobile chrome leaves the document readable without excessive
     metadata taking the first viewport.
   - Edit, Ask, and More/inspector actions remain reachable by coarse pointer.
   - Sheets and drawers stay within the viewport, have a visible close path,
     return focus to their trigger, and do not cause horizontal page overflow.
   - Playwright proof: true touch-mobile Chromium, 320px minimum-width probe,
     and affected breakpoint sentinels; physical mobile remains manual if not
     available.

## Radical directions

8. **Review destination for agent proposals**
   - Proposed changes have a dedicated discoverable entry point.
   - A proposal opens the affected document with changes, rationale, evidence,
     and accept/reject actions in one review context.
   - Acceptance/rejection preserves revision attribution and can be reversed or
     revisited through history.
   - API/E2E proof: seed a proposal, review both outcomes, reload, and verify
     the revision/event state.

9. **Focused document canvas**
   - Navigation and inspector chrome can be opened and closed without losing
     document state.
   - Contextual tools appear for a selected passage and have a keyboard path.
   - Writing, research, and review layouts retain reachable equivalents for all
     existing actions.
   - Visual and touch proof: open/close each surface, assert scroll ownership,
     focus return, and no page overflow across desktop, narrow, and touch.

10. **Source and draft research layout**
    - A source/PDF and draft can be viewed together at supported widths.
    - Selecting evidence exposes a stable source passage/page and carries a
      citation into the draft.
    - Narrow and touch layouts collapse to an ordered sheet/drawer flow without
      losing the source selection.
    - E2E proof: seed a PDF annotation, transfer it into a draft, reload, and
      assert citation/source metadata.

11. **Readable history story**
    - History foregrounds human-readable operation summaries and actor/context.
    - Selecting an entry opens its diff or preview; technical IDs remain
      available as secondary details.
    - History handles long titles, many revisions, and narrow/touch layouts
      without clipping or losing pagination.
    - E2E/API proof: create human and agent revisions, inspect the timeline and
      diff, reload, and verify immutable operation grouping.

## Required gates

- Add focused behavior assertions before implementation for each changed flow.
- Run `just format`, `just test`, `just test-e2e`, and `just anti-slop` before
  calling the PR verified.
- For backend/API/data changes, run `just verify-behavior` against its isolated
  instance and retain the evidence artifact.
- Do not update tracked screenshots until format, frontend tests, and E2E pass;
  inspect every changed image and rerun the comparison without update mode.
- Report configured projects, pass/fail/skip counts, visual evidence inspected,
  and unverified mobile Safari or physical-device checks.
