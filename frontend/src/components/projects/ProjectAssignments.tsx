import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api, type Assignment, type ProjectDetail } from '../../api'
import { citationHref } from '../../citationNavigation'
import { StateMessage } from '../ui/StateMessage'

export function AssignmentStatus({ assignment }: { assignment: Assignment }) {
  const client = useQueryClient()
  const [steering, setSteering] = useState('')
  const [key, setKey] = useState(() => crypto.randomUUID())
  const control = useMutation({
    mutationFn: (action: 'steer' | 'pause' | 'resume' | 'stop') =>
      api.controlAssignment(assignment.assignment_id, action, action === 'steer' ? steering : '', key),
    onSuccess: async () => {
      setKey(crypto.randomUUID())
      setSteering('')
      await client.invalidateQueries({ queryKey: ['assignments'] })
      await client.invalidateQueries({ queryKey: ['assignment'] })
    },
  })
  const terminal = assignment.status === 'stopped' || assignment.status === 'exhausted'
  return (
    <article className="project-doc-main">
      <p>{assignment.instructions}</p>
      <span className="scope-badge">{assignment.status}</span>
      <p className="small-muted">
        {assignment.steps} / {assignment.max_steps} attempts · {Math.round(assignment.elapsed_seconds)} /{' '}
        {assignment.max_seconds} seconds · {assignment.input_tokens + assignment.output_tokens} recorded
        tokens
      </p>
      {assignment.error && (
        <StateMessage
          compact
          kind="error"
          title="Assignment needs attention"
          description={assignment.error}
        />
      )}
      <div className="project-detail-actions">
        {assignment.artifact_ids.map((id) => (
          <Link key={id} to="/documents/$documentId" params={{ documentId: id }}>
            Open findings
          </Link>
        ))}
        {assignment.proposal_ids.length > 0 && <Link to="/review">Review fresh candidate</Link>}
        {!terminal && (
          <>
            {(assignment.status === 'running' || assignment.status === 'queued') && (
              <button
                className="secondary-action"
                disabled={control.isPending}
                onClick={() => control.mutate('pause')}
              >
                Pause
              </button>
            )}
            {(assignment.status === 'paused' || assignment.status === 'failed') && (
              <button
                className="secondary-action"
                disabled={control.isPending}
                onClick={() => control.mutate('resume')}
              >
                Resume
              </button>
            )}
            <button
              className="secondary-action"
              disabled={control.isPending}
              onClick={() => control.mutate('stop')}
            >
              Stop
            </button>
          </>
        )}
      </div>
      {!terminal && (
        <form
          className="project-home-toolbar"
          onSubmit={(event) => {
            event.preventDefault()
            control.mutate('steer')
          }}
        >
          <label className="project-modal-field">
            Steering instructions
            <input value={steering} maxLength={4000} onChange={(event) => setSteering(event.target.value)} />
          </label>
          <button className="secondary-action" disabled={!steering.trim() || control.isPending}>
            Steer
          </button>
        </form>
      )}
      {control.isError && (
        <StateMessage
          compact
          kind="error"
          title="Control was not confirmed"
          description={control.error.message}
        />
      )}
    </article>
  )
}

