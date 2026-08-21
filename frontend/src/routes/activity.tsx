import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Activity, Bot, FileText, ShieldAlert } from 'lucide-react'
import { api, type OperationEvent } from '../api'
import { StateMessage } from '../components/ui/StateMessage'

export const Route = createFileRoute('/activity')({ component: AgentActivity })

function AgentActivity() {
  const [actorId, setActorId] = useState('')
  const [outcome, setOutcome] = useState<OperationEvent['outcome'] | ''>('')
  const events = useQuery({
    queryKey: ['activity', actorId, outcome],
    queryFn: () => api.listActivity(actorId || undefined, outcome || undefined),
  })

  return (
    <section className="activity-page">
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
        {events.isLoading && <StateMessage compact kind="loading" title="Loading activity" />}
        {events.isError && (
          <StateMessage
            compact
            kind="error"
            title="Activity could not be loaded"
            description={events.error.message}
            action={<button onClick={() => void events.refetch()}>Retry</button>}
          />
        )}
        {events.data?.length === 0 && (
          <StateMessage
            compact
            kind="empty"
            title="No matching activity"
            description="Change the actor or outcome filter to widen the result."
          />
        )}
      </section>
    </section>
  )
}
