# Persistent project reviews

On Home, select a project and choose **Start review** in the **Reviews** section.
In the dialog, select the sources and drafts, enter what the review should look
for and choose a time limit. Interrupted work resumes after a server restart.
Starting the review authorizes
bounded reads of those documents and creation of a private findings document.
It does not authorize publication or applying edits.

The review identifies weak claims, counterexamples and missing experiments. Each
finding quotes an exact recorded source revision or explicitly states what evidence
is missing. Sangam validates quoted passages and calculates their locations. Model
interpretations remain suggestions. The review cannot search outside the selected
documents or run an experiment. Source text never grants authority.

The server owns execution. Closing a browser view leaves the assignment running.
Use **Steer**, **Pause**, **Resume** and **Stop** to control it. Steering is stored
before acknowledgement and consumed before finalization. A model request already
in progress can finish after pause or stop; its usage is recorded, but result writes
wait for resume or are suppressed after stop. An output already committed before a
control request remains visible. Stopped and exhausted assignments cannot resume.

Assignments share the chat admission limit. One server worker drains the persisted
queue. Context includes at most 40 selected documents, 30 pages per PDF, 20,000
characters per excerpt and 100,000 source characters in total. Truncation is explicit.
The assignment has a cumulative attempt and elapsed-time budget. Token counts are
provider-reported usage, not a monetary cap. Interrupted provider requests can have
unreported billable usage.

Before writing, the server persists the validated result. Restart recovery reuses
that result and the original document operation key. An interrupted model request
may run again, subject to the remaining limits. Current authorization and project
membership are checked again. Original run evidence and revisioned artifacts remain
available. Paused, stopped and exhausted work stays inactive. Resume policy also
applies to queued work left across a restart.

## Recover a stale proposal

In **Review changes**, a stale proposal shows a warning panel. Choose
**Compare edits** to compare the proposal's base revision with the current
document. **Request a revision** then offers **Generate fresh candidate**. This
starts a durable assignment with the current
target revision, exact reviewed wording, feedback and original cited sources.

The original proposal stays available. The fresh candidate appears as a separate
proposal and uses the existing exact-revision apply checks. Concurrent human edits
make the candidate stale instead of being overwritten. Resume a failed refresh to
generate against the new current revision. Refresh assignments remain visible on
the original proposal after reload.

## Return to a project

**Since your last visit** lists unresolved proposals, sources with newer
revisions, and recorded document revisions and applied proposals since the last
marked visit. Each item appears once. Rows open the pinned document revision or
review item; **Previous version** opens the revision seen at the last visit.
**Mark as seen** records the boundary for the next briefing. Reading or
refreshing the briefing does not move it. The first visit records a baseline
automatically, because there is no earlier boundary to compare against. Unresolved
proposals and updated sources stay listed until they are resolved. The latest 100
items are shown, with an explicit truncation notice. The panel is hidden when
nothing needs attention.

**Resume draft** uses the project's saved workbench layout, source pages and
conversation. Save the current workbench from the project view to update that
position. No generated summary is used to establish which changes occurred.

## API and proof

The administrator API provides project assignment creation/listing, assignment
inspection/control, proposal refresh/history, project briefings and visit recording.
Mutation requests require an `Idempotency-Key`. Reusing it with changed assignment
or control input fails with a conflict. Project membership does not grant access.

Run `just test`, `just test-e2e` and `just verify-behavior` for the standard gates.
`just verify-assignments` additionally uses the configured live provider against
temporary storage and exercises output recovery and controls through real process
restarts. It saves `artifacts/assignment-verification.json`. Browser provider checks
remain separate from deterministic CI fixtures.
