import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api, type Assignment, type ProjectDetail } from '../../api'
import { citationHref } from '../../citationNavigation'
import { StateMessage } from '../ui/StateMessage'
import { ProjectDialog } from './ProjectDialog'

type ProjectDocument = ProjectDetail['documents'][number]

const statusLabel = {
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  stopped: 'Stopped',
  completed: 'Done',
  failed: 'Failed',
  exhausted: 'Limit reached',
} satisfies Record<Assignment['status'], string>

type BriefingChange = Awaited<ReturnType<typeof api.projectBriefing>>['changes'][number]

const changeLabel = {
  source_changed: 'Source updated',
  document_changed: 'Edited',
  applied_edit: 'Edit applied',
  pending_proposal: 'Needs review',
} satisfies Record<BriefingChange['kind'], string>

const timeLimits = [
  { seconds: 60, label: '1 minute' },
  { seconds: 180, label: '3 minutes' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 600, label: '10 minutes' },
] as const

const dateTime = (value: string) =>
  new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/** One assignment as a compact row: status, budget, and the controls that apply to its state. */
export function AssignmentStatus({ assignment }: { assignment: Assignment }) {
  const client = useQueryClient()
  const [steering, setSteering] = useState<string | null>(null)
  const [key, setKey] = useState(() => crypto.randomUUID())
  const control = useMutation({
    mutationFn: (action: 'steer' | 'pause' | 'resume' | 'stop') =>
      api.controlAssignment(
        assignment.assignment_id,
        action,
        action === 'steer' ? (steering ?? '') : '',
        key,
      ),
    onSuccess: async () => {
      setKey(crypto.randomUUID())
      setSteering(null)
      await client.invalidateQueries({ queryKey: ['assignments'] })
      await client.invalidateQueries({ queryKey: ['assignment'] })
    },
  })
  const active = assignment.status === 'running' || assignment.status === 'queued'
  const resumable = assignment.status === 'paused' || assignment.status === 'failed'
  const terminal = assignment.status === 'stopped' || assignment.status === 'exhausted'
  const tokens = assignment.input_tokens + assignment.output_tokens
  return (
    <article className="assignment-row">
      <div className="assignment-row-main">
        <p className="assignment-row-title">{assignment.instructions}</p>
        <p className="assignment-row-meta">
          <span className={`scope-badge assignment-status ${assignment.status}`}>
            {statusLabel[assignment.status]}
          </span>
          <span>
            Attempt {assignment.steps} of {assignment.max_steps} · {Math.round(assignment.elapsed_seconds)}s
            of {assignment.max_seconds}s{tokens > 0 && ` · ${tokens.toLocaleString()} tokens`}
          </span>
        </p>
      </div>
      <div className="assignment-row-actions">
        {assignment.artifact_ids.map((id) => (
          <Link key={id} className="secondary-action" to="/documents/$documentId" params={{ documentId: id }}>
            Open findings
          </Link>
        ))}
        {assignment.proposal_ids.map((id) => (
          <a key={id} className="secondary-action" href={`/review#proposal-${id}`}>
            Review candidate
          </a>
        ))}
        {!terminal && (
          <>
            {active && (
              <button
                className="secondary-action"
                disabled={control.isPending}
                onClick={() => control.mutate('pause')}
              >
                Pause
              </button>
            )}
            {resumable && (
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
              aria-expanded={steering !== null}
              onClick={() => setSteering(steering === null ? '' : null)}
            >
              Steer
            </button>
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
      {assignment.error && (
        <StateMessage compact kind="error" title="Review needs attention" description={assignment.error} />
      )}
      {!terminal && steering !== null && (
        <form
          className="assignment-steer"
          onSubmit={(event) => {
            event.preventDefault()
            control.mutate('steer')
          }}
        >
          <input
            aria-label="Steering instructions"
            className="project-modal-input"
            placeholder="Add guidance for the next attempt"
            value={steering}
            maxLength={4000}
            autoFocus
            onChange={(event) => setSteering(event.target.value)}
          />
          <button className="secondary-action" disabled={!steering.trim() || control.isPending}>
            Send
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

/**
 * Project Home's single "what needs me" panel. It merges outstanding work (pending reviews,
 * updated sources) with recorded changes since the last marked visit, without duplicates.
 */
export function ProjectBriefing({
  project,
  reviews,
  updatedSources,
  onOpenDocument,
}: {
  project: ProjectDetail
  reviews: { pending: number; stale: number }
  updatedSources: ProjectDocument[]
  onOpenDocument: (doc: ProjectDocument) => void
}) {
  const client = useQueryClient()
  const [key, setKey] = useState(() => crypto.randomUUID())
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
  // A first visit has no baseline to compare against, so record one instead of asking.
  const needsBaseline = briefing.data?.since === null
  useEffect(() => {
    if (needsBaseline && visit.isIdle) visit.mutate()
  }, [needsBaseline, visit])
  // Pending proposals and updated sources already have their own rows below.
  const updatedIds = new Set(updatedSources.map((d) => d.document_id))
  const changes = (briefing.data?.changes ?? []).filter(
    (change) => change.kind !== 'pending_proposal' && !updatedIds.has(change.document_id),
  )
  const reviewCount = reviews.pending + reviews.stale
  if (briefing.isPending) return null
  if (!briefing.isError && reviewCount === 0 && updatedSources.length === 0 && changes.length === 0) {
    return null
  }
  return (
    <section className="project-briefing" aria-label="Since your last visit">
      <header className="project-briefing-header">
        <div>
          <h2>Since your last visit</h2>
          {briefing.data && (
            <p className="small-muted">
              {briefing.data.since ? dateTime(briefing.data.since) : 'First recorded visit'}
            </p>
          )}
        </div>
        {changes.length > 0 && (
          <button className="secondary-action" disabled={visit.isPending} onClick={() => visit.mutate()}>
            Mark as seen
          </button>
        )}
      </header>
      {briefing.isError && (
        <StateMessage
          compact
          kind="error"
          title="Could not load recorded changes"
          description={briefing.error.message}
          action={
            <button className="secondary-action" onClick={() => void briefing.refetch()}>
              Retry
            </button>
          }
        />
      )}
      <ul className="project-briefing-list">
        {reviewCount > 0 && (
          <li className="project-briefing-row">
            <span className="scope-badge workspace">Needs review</span>
            <Link className="project-briefing-title" to="/review">
              {reviews.pending > 0 &&
                `${reviews.pending} proposed ${reviews.pending === 1 ? 'change' : 'changes'}`}
              {reviews.pending > 0 && reviews.stale > 0 && ' · '}
              {reviews.stale > 0 && `${reviews.stale} stale, needs a fresh candidate`}
            </Link>
          </li>
        )}
        {updatedSources.map((doc) => (
          <li key={doc.document_id} className="project-briefing-row">
            <span className="scope-badge">Source updated</span>
            <button className="project-briefing-title" onClick={() => onOpenDocument(doc)}>
              {doc.document_title}
            </button>
          </li>
        ))}
        {changes.map((change, index) => (
          <li key={`${change.kind}-${change.document_id}-${index}`} className="project-briefing-row">
            <span className="scope-badge">{changeLabel[change.kind]}</span>
            <a
              className="project-briefing-title"
              href={citationHref({ documentId: change.document_id, revisionId: change.revision_id })}
            >
              {change.title}
            </a>
            {change.previous_revision_id && (
              <a
                className="project-briefing-aside"
                href={`/documents/${change.document_id}?revision=${change.previous_revision_id}`}
                aria-label={`Previous version of ${change.title}`}
              >
                Previous version
              </a>
            )}
          </li>
        ))}
      </ul>
      {briefing.data?.truncated && <p className="small-muted">Showing the latest 100 recorded changes.</p>}
      {visit.isError && (
        <StateMessage compact kind="error" title="Visit was not recorded" description={visit.error.message} />
      )}
    </section>
  )
}

/** Server-run project reviews: a one-line entry point, a start dialog, and one row per review. */
export function ProjectReviews({ project }: { project: ProjectDetail }) {
  const [starting, setStarting] = useState(false)
  const assignments = useQuery({
    queryKey: ['assignments', project.project_id],
    queryFn: () => api.listAssignments(project.project_id),
    refetchInterval: (query) =>
      query.state.data?.some((a) => a.status === 'running' || a.status === 'queued') ? 1500 : false,
  })
  return (
    <section className="project-reviews" aria-label="Project reviews">
      <header className="project-briefing-header">
        <div>
          <h2>Reviews</h2>
          <p className="small-muted">Check claims against your sources. Findings stay private.</p>
        </div>
        <button className="secondary-action" onClick={() => setStarting(true)}>
          Start review
        </button>
      </header>
      {assignments.isError && (
        <StateMessage
          compact
          kind="error"
          title="Could not load reviews"
          description={assignments.error.message}
        />
      )}
      {assignments.data?.map((assignment) => (
        <AssignmentStatus key={assignment.assignment_id} assignment={assignment} />
      ))}
      {starting && <StartReviewDialog project={project} onClose={() => setStarting(false)} />}
    </section>
  )
}

function StartReviewDialog({ project, onClose }: { project: ProjectDetail; onClose: () => void }) {
  const client = useQueryClient()
  const [instructions, setInstructions] = useState(
    'Find the weakest supported claim, strongest counterexample, and missing experiment.',
  )
  const [selected, setSelected] = useState(() =>
    project.documents.filter((doc) => doc.role !== 'output').map((doc) => doc.document_id),
  )
  const [seconds, setSeconds] = useState(180)
  const [key] = useState(() => crypto.randomUUID())
  const start = useMutation({
    mutationFn: () =>
      api.createAssignment(
        project.project_id,
        {
          instructions,
          document_ids: selected,
          max_steps: 3,
          max_seconds: seconds,
          resume_after_restart: true,
        },
        key,
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['assignments', project.project_id] })
      onClose()
    },
  })
  return (
    <ProjectDialog title="Start review" onClose={onClose}>
      <form
        className="project-modal-form"
        onSubmit={(event) => {
          event.preventDefault()
          start.mutate()
        }}
      >
        <p className="small-muted">
          Runs on the server, so you can close this page. Draft changes always wait for your review.
        </p>
        <label className="project-modal-field">
          What should the review look for?
          <textarea
            className="project-modal-textarea"
            value={instructions}
            maxLength={4000}
            onChange={(event) => setInstructions(event.target.value)}
          />
        </label>
        <div className="project-modal-field" role="group" aria-labelledby="start-review-documents">
          <span id="start-review-documents">Documents</span>
          <div className="project-assignment-sources">
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
                <span>{doc.document_title}</span>
              </label>
            ))}
          </div>
        </div>
        <label className="project-modal-field">
          Time limit
          <select
            className="project-modal-select"
            value={seconds}
            onChange={(event) => setSeconds(Number(event.target.value))}
          >
            {timeLimits.map((limit) => (
              <option key={limit.seconds} value={limit.seconds}>
                {limit.label}
              </option>
            ))}
          </select>
        </label>
        {start.isError && (
          <StateMessage
            compact
            kind="error"
            title="Review was not started"
            description={start.error.message}
          />
        )}
        <div className="project-detail-actions">
          <button type="button" className="secondary-action" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={
              start.isPending || !instructions.trim() || selected.length === 0 || selected.length > 40
            }
          >
            Start review
          </button>
        </div>
      </form>
    </ProjectDialog>
  )
}
