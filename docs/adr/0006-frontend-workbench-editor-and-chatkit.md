# ADR 0006: Frontend workbench architecture, editor stability, and ChatKit lifecycle

## Status

Accepted

## Context

The Sangam web client pairs a multi-pane document workbench (CodeMirror 6 editor, Markdown preview, PDF viewer, evidence rails) with a persistent ChatKit assistant panel and strict accessibility and design-token constraints. Several browser, React, and third-party web-component behaviors require explicit structural invariants.

## Decision

1. **Persistent ChatKit panel and lifecycle (`ChatPanel.tsx`, `useChatKitScript.ts`, `WorkbenchView.tsx`)**
   - One workspace-scoped ChatKit thread persists across document tabs (`sangam.chat-thread.workspace`); the active document and selection are supplied as live context rather than switching threads per tab.
   - `WorkbenchView` keys `<DocumentLoader>` per document while keeping `<GroupInspector>` as an unkeyed sibling with `placeholderData: keepPreviousData` so tab switches and cache misses never unmount the inspector or its live ChatKit instance.
   - ChatKit options remain referentially stable across renders by reading live document, selection, and refresh callbacks through a ref.
   - `chatkit.ready` fires when the host initializes, before domain verification and iframe mounting finish. `ChatPanel` waits for usable mounted UI inside the shadow root, bounds CDN/frame load stalls with a retryable timeout instead of leaving a blank panel, and treats DOM presence as initial mount only (never as transport recovery after an error, since a failed frame keeps its composer/iframe mounted).
   - Explicit retry remounts the frame in `connecting` state; ordinary workspace chat clears a potentially obsolete stored thread ID while an explicit handoff preserves its source thread.
   - Only one effect review card is pending at a time; post-apply UI announcements read the stored effect result so resumed or retried effects announce identically (including one-time unlisted publication tokens).

2. **Query cache, document mutations, and session durability (`DocumentWorkspace.tsx`, `InboxSection.tsx`, `documentSessions.tsx`, `useSourceSelection.ts`, `CaptureDialog.tsx`, `FileExplorer.tsx`)**
   - Complete document index queries use `['documents', 'all']`, kept separate from paged explorer and search query keys because their response shapes differ.
   - Uploaded and captured images are stored in shared `/attachments/` and inserted as root-relative Markdown links so moving documents or folders never breaks image references.
   - Combined title and path updates execute sequentially, each building on the revision returned by the previous step, to avoid self-conflicting optimistic concurrency checks.
   - Asking chat about a text selection flushes unsaved draft content first so chat reads the exact selected passage.
   - A failed document rename leaves unsaved draft content eligible for autosave; only a server revision conflict halts autosave.
   - Drafts have no filesystem path, so renaming a draft updates its title through the session store.
   - `CaptureDialog` copies incoming `FileList` iterables immediately before resetting the `<input type="file">` element because a `FileList` is live and empties on reset.

3. **Editor, preview, PDF, and focus coordination (`MarkdownEditor.tsx`, `MarkdownPreview.tsx`, `PdfViewer.tsx`, `ActionMenu.tsx`, `TextSelectionToolbar.tsx`, `CommandPalette.tsx`, `markdownFormatting.ts`)**
   - `MarkdownPreview` memoizes `{ __html: safeHtml }` by content identity because replacing the prop object on unchanged HTML rewrites the DOM and destroys active native text selections; rendered block tokens carry source line numbers so search results and outline clicks scroll to the exact passage.
   - `MarkdownEditor` reserves `Mod-k` for the global command palette (`/` jumps straight to workspace search), runs queued cursor transactions after the mount's controlled-value effect, and trims leading/trailing whitespace before inserting CommonMark emphasis markers (`**word**`).
   - `PdfViewer` keys worker loading on `document_id` alone, restores saved scroll position after placeholders commit and when a hidden tab becomes visible (ignoring hidden-tab scroll events), and invalidates selection geometry only on actual scroll movement.
   - `ActionMenu` waits one animation frame after positioned layout commits before focusing so a hidden initial frame does not reject focus.
   - `TextSelectionToolbar` clears native selection ranges on Escape (since not all browsers collapse selection on Escape) so workspace pointer/key listeners do not reopen the toolbar, and prevents toolbar button mousedown from stealing editor selection focus.
   - On narrow viewports, citation navigation waits for the sidebar drawer and inspector sheet to close before focusing the destination passage so focus lands in the editor instead of returning to drawer triggers.

4. **Performance, cross-tab state, and UI system (`workspaceEvidenceState.ts`, `workspaceTree.ts`, `vite.config.ts`, `routes/__root.tsx`, `styles/*.css`, `check-ui-system.mjs`)**
   - Workspace evidence persistence acquires an exclusive cross-tab Web Lock and re-reads inside the critical section; failed reads or writes never mutate in-memory or durable state.
   - `buildModifiedSortComparator` pre-aggregates maximum `updated_at` per directory prefix in `O(N * D)` so tree sorting performs `O(1)` map lookups instead of `O(N)` scans per comparison.
   - CodeMirror and the full Mermaid renderer are split into optional lazy Vite chunks.
   - Primary navigation items pair visible labels with accessible names containing those labels so voice control matches what users see.
   - Stylesheet rules use `:where()` to exclude button-styled links without raising specificity, keep case-sensitive workspace paths in monospace, preserve full 44px touch targets on compact icon-only buttons, and enforce semantic UI tokens via `frontend/scripts/check-ui-system.mjs` (which tracks legacy structural class hooks in `ui-system-unstyled-classes.txt`).

## Consequences

- Refactors to editor mounting, ChatKit options, focus management, or TanStack Query keys must preserve these invariants and verify them with `just test-frontend` and `just test-e2e`.
