# Sangam UI and UX review: design-system recommendations

## Review scope

This review proposes design principles Sangam can adopt from established product design systems. It does not recommend copying another product's branding, logo, typography, or visual identity.

The references are used as vocabulary for interaction quality:

- **Linear:** dark-native surface hierarchy and restrained visual contrast.
- **Raycast:** command-first interaction and keyboard discoverability.
- **Notion:** document reading rhythm and content-first layout.
- **Mintlify:** clear information hierarchy for technical settings and operations.

Sangam should keep its own brand mark, document-server identity, API-first product model, and human-plus-agent collaboration model.

## Overall direction

Sangam has a credible dark document-workbench foundation. The next improvement should reduce competing controls and make the current work, current context, and next action obvious.

Use this hierarchy across the workbench, PDF reader, chat, and settings:

```text
Primary work
  The document, editor, preview, or PDF page.

Current context
  Document title, revision, selection, page, save state, and active pane.

Common actions
  Edit, preview, search, annotate, create, and review.

Secondary operations
  Publish, restore, move, delete, tokens, backups, and maintenance.
```

The work surface should remain visually dominant. Secondary operations should move into deliberate disclosure such as an overflow menu, command palette, settings category, or expandable panel.

## Recommendations by reference system

### 1. Adopt Linear's luminance hierarchy for the application shell

Sangam already uses much of this direction through Midnight:

- `#08090a` application background;
- `#0f1011` navigation rail;
- `#191a1b` raised surface;
- near-white primary text;
- indigo for active and focused states;
- translucent white borders.

Keep a small surface ladder instead of adding component-specific colors:

```css
--app-bg: #08090a;
--surface-sidebar: #0f1011;
--surface: #191a1b;
--surface-hover: #23252a;
--surface-active: #28282c;
```

Use surface brightness to communicate elevation. Reserve the accent for active navigation, focus, primary actions, selected state, and progress.

Apply this consistently to:

- editor groups;
- inspector panels;
- menus and popovers;
- settings panels;
- chat context;
- active document tabs.

Do not add Linear's marketing typography, logo treatment, or brand language.

### 2. Adopt Raycast's command-first interaction model

Sangam already has a command palette. Make it a first-class way to discover the long tail of actions.

Useful commands include:

- focus editor;
- focus search;
- switch to preview;
- switch inspector tab;
- insert internal link;
- open document history;
- create PDF annotation;
- publish document;
- restore revision;
- toggle sidebar or inspector.

Keep common actions visible in the interface. Put uncommon, repeatable actions in `Cmd/Ctrl + K`.

The command palette should make the visible interface smaller. Do not expose every backend capability as a command.

Show shortcuts beside commands where they teach a useful interaction. Hide keyboard-heavy hints on touch layouts.

### 3. Adopt Notion's document-first reading rhythm

The application shell can stay dense. The document surface should have more breathing room.

For Markdown preview and document editing:

- use a readable content width;
- increase paragraph line height;
- keep headings distinct;
- reduce metadata around the document;
- avoid treating every document property as a card;
- preserve a quiet reading surface inside the dark shell.

A starting direction is:

```css
.document-content {
  max-width: 760px;
  margin-inline: auto;
  line-height: 1.6;
}
```

Tune the width for editing behavior, but preserve the principle: the document should not feel like another dashboard panel.

### 4. Adopt Mintlify's hierarchy for settings and operations

Use a clear sequence for technical settings:

```text
Section title
Short explanation
Primary action
Advanced details
```

Apply it to:

- agent token creation;
- publication settings;
- reconciliation conflicts;
- backup verification;
- PDF annotation details.

For example:

```text
Create an agent token
Give an identified agent limited access to this workspace.

Agent name
Capabilities
Path restrictions
Expiration
Create token
```

Do not give capability warnings, token prefixes, scope previews, and advanced restrictions equal visual weight. Keep advanced settings behind disclosure when they are not needed for the common task.

### 5. Adopt Linear's intermediate font weights

Use a small weight vocabulary:

```css
--weight-body: 400;
--weight-control: 500;
--weight-emphasis: 590;
```

