# Sangam UX and frontend design review

## Executive view

Sangam has a serious product underneath it. The problem is that the interface currently presents too much of that seriousness as small labels, dense rails, and hidden actions.

The next design pass should make Sangam feel like a focused tool that gets out of the way. The target is not a generic dashboard and not a copy of another product. It is a dark-native, keyboard-first document workspace with strong hierarchy, fast feedback, and enough restraint that the document remains the main object.

A useful taste reference is the best work around T3 Code, Linear, Raycast, and modern developer tools:

- dark surfaces with very small luminance steps;
- one clear accent color;
- quiet borders instead of decorative cards;
- compact but readable controls;
- direct actions for common work;
- command surfaces for the long tail;
- motion used to explain state, not to decorate it.

The current Sangam UI has some of this grammar. It needs a sharper point of view and better prioritization.

## The central UX problem

Sangam currently optimizes for exposing capability. The UI should optimize for helping the user complete the next document task.

The main workspace contains editing, preview, history, metadata, publishing, PDF research, agent access, chat, imports, reconciliation, backups, and trash. These are valuable capabilities, but they do not have equal importance in the moment.

The product needs three layers:

1. **Work surface.** The document, editor, preview, or PDF.
2. **Context.** Save state, current revision, selected text, citations, and document metadata.
3. **Operations.** Publishing, restore, move, duplicate, delete, agent configuration, backups, and maintenance.

The current design often puts all three layers next to each other. That makes the interface feel dense even when the code is well structured.

## Target visual direction

### Use a dark-native application shell

The current themes are useful, but `river` is visually warm and `parchment` is even warmer. That makes the application resemble a document notebook more than a modern technical workspace.

Make `midnight` the default application theme, then tune it toward a restrained near-black system:

```text
Application background  #08090a
Sidebar surface        #0f1011
Raised surface         #191a1b
Hover surface          #23252a
Primary text           #f7f8f8
Secondary text         #d0d6e0
Muted text             #8a8f98
Subtle text            #62666d
Border                 rgba(255,255,255,0.08)
Subtle border          rgba(255,255,255,0.05)
Accent                 #7170ff
Accent surface         rgba(113,112,255,0.16)
Success                #27a644
Danger                 #ef6b73
```

Use the accent only for:

- active navigation;
- focused controls;
- primary actions;
- selected document state;
- success or progress where green is more appropriate.

Do not use accent color as general decoration. If everything is highlighted, nothing is highlighted.

### Keep warm themes as document themes

`parchment` can remain as an optional reading theme. It should not define the product's main identity.

A useful split is:

- **Application theme:** dark, precise, technical.
- **Document theme:** user preference for reading and editing.
- **Publication theme:** controlled by the published document, not by the workspace shell.

This makes the dark shell feel intentional without taking away the product's document-oriented character.

### Change the type hierarchy

The current UI system defines 10px metadata and 11px labels, then uses them on interactive elements. That contradicts `docs/UI_SYSTEM.md` and makes the interface harder to scan.

Use this hierarchy:

| Role | Size | Use |
| --- | ---: | --- |
| Body | 14px | Primary UI values and descriptions |
| Control | 13px | Buttons, links, tabs, menus, tree rows |
| Label | 12px | Form labels and section labels |
| Metadata | 11px | Timestamps, IDs, secondary descriptions |
| Editor | 14px | Markdown and code content |

The important rule is simple: interactive text must be 13px or larger in the main application shell. Dense interfaces do not need microscopic text. They need fewer things competing for attention.

Use Inter or a system sans for the application. Keep a serif face for rendered documents only. Keep monospace for paths, revisions, operations, and code.

## Workbench recommendations

### Make the document the obvious center

The current document header exposes path, title, category, tags, actor, type, trust state, timestamp, and save state. See `frontend/src/components/document/DocumentWorkspace.tsx`.

Keep the main header to:

- path or location;
- document title;
- save state;
- one primary action.

Move the rest into the inspector or an information popover. The title should be the strongest visual element. The editor should begin sooner.

### Replace the mode switch with a focused control

Edit, Split, and Preview are useful, but the current switch competes with document actions and the internal-link toolbar.

Use:

```text
[Edit] [Split] [Preview]                         [···]
```

The selected state should be obvious through surface contrast and an accent line. Add `aria-pressed` or use a radiogroup so assistive technology can identify the selected mode.

### Improve split view

Split view is a good feature, but each pane repeats too much chrome.

In split view:

- shorten each pane header to title and save state;
- hide secondary badges;
- move layout operations into the overflow menu;
- show a stronger active-pane border;
- preserve the document surface as the largest area;
- keep a minimum readable editor width before allowing another split.

The active pane should be clear without relying on a nearly invisible one-pixel ring.

### Make the left rail readable

The file tree, Files/Search switch, footer navigation, and context menu currently use 10px and 11px text in several places.

Use 13px for interactive rows. Give tree items at least 32px of height. Keep descriptions and timestamps at 11px.

The rail can stay dense. It should not feel cramped.

