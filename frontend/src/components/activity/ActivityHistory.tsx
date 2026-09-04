import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, Clipboard, FileText, GitCompareArrows, ShieldAlert, XCircle } from 'lucide-react'
import { useState } from 'react'
import { groupActivityEvents } from '../../activityGrouping'
import type { ActivitySearch } from '../../activitySearch'
import { api, type ActivityFilters, type OperationEvent } from '../../api'
import { citationHref } from '../../citationNavigation'
import { StateMessage } from '../ui/StateMessage'
import { useOnlineStatus } from '../../useOnlineStatus'
import { ActivityFilters as FilterControls } from './ActivityFilters'

const pageSize = 50

export function ActivityHistory({
  search,
  filters,
  invalidRange,
  refreshKey,
  onSearchChange,
}: {
  search: ActivitySearch
  filters: ActivityFilters
  invalidRange: boolean
  refreshKey: number
  onSearchChange: (patch: Partial<ActivitySearch>) => void
}) {
  const events = useQuery({
    queryKey: ['activity', filters, search.page, refreshKey],
    queryFn: () => api.listActivity(filters, pageSize, (search.page - 1) * pageSize),
    enabled: !invalidRange,
    placeholderData: keepPreviousData,
  })
  const groups = groupActivityEvents(events.data ?? [])
  const online = useOnlineStatus()

  return (
    <div id="activity-activity-panel" role="tabpanel" aria-label="Activity history">
      <FilterControls search={search} onChange={onSearchChange} />
      {!online && (
        <StateMessage
          compact
          kind="offline"
          title="Activity is offline"
          description="Showing loaded events. Reconnect to refresh the ledger."
        />
      )}
      <section className="activity-list" aria-live="polite" aria-busy={events.isFetching}>
        {groups.map((group) => (
          <OperationGroup key={group[0]?.operation_id} events={group} onSearchChange={onSearchChange} />
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
            description="Clear a filter or widen the date range."
          />
        )}
      </section>
      <nav className="activity-pagination" aria-label="Activity pages">
        <button
          type="button"
          className="secondary-action"
          disabled={search.page === 1}
          onClick={() => onSearchChange({ page: search.page - 1 })}
        >
          Previous
        </button>
        <span>Page {search.page}</span>
        <button
          type="button"
          className="secondary-action"
          disabled={(events.data?.length ?? 0) < pageSize}
          onClick={() => onSearchChange({ page: search.page + 1 })}
        >
          Next
        </button>
      </nav>
    </div>
  )
}

function OperationGroup({
  events,
  onSearchChange,
}: {
  events: OperationEvent[]
  onSearchChange: (patch: Partial<ActivitySearch>) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const first = events[0]
  if (!first) return null
  const counts = { accepted: 0, denied: 0, conflict: 0, failed: 0 }
  for (const event of events) counts[event.outcome] += 1
  const resources = new Set(
    events.map((event) => `${event.resource_type}:${event.resource_id ?? event.path ?? ''}`),
  )
  const actions = [...new Set(events.map((event) => event.action))]
  const resourceTypes = [...new Set(events.map((event) => event.resource_type))]
  const end = events[events.length - 1] ?? first

  return (
    <article className="activity-operation">
      <div className="activity-operation-summary">
        <time dateTime={first.created_at}>{new Date(first.created_at).toLocaleString()}</time>
        <div>
          <strong>
            {first.actor_display_name} · {actions.join(', ')} · {resources.size}{' '}
            {resources.size === 1 ? resourceTypes[0] : 'resources'}
          </strong>
          {first.token_label && <small>Token {first.token_label}</small>}
          <small>
            {counts.accepted} accepted · {counts.denied} denied · {counts.conflict} conflict · {counts.failed}{' '}
            failed
          </small>
          <small>
            {first.created_at === end.created_at
              ? 'One recorded outcome'
              : `${new Date(end.created_at).toLocaleString()} to ${new Date(first.created_at).toLocaleString()}`}
          </small>
        </div>
        <div className="activity-operation-actions">
          <button
            type="button"
            className="secondary-action"
            aria-label={`Copy operation ID ${first.operation_id}`}
            onClick={() => void navigator.clipboard.writeText(first.operation_id)}
          >
            <Clipboard size="var(--icon-inline)" /> Copy ID
          </button>
          <button
            type="button"
            className="secondary-action"
            onClick={() => onSearchChange({ operation_id: first.operation_id })}
          >
            Filter operation
          </button>
          <button
            type="button"
            className="secondary-action"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? 'Hide details' : 'Expand details'}
          </button>
        </div>
      </div>
      <code title={first.operation_id}>Operation {first.operation_id}</code>
      {expanded && (
        <div className="activity-operation-events">
          {events.map((event) => (
            <EventRow key={event.event_id} event={event} />
          ))}
        </div>
      )}
    </article>
  )
}

function EventRow({ event }: { event: OperationEvent }) {
  const Icon =
    event.outcome === 'accepted'
      ? CheckCircle2
      : event.outcome === 'conflict'
        ? GitCompareArrows
        : event.outcome === 'failed'
          ? XCircle
          : ShieldAlert
  return (
    <div className={`activity-event ${event.outcome}`}>
      <span className="activity-outcome" aria-label={`Outcome: ${event.outcome}`}>
        <Icon size="var(--icon-inline)" /> {event.outcome}
      </span>
      <div>
        <strong>
          {event.action} {event.resource_type}
        </strong>
        <small>
          {event.actor_id}
          {event.token_label ? ` via ${event.token_label}` : ''} ·{' '}
          {new Date(event.created_at).toLocaleString()}
        </small>
        {event.path && <code title={event.path}>/{event.path}</code>}
        {event.resource_id && <code title={event.resource_id}>Resource {event.resource_id}</code>}
        {event.error_code && <small>Error: {event.error_code}</small>}
        {event.revision_id && <code title={event.revision_id}>Revision {event.revision_id}</code>}
        {Object.entries(event.details).map(([key, value]) => (
          <small key={key}>
            {detailLabel(key)}: <code>{String(value)}</code>
          </small>
        ))}
      </div>
      <div className="activity-event-actions">
        {event.resource_id && event.resource_type === 'document' && (
          <Link to="/documents/$documentId" params={{ documentId: event.resource_id }}>
            <FileText size="var(--icon-inline)" /> Open document
          </Link>
        )}
        {event.resource_id && event.resource_type === 'document' && event.revision_id && (
          <a
            href={citationHref({
              documentId: event.resource_id,
              revisionId: event.revision_id,
            })}
          >
            Review revision
          </a>
        )}
        {event.token_id && (
          <Link to="/settings" search={{ category: 'agents', destination: event.token_id }}>
            Manage access
          </Link>
        )}
        {event.resource_type === 'publication' && <Link to="/publications">Open publications</Link>}
      </div>
    </div>
  )
}

function detailLabel(key: string): string {
  return key.replaceAll('_', ' ')
}
