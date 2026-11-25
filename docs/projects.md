# Projects and ongoing work

A project groups a Markdown purpose brief together with references to existing
documents, chat conversations, collected PDF passages, and a saved workbench
layout. One document can belong to several projects without copying files or
changing paths. Deleting a project keeps its underlying documents and
conversations.

Project Home also supports [persistent project reviews](project-assignments.md),
return briefings, and controls for server-owned review assignments.

## Work inside a project

Choose a project on Home. The browser remembers your selection, and the project
picker stays available even when the selected project is empty. **New Project**
creates an ordinary Markdown purpose brief separate from the working draft.

- **Attach documents and roles:** Creating a document or importing a PDF from
  Home attaches it to the selected project. Use **Manage project** to attach
  existing documents and assign their role (`Source`, `Draft`, `Note`,
  `Decision`, or `Output`). Select the active working draft separately from the
  purpose brief.
- **Save and resume workbench layouts:** Open the documents you want, arrange
  split groups, then return to Home and choose **Snapshot current layout**. The
  snapshot records live project members, selected tabs, split ratios, active PDF
  pages, and the selected attached conversation. **Resume** restores that
  layout. Project document URLs carry the project ID so reloading a draft also
  restores its source pages. Collected-passage URLs also carry the PDF page
  and annotation.
- **Attach conversations:** Use the project's conversation picker to attach
  conversations owned by the current human administrator. **Use on resume**
  marks the conversation restored by **Resume**. **Start a conversation** opens
  workspace chat; return to the project to attach it after creation.
- **Collect PDF passages:** Attach a PDF as a `Source`, create an annotation in
  the PDF reader, and select it under **Collected passages**. Opening a passage
  jumps to the exact PDF page and annotation. Detaching a source removes its
  collected passages from the project without deleting the underlying
  annotations.

## Home attention

Home displays a body excerpt of the active draft and groups member documents by
role while hiding empty categories and keeping the purpose brief separate from
working drafts. Without an explicit selection, Home chooses the project with the
most recent document work rather than the latest project metadata edit.

- **Since your last visit:** Shows proposals targeting project documents or
  attached conversations, plus sources with newer revisions. Other reviewable
  proposals appear under workspace attention (including when no project is
  selected). Pending and stale proposals are labeled separately; a stale
  proposal needs a fresh base revision before it can be applied.
- **Source revision checks:** Attaching a source pins its current revision in
  the membership record. When the source's head changes, Home flags a newer
  source revision. After inspecting the update, choose **Mark source reviewed**
  in project management to pin the new head. These indicators compare document
  revisions and do not claim to count citations inside a draft.

## API contract

All routes under `/api/v1/projects` require the trusted human administrator.
Scoped agent tokens cannot read or manage projects. Project membership does not
grant document access or override conversation ownership.

- `POST /api/v1/projects`: Creates a project and its optional purpose brief in
  one transaction. Briefs start as pathless Markdown documents so creation has
  no uncommitted filesystem side effects.
- `GET /api/v1/projects`: Returns project summaries including `version`,
  `active_document_id`, and `last_worked_at`.
- `GET /api/v1/projects/{project_id}`: Returns live references and a validated
  layout. Reads prune deleted or detached tabs and clear unavailable brief,
  draft, conversation, and trashed-PDF passage references.
- `PATCH /api/v1/projects/{project_id}` and document-membership updates: Accept
  `expected_version`. Mismatched versions return HTTP `409` so clients can
  refetch while keeping unsaved user input. Omitted fields stay unchanged;
  explicit `null` clears nullable fields.
- `GET /api/v1/projects/available-threads`: Lists the administrator's available
  conversations.
- Document memberships expose `source_revision_id`, `current_revision_id`,
  `source_updated`, `excerpt`, and `updated_at`.

### Idempotency and layout validation

Project mutations accept an optional `Idempotency-Key` in the actor-scoped
namespace. Send your own stable key for safe retries. The server generates a
key when the header is absent. Reusing a key with a different operation or payload returns HTTP
`409`. Identical retries return the committed response without repeating the
accepted audit event (deletion retries return `204`). Replay reads recheck reference availability. A removed document membership,
passage, or conversation returns `404` when it is the replayed resource.
Unavailable references are omitted from project response snapshots. Accepted audit rows,
replay records, and project changes commit atomically; if audit insertion fails,
project creation rolls back its brief too.

Layout JSON uses schema version `1` with the workbench's `root`,
`activeGroupId`, and `recentlyClosed` fields. Every group tab must be a live
project member, every group's selected tab must belong to that group, and splits
preserve direction and ratio. Invalid JSON or invalid tab selections return HTTP
`422`. Reads clear `recentlyClosed` and select the next available tab if the
saved selection has disappeared.

An old staging database that applied a different migration `024` needs a
fresh database or a backup from before that migration. The migrator identifies
applied migrations by version.

## Verification

- `just test-projects`: Failure-first API cases and scale checks.
- `just verify-projects`: Live HTTP proof against an isolated server with SQLite
  checks for audit atomicity and replay. Saves `projects.json` and `doctor.json`
  under `artifacts/verify-sangam/<run-id>/`.
- Browser suite on an isolated port (desktop Chromium, narrow Chromium, touch
  Chromium, and iPhone WebKit). The spec includes compact-dialog breakpoint
  and landscape checks. Physical devices and live inference need separate runs.

  ```sh
  SANGAM_E2E_PORT=8871 just test-e2e 'e2e/projects.spec.ts'
  ```

Ordinary browser runs do not overwrite tracked PNG assets. To capture project
review screenshots into Playwright's artifact directory after formatting,
fast tests, and browser checks pass.

```sh
SANGAM_CAPTURE_PROJECTS=1 SANGAM_E2E_PORT=8871 just test-e2e 'e2e/capture-projects-screenshots.spec.ts'
```