export function ProjectAssignments({ project }: { project: ProjectDetail }) {
  const client = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [instructions, setInstructions] = useState(
    'Find the weakest supported claim, strongest counterexample, and missing experiment.',
  )
  const [selected, setSelected] = useState(() =>
    project.documents.filter((doc) => doc.role !== 'output').map((doc) => doc.document_id),
  )
  const [seconds, setSeconds] = useState(180)
  const [resumeAfterRestart, setResumeAfterRestart] = useState(true)
  const [key, setKey] = useState(() => crypto.randomUUID())
  const assignments = useQuery({
    queryKey: ['assignments', project.project_id],
    queryFn: () => api.listAssignments(project.project_id),
    refetchInterval: 1500,
  })
  const briefing = useQuery({
    queryKey: ['project-briefing', project.project_id],
    queryFn: () => api.projectBriefing(project.project_id),
  })
  const visit = useMutation({
    mutationFn: () => api.recordProjectVisit(project.project_id, key),
    onSuccess: async () => {
      setKey(crypto.randomUUID())
      await client.invalidateQueries({ queryKey: ['project-briefing', project.project_id] })
    },
  })
  const start = useMutation({
    mutationFn: () =>
      api.createAssignment(
        project.project_id,
        {
          instructions,
          document_ids: selected,
          max_steps: 3,
          max_seconds: seconds,
          resume_after_restart: resumeAfterRestart,
        },
        key,
      ),
    onSuccess: async () => {
      setKey(crypto.randomUUID())
      setEditing(false)
      await client.invalidateQueries({ queryKey: ['assignments', project.project_id] })
    },
  })
  return (
    <>
      <section className="project-home-attention" aria-label="Since you last worked here">
        <h2>Since you last worked here</h2>
        {briefing.isPending && <StateMessage compact kind="loading" title="Loading recorded changes" />}
        {briefing.isError && (
          <StateMessage
            compact
            kind="error"
            title="Could not load briefing"
            description={briefing.error.message}
          />
        )}
        {briefing.data && (
          <>
            <p>
              {briefing.data.since
                ? new Date(briefing.data.since).toLocaleString()
                : 'Your first recorded project visit'}
            </p>
            {briefing.data.changes.length === 0 && <p>No recorded changes since your last visit.</p>}
            {briefing.data.changes.map((change, index) => (
              <div key={`${change.kind}-${change.document_id}-${index}`}>
                <a
                  href={
                    change.kind === 'pending_proposal'
                      ? `/review#proposal-${change.proposal_id}`
                      : citationHref({ documentId: change.document_id, revisionId: change.revision_id })
                  }
                >
                  {
                    {
                      source_changed: 'Source changed',
                      document_changed: 'Document changed',
                      applied_edit: 'Edit applied',
                      pending_proposal: 'Needs review',
                    }[change.kind]
                  }
                  : {change.title}
                </a>
                {change.previous_revision_id && (
                  <a href={`/documents/${change.document_id}?revision=${change.previous_revision_id}`}>
                    {' '}
                    Open previous version
                  </a>
                )}
              </div>
            ))}
            {briefing.data.truncated && <p>Showing the latest 100 recorded changes.</p>}
            <button className="secondary-action" disabled={visit.isPending} onClick={() => visit.mutate()}>
              Mark this visit
            </button>
          </>
        )}
        {visit.isError && (
          <StateMessage
            compact
            kind="error"
            title="Visit was not confirmed"
            description={visit.error.message}
          />
        )}
      </section>
      <section className="project-home-attention" aria-label="Project assignments">
        <div className="project-section-header">
          <h2>Project assignments</h2>
          <button className="secondary-action" onClick={() => setEditing(!editing)}>
            Review project claims
          </button>
        </div>
        <p>
          Review selected workspace sources and save private findings. Draft changes always require review.
          Closing this view leaves the assignment running.
        </p>
        {editing && (
          <form
            className="project-modal-form"
            onSubmit={(event) => {
              event.preventDefault()
              start.mutate()
            }}
          >
            <label className="project-modal-field">
              Review instructions
              <textarea
                value={instructions}
                maxLength={4000}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </label>
            <fieldset>
              <legend>Selected sources and drafts</legend>
              {project.documents.map((doc) => (
                <label key={doc.document_id} className="project-assignment-source">
                  <input
                    type="checkbox"
                    checked={selected.includes(doc.document_id)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, doc.document_id]
                          : selected.filter((id) => id !== doc.document_id),
                      )
                    }
                  />
                  {doc.document_title}
                </label>
              ))}
            </fieldset>
            <label className="project-modal-field">
              Time budget in seconds
              <input
                type="number"
                min={10}
                max={600}
                value={seconds}
                onChange={(event) => setSeconds(Number(event.target.value))}
              />
            </label>
            <label className="project-assignment-source">
              <input
                type="checkbox"
                checked={resumeAfterRestart}
                onChange={(event) => setResumeAfterRestart(event.target.checked)}
              />
              Resume interrupted work after server restart
            </label>
            <button
              className="primary-button"
              disabled={
                start.isPending || !instructions.trim() || selected.length === 0 || selected.length > 40
              }
            >
              Start project review
            </button>
            <button type="button" className="secondary-action" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        )}
        {start.isError && (
          <StateMessage
            compact
            kind="error"
            title="Assignment was not confirmed"
            description={start.error.message}
          />
        )}
        {assignments.isError && (
          <StateMessage
            compact
            kind="error"
            title="Could not load assignments"
            description={assignments.error.message}
          />
        )}
        {assignments.data?.map((assignment) => (
          <AssignmentStatus key={assignment.assignment_id} assignment={assignment} />
        ))}
      </section>
    </>
  )
}
