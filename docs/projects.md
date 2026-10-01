# Projects and ongoing work

Project Home also supports [persistent project reviews](project-assignments.md),
recorded return briefings and controls for server-owned assignments.

A project has a purpose brief and references to existing documents, conversations
and PDF annotations. A document can belong to several projects without a copy or
a path change. Deleting a project keeps its documents and conversations.

## Continue a project

Choose a project in Home. Home remembers this selection in the browser. The picker
stays available when the selected project is empty. **New Project** creates an
ordinary Markdown purpose brief. The brief is separate from the working draft.

Create a document or import a PDF from Home to attach it to the selected project.
Use **Manage project** to attach existing documents and choose their roles.
Supported roles are Source, Draft, Note, Decision and Output. Choose the active
draft separately from the purpose brief.

Open the documents you want to work with, arrange their splits, then return to
the project and choose **Snapshot current layout**. The snapshot includes only
live project members. It records the selected tab and split arrangement. It also
records the current PDF pages and the selected attached conversation. **Resume**
restores this context. Project document URLs carry the project ID so reloading a
draft also restores its source pages. Passage URLs include the page and annotation.

Attach a conversation from the project's conversation picker. Only conversations
owned by the current human are listed. **Use on resume** chooses the conversation
to restore. **Start a conversation** opens workspace chat. Return to the project
to attach the conversation after it has been created.

To collect a passage, attach its PDF as a source, create an annotation in the PDF
reader, then select it under **Collected passages**. Opening a collected passage
opens the correct PDF page and selects its annotation. Detaching a source also
detaches its collected passages from the project. It does not delete annotations.

## Home attention

Home shows a body excerpt from the active draft and groups documents by role.
The purpose brief is not listed as a working draft. Empty categories are hidden.
The default project is chosen by the latest document work, rather than by a
project name or description edit. An explicit project selection takes precedence.

The **Since your last visit** panel includes proposals targeting member documents or attached
conversations. Workspace attention shows the other reviewable proposals, including
when no project is selected. Pending proposals and stale proposals have separate
labels. A stale proposal needs a fresh target revision before it can be applied.

Attaching a source pins its current revision in the membership. If its head changes,
Home reports a newer source revision. Inspect the source, then choose **Mark source
reviewed** in project management to pin the current head. These counts compare
revisions. They do not claim to count citations or passages used in a draft.

## API contract

Project routes under `/api/v1/projects` require the trusted human administrator.
Scoped agent tokens cannot read or manage projects. Project membership does not
grant access to a document or override conversation ownership.

- `POST /projects` creates a project and its optional brief in one transaction.
- `GET /projects` returns summaries, including `version`, `active_document_id` and
  `last_worked_at`.
- `GET /projects/{project_id}` returns live references and a validated layout.
- `PATCH /projects/{project_id}` accepts `expected_version`. A mismatched version
  returns 409. Clients should refetch and preserve the user's unsaved input.
- Document membership updates also accept the project's `expected_version`.
- Omitted update fields are preserved. Explicit null clears nullable fields.
- `GET /projects/available-threads` lists the current human's available conversations.
- Document memberships expose `source_revision_id`, `current_revision_id`,
  `source_updated`, `excerpt` and `updated_at`.
- All project mutations honor `Idempotency-Key`. The key shares the existing
  actor-scoped mutation namespace. Reusing a key with a different operation or
  payload returns 409. An identical retry returns the committed response and
  does not repeat its accepted audit event. Deletion retries return 204.
  Replay reads recheck reference availability. A removed passage or conversation
  returns 404, and deleted references are removed from project response snapshots.

Accepted project audits, replay records and project changes commit together. If
audit insertion fails, creation also rolls back its brief. Briefs start as pathless
Markdown documents so creation has no uncommitted filesystem side effects.

Layout JSON uses schema version 1 and the workbench's `root`, `activeGroupId` and
`recentlyClosed` fields. Group tabs must be live project members. A group's selected
tab must belong to that group. Splits retain direction and ratio. Invalid JSON or
an invalid selection returns 422. Reads remove deleted or detached tabs and clear
unavailable brief, draft and conversation references. Passages from trashed parent
documents are excluded.

Migration `024_projects.sql` is the consolidated project migration for staging.
It replaces the unmerged project candidate's contract. A database that already
applied a different candidate 024 must not be treated as a supported upgrade.

## Verification

Use `just test-projects` for the failure-first API cases and scale checks.
Use `just verify-projects` for live HTTP requests against a disposable server,
with SQLite checks for audit atomicity and replay. The recipe saves `projects.json`
and `doctor.json` under `artifacts/verify-sangam/<run-id>/`.

Run browser checks on an isolated port:

```sh
SANGAM_E2E_PORT=8871 just test-e2e 'e2e/projects.spec.ts'
```

The spec runs desktop Chromium, narrow fine-pointer Chromium, true touch-mobile
Chromium and iPhone WebKit. It includes compact-dialog breakpoint and landscape
checks. Physical phones and live model responses need a separate run.

Ordinary browser runs do not overwrite the tracked project PNGs. After formatting,
fast tests and browser checks pass, capture review artifacts explicitly:

```sh
SANGAM_CAPTURE_PROJECTS=1 SANGAM_E2E_PORT=8871 just test-e2e 'e2e/capture-projects-screenshots.spec.ts'
```

Capture output goes to Playwright's artifact directory.
