# Persistent project reviews

Persistent project reviews run server-owned review assignments over a selected
set of project documents. They continue running if you close the browser and
can resume across server restarts.

## Start and control a review

On Home, select a project and choose **Start review** in the **Reviews**
section. Pick the sources and drafts to include, state what the review should
examine, and choose a time limit.

Starting a review grants bounded read access to the selected documents and
permission to create one private findings document. It never authorizes
publishing or editing existing documents.

The review looks for weak claims, counterexamples, and missing evidence. Every
finding either quotes an exact recorded source revision or states what evidence
is missing. Sangam verifies quoted passages and computes their exact locations.
Model interpretations remain suggestions. A review cannot search outside the
selected documents or run external tools, and source text never grants
authority.

### Execution controls

- **Steer:** Stores steering guidance before acknowledgement and applies it
  before finalization.
- **Pause and Resume:** Pauses queued or in-progress work until resumed.
- **Stop:** Permanently stops the assignment.

An in-flight model call can finish after a pause or stop request. Its token
usage is still recorded, while output writes wait for resume or are suppressed
after stop. Output already committed before a control request remains visible.
Stopped and budget-exhausted assignments cannot be resumed.

### Bounds and restart recovery

Assignments share the chat concurrency admission limit, and one server worker
drains the persisted queue.

| Limit | Bound |
| --- | --- |
| Selected documents | Up to 40 documents |
| PDF pages per source | Up to 30 pages |
| Excerpt length | Up to 20,000 characters per excerpt |
| Total source text | Up to 100,000 characters (truncation is explicit) |
| Attempts | Default 3, allowed range 1 to 10 for project reviews |
| Elapsed time | Default 180 seconds, allowed range 10 to 600 for project reviews |

Token counts reflect provider-reported usage, not a billing cap. Interrupted
provider requests may incur unreported provider usage.

Before creating a findings document, the server persists the validated result
and its reserved document operation key. After a restart, recovery reuses that
stored result and key rather than duplicating writes. An interrupted model call
may rerun within its remaining budget after rechecking current authorization and
project membership. Sangam retains run evidence and revisioned artifacts.
Paused, stopped, and exhausted assignments stay inactive. On restart, queued
or interrupted work with `resume_after_restart=false` pauses. An interrupted
attempt counts toward the elapsed-time budget.

## Recover a stale proposal

When a proposal in **Review changes** becomes stale because the target document
changed, its warning panel offers two steps:

1. **Compare edits:** Diff the proposal's base revision against the current
   document.
2. **Request a revision -> Generate fresh candidate:** Starts a durable
   assignment using the current target revision, your exact reviewed wording,
   your feedback, and the original cited sources.

The original proposal stays available, and the refresh assignment stays visible
on it after page reload. The fresh candidate arrives as a separate proposal with
standard exact-revision apply checks. If a human edits the document again before
you apply it, the candidate becomes stale rather than overwriting human edits. A
failed refresh can be resumed against the latest revision.

## Return to a project

**Since your last visit** shows counts of pending and stale proposals and a
list of sources with newer revisions. It also shows recorded document changes
and applied proposals since your last marked visit. Change rows link to the
pinned revision or review card. **Previous version** opens the revision
recorded at your last visit.

- **Mark as seen:** Advances the briefing boundary. Simply viewing or refreshing
  the panel does not move the boundary.
- **First visit:** Sets an automatic baseline because no prior boundary exists.
- **Unresolved items:** Unresolved proposals and updated sources stay listed
  until resolved.
- **Bounds and quiet state:** The API returns up to 100 briefing changes per
  request and flags truncation. The panel stays hidden when there is nothing
  to review.

**Resume draft** restores the project's saved workbench layout, source pages,
and attached conversation. Use **Snapshot current layout** from the project
view to update that layout. Return briefings rely on recorded revisions
and events, never on generated summaries.

## API and verification

The administrator API exposes these routes under `/api/v1`.

| Route | Methods |
| --- | --- |
| `/projects/{project_id}/assignments` | `GET`, `POST` |
| `/documents/{document_id}/assignments` | `GET`, `POST` |
| `/assignments/{assignment_id}` | `GET` |
| `/assignments/{assignment_id}/control` | `POST` |
| `/chat/proposals/{proposal_id}/refresh` | `GET`, `POST` |
| `/projects/{project_id}/briefing` | `GET` |
| `/projects/{project_id}/visits` | `POST` |

Mutation requests require an `Idempotency-Key`. Reusing a key with changed
arguments returns HTTP `409`. Project membership never bypasses document
authorization.

Standard verification gates are `just test`, `just test-e2e`, and
`just verify-behavior`. To prove live provider execution, steering, controls,
and real restart recovery against temporary storage, run:

```sh
just verify-assignments
```

This writes evidence to `artifacts/assignment-verification.json`. Browser
fixtures use a separate deterministic provider.