### Show a real empty state

`No documents yet` is not enough. The empty state should tell the user what Sangam is for and offer the first action.

Use:

```text
Your workspace is empty
Create a Markdown document or import a PDF to begin.

[New document]  [Import PDF]
```

Keep the command palette shortcut visible as a secondary hint, not as the only route.

## Chat and agent UX

### Make context impossible to miss

The chat thread persists across documents. That can work, but the current `Workspace chat` framing is too broad.

Show the active context above the composer:

```text
Context
Research brief · revision 8f2a…c41d
Selected text · 428 characters
```

When the document changes, add a visible context event to the thread. The user should never need to remember which document the assistant is using.

### Keep proposals in the document workflow

The proposal model is one of Sangam's strongest product decisions. Keep it.

Improve its presentation by making the flow explicit:

```text
Assistant suggestion
↓
Review diff
↓
Apply to editor or reject
```

Use a compact proposal card in chat, then open the full diff in the document inspector. Do not make the chat panel carry a second full document workspace.

### Make external effects feel different

Publishing, deleting, restoring, and issuing agent tokens should not look like ordinary buttons.

Use stronger confirmation cards with:

- the exact object affected;
- the access scope or destructive result;
- the current document revision;
- one clear primary action;
- a quieter cancel action.

The existing publish confirmation is moving in this direction. Apply the same model consistently.

## PDF research UX

The PDF reader should prioritize reading over annotation controls.

At narrow widths:

- keep page navigation and zoom visible;
- move copy-link and annotation creation into an overflow menu;
- replace long labels with icons plus accessible names;
- show the annotation rail as a bottom sheet or tabbed panel;
- never let the toolbar force horizontal scrolling.

Area highlighting should not show a preview before the first pointer press. The current artificial `{ x: 0, y: 0 }` start point creates a misleading preview.

## Settings information architecture

Settings currently puts appearance, agent access, chat models, workbench, organization, and maintenance into one long page.

Use two groups:

### Workspace

- Appearance
- Workbench
- Files and organization

### Operations

- Agent access
- Chat models
- Maintenance

Use progressive disclosure for advanced agent capabilities. A user who wants to create a read-only token should not need to parse every sensitive capability at once.

Keep the browser-versus-workspace scope badge. That is a good idea. Increase its explanatory value with a short tooltip or helper text:

```text
This browser
Only affects your local UI preferences.
```

## Navigation and landmarks

The root layout currently renders a `<main>` around the route outlet while utility routes also render `<main>`. Keep one main landmark per document.

Also separate action-menu and dialog semantics:

- action-only popovers should use `role="menu"` and `menuitem` behavior;
- document actions containing forms should use a real dialog pattern;
- restore focus to the trigger after closing;
- trap focus only for the dialog pattern;
- do not mix `role="dialog"` with `role="menuitem"` children.

These changes improve both usability and the sense that the application is dependable.

## Motion and interaction taste

Use motion to answer one question: what changed?

Good uses:

- sidebar opening and closing;
- active pane changes;
- save-state transitions;
- command palette entry and exit;
- proposal acceptance.

Avoid:

- decorative floating elements;
- large spring animations in the editor;
- animated gradients;
- motion on every hover.

Respect `prefers-reduced-motion`. Keep transitions short, around 120–180ms, and use opacity or a small translation rather than a large scale effect.

## What to build first

### Phase 1: establish taste

1. Make the dark-native theme the default.
2. Tune the midnight palette toward near-black surfaces and one violet accent.
3. Raise all interactive text to the control size.
4. Remove secondary header badges from the main document surface.
5. Strengthen active states and focus rings.

### Phase 2: improve task flow

1. Add a useful empty workspace state.
2. Add explicit document and revision context to chat.
3. Make outline entries navigate or render them as non-interactive text.
4. Split ActionMenu into menu and dialog patterns.
5. Restore focus after menu actions.

### Phase 3: harden narrow layouts

1. Test 320px, 375px, 768px, 859px, 900px, and 1100px widths.
2. Redesign the PDF toolbar for narrow screens.
3. Collapse settings grids based on panel width, not only viewport width.
4. Verify split-editor minimum widths and overflow ownership.
5. Add browser-level geometry and accessibility checks.

## Design acceptance checklist

A design change is ready when:

- the primary task is obvious within two seconds;
- interactive text is readable at the documented minimum;
- the active document, pane, tab, and chat context are clear;
- no common action depends on guessing an icon's meaning;
- destructive and external actions show exact consequences;
- keyboard focus returns to the control that opened a surface;
- the layout works at 320px without horizontal page scrolling;
- the UI remains coherent in every supported theme;
- the change has a screenshot or browser-level verification where layout is involved.

## Final position

Sangam does not need more visual features. It needs stronger editing decisions.

Make the shell darker, the type larger, the surfaces quieter, the title more important, and the long tail of operations less visible until needed. Keep the document and the reviewable agent proposal at the center.

That is the difference between a capable internal dashboard and a product people want to use every day.
