import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Activity, Bot, FileText, ShieldAlert } from 'lucide-react'
import { api, type OperationEvent } from '../api'

export const Route = createFileRoute('/activity')({ component: AgentActivity })

function AgentActivity() {
  const [actorId, setActorId] = useState('')
  const [outcome, setOutcome] = useState<OperationEvent['outcome'] | ''>('')
  const events = useQuery({
    queryKey: ['activity', actorId, outcome],
    queryFn: () => api.listActivity(actorId || undefined, outcome || undefined),
  })

  return (
    <main className="activity-page">
      <header>
        <div>
          <p className="eyebrow">Human review</p>
          <h1>Agent activity</h1>
          <p>Accepted, denied, conflicted, and failed operations without credentials or document bodies.</p>
        </div>
        <Activity size={28} />
      </header>
      <div className="activity-filters">
        <label>
          <span>Actor ID</span>
          <input
            placeholder="agent:researcher"
            value={actorId}
            onChange={(event) => setActorId(event.target.value)}
          />
        </label>
        <label>
          <span>Outcome</span>
          <select
            value={outcome}
            onChange={(event) => setOutcome(event.target.value as OperationEvent['outcome'] | '')}
          >
            <option value="">All outcomes</option>
            <option value="accepted">Accepted</option>
            <option value="denied">Denied</option>
            <option value="conflict">Conflict</option>
            <option value="failed">Failed</option>
          </select>
        </label>
      </div>
      <section className="activity-list" aria-live="polite">
        {events.data?.map((event) => (
          <article key={event.operation_id} className={`activity-event ${event.outcome}`}>
            <span className="activity-outcome">
              {event.outcome === 'denied' || event.outcome === 'conflict' ? (
                <ShieldAlert size={16} />
              ) : (
                <Bot size={16} />
              )}
              {event.outcome}
            </span>
            <div>
              <strong>
                {event.actor_display_name} · {event.action} {event.resource_type}
              </strong>
              <small>
                {event.actor_id}
                {event.token_label ? ` via ${event.token_label}` : ''} ·{' '}
                {new Date(event.created_at).toLocaleString()}
              </small>
              {event.path && <code>/{event.path}</code>}
              <small>Operation {event.operation_id}</small>
            </div>
            {event.resource_id && event.resource_type === 'document' && (
              <Link to="/documents/$documentId" params={{ documentId: event.resource_id }}>
                <FileText size={14} /> Review document
              </Link>
            )}
          </article>
        ))}
        {events.isLoading && <p className="small-muted">Loading activity…</p>}
        {events.isError && <p className="operation-result error-text">{events.error.message}</p>}
        {events.data?.length === 0 && <p className="small-muted">No matching activity.</p>}
      </section>
    </main>
  )
}