Use `400` for reading text, `500` for controls and navigation, and `590` for titles, active labels, and important states. Avoid `700` in the application shell unless strong emphasis is required.

This recommendation supports the existing 11px, 12px, 13px, and 14px semantic type scale. It does not replace that scale.

### 6. Adopt a stronger active-state system

Do not rely on color alone. Combine at least two signals:

- surface contrast;
- border or inset line;
- text weight;
- selected-state semantics.

Use the same pattern for:

- active inspector tab;
- active sidebar item;
- active editor group;
- selected PDF annotation;
- current chat context;
- selected document tab.

The active state should remain clear in Midnight, River, Parchment, and Cobalt.

## Priority product recommendations

### P0: Make context explicit in chat

The chat context should show:

```text
Context
Research brief · revision 8f2a…c41d
Selected text · 428 characters
```

When the active document changes, add a visible event to the persistent thread:

```text
Context changed to Research brief · revision …
```

This prevents the user from guessing which document grounds a persistent chat thread.

### P0: Reduce document-header chrome

Keep the primary document header focused on:

- location;
- title;
- save state;
- one primary action.

Move materialization, internal-link insertion, and less frequent operations into an overflow menu or a context-sensitive editor toolbar.

The user should reach the editing surface without passing through a storage control panel.

### P1: Collapse PDF research on narrow screens

At narrow widths, keep page navigation and zoom visible. Move annotation search, annotation creation, and annotation history into a collapsible research panel or bottom sheet.

Preferred structure:

```text
PDF toolbar
PDF page
[Annotations · 3]
```

The PDF page should remain the dominant surface on a phone-sized viewport.

### P1: Increase touch targets selectively

Keep the 32px desktop control height. At mobile breakpoints, increase only frequent touch controls to 40–44px:

- PDF page navigation;
- zoom buttons;
- annotation actions;
- sidebar reveal;
- close buttons.

Do not increase every desktop control. This is a touch-layout adjustment, not a global density change.

### P1: Make the empty-state first action unambiguous

Use Markdown as the direct default action:

```text
Your workspace is empty
Create a Markdown document or import a PDF to begin.

[Create Markdown document] [Import PDF]
```

Keep HTML creation available as a secondary format choice.

### P2: Add result feedback to outline navigation

When an outline heading moves the editor:

- highlight the destination line briefly;
- announce `Jumped to line N` through a live region;
- preserve the selected heading state in the outline.

This makes the interaction clear for keyboard and assistive-technology users.

## Recommendations to avoid

Do not adopt these patterns from the reference systems:

- oversized marketing headlines inside the workbench;
- decorative gradients or glow effects;
- branded colors from Linear, Raycast, Notion, or Mintlify;
- copied logos or wordmarks;
- pill-shaped treatment for every control;
- heavy shadows that compete with the document;
- a command palette that duplicates every visible action.

## Acceptance checklist

A design change based on this review is ready when:

- the primary work surface is clear within two seconds;
- current document and revision context are visible where agents operate;
- common actions are available without command discovery;
- secondary operations are available without crowding the work surface;
- active states use more than color alone;
- the document remains readable at desktop and narrow widths;
- PDF reading remains dominant on mobile;
- frequent mobile controls meet the chosen touch target size;
- focus returns after menus, dialogs, and mobile sidebars close;
- the UI remains coherent in every supported theme;
- browser-level screenshots or geometry checks cover changed layouts.

## Suggested implementation sequence

1. Strengthen chat context and context-change events.
2. Reduce document-header and materialization chrome.
3. Collapse the narrow PDF research panel by default.
4. Add selective mobile touch-target sizing.
5. Add outline navigation feedback and live announcements.
6. Extend command-palette coverage for repeatable secondary actions.
7. Verify all changes at 320px, 375px, 768px, 900px, and 1100px.

## Final position

Sangam should adopt the interaction lessons of Linear, Raycast, Notion, and Mintlify without becoming a copy of any of them.

Keep the current dark-native shell. Make the document quieter and more readable. Make chat context impossible to miss. Put long-tail operations behind deliberate disclosure. Let the command palette reduce visible clutter instead of adding another layer of it.
