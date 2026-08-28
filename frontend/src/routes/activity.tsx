import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Activity, Bot, CalendarDays, FileText, ShieldAlert } from 'lucide-react'
import { activityRange, type ActivityRangePreset } from '../activityFilters'
import { api, type OperationEvent } from '../api'
import { StateMessage } from '../components/ui/StateMessage'

export const Route = createFileRoute('/activity')({ component: AgentActivity })

function AgentActivity() {
  const [actorId, setActorId] = useState('')
  const [outcome, setOutcome] = useState<OperationEvent['outcome'] | ''>('')
  const [rangePreset, setRangePreset] = useState<ActivityRangePreset>('all')
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const range = useMemo(
    () => activityRange(rangePreset, new Date(), { since, until }),
    [rangePreset, since, until],
  )
  const invalidRange = Boolean(range.since && range.until && range.since > range.until)
  const events = useQuery({
    queryKey: ['activity', actorId, outcome, rangePreset, range.since, range.until],
    queryFn: () =>
      api.listActivity({
        actorId: actorId || undefined,
        outcome: outcome || undefined,
        ...range,
      }),
    enabled: !invalidRange,
  })

  return (
    <section className="activity-page">
      <header>
        <div>
          <p className="eyebrow">Human review</p>
          <h1>Agent activity</h1>
          <p>Accepted, denied, conflicted, and failed operations without credentials or document bodies.</p>
        </div>
        <Activity size="var(--icon-page)" />
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
            onChange={(event) => {
              const val = event.target.value
              if (
                val === '' ||
                val === 'accepted' ||
                val === 'denied' ||
                val === 'conflict' ||
                val === 'failed'
              ) {
                setOutcome(val)
              }
            }}
          >
            <option value="">All outcomes</option>
            <option value="accepted">Accepted</option>
            <option value="denied">Denied</option>
            <option value="conflict">Conflict</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label>
          <span>Date range</span>
          <select
            aria-label="Activity date range"
            value={rangePreset}
            onChange={(event) => {
              const val = event.target.value
              if (val === 'all' || val === 'today' || val === '7d' || val === '30d' || val === 'custom') {
                setRangePreset(val)
              }
            }}
          >
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        {rangePreset === 'custom' && (
          <div className="activity-custom-range">
            <label>
              <span>Since</span>
              <input type="datetime-local" value={since} onChange={(event) => setSince(event.target.value)} />
            </label>
            <label>
              <span>Until</span>
              <input type="datetime-local" value={until} onChange={(event) => setUntil(event.target.value)} />
            </label>
          </div>
        )}
      </div>
      {invalidRange && (
        <div className="activity-range-error" role="alert">
          <CalendarDays size="var(--icon-inline)" /> Start must not be after end.
        </div>
      )}
      <section className="activity-list" aria-live="polite">
        {events.data?.map((event) => (
          <article key={event.event_id} className={`activity-event ${event.outcome}`}>
            <span className="activity-outcome">
              {event.outcome === 'denied' || event.outcome === 'conflict' ? (
                <ShieldAlert size="var(--icon-inline)" />
              ) : (
                <Bot size="var(--icon-inline)" />
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
                <FileText size="var(--icon-inline)" /> Review document
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
        {!invalidRange && events.data?.length === 0 && (
          <StateMessage
            compact
            kind="empty"
            title="No matching activity"
            description="Change the actor, outcome, or date range to widen the result."
          />
        )}
      </section>
    </section>
  )
}
