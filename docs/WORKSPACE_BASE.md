# Workspace base enhancements

This increment builds on the completed Phase 1 document core without bypassing its service layer.

## Organization

- Materialized document paths automatically register their full folder hierarchy.
- Empty folders can be created explicitly and remain available as workspace groupings.
- Documents and folders support one category plus multiple reusable colored tags.
- Metadata uses optimistic `metadata_version` checks and actor-attributed immutable events.
- SQLite FTS5 searches current title, path, Markdown content, tags, and category.
- The CLI exposes the same index through `sangam search "query"`.
- The left navigation presents nested folders, unmaterialized drafts, search, and tag filters.

## Customizable workspace

- Both sidebars can be resized by dragging their separators.
- Both sidebars can be collapsed independently.
- Panel widths, visibility, and the selected theme persist in browser-local preferences.
- Built-in themes: River, Midnight, Parchment, and Cobalt.
- Workspace Settings provides theme selection, panel controls, tag creation, and folder category/tag editing.
- The right document sidebar edits document category/tags and retains revision history controls.

## Theme previews

### River

![River theme](./assets/workspace-river.png)

### Midnight

![Midnight theme](./assets/workspace-midnight.png)

### Parchment

![Parchment theme](./assets/workspace-parchment.png)

### Settings in Cobalt

![Workspace settings in Cobalt](./assets/workspace-settings.png)

These enhancements establish part of the Phase 2 workspace experience. They do not claim completion of Phase 2 features such as revision diffs, backup automation, rendered Markdown preview, or a reconciliation-conflict UI.
