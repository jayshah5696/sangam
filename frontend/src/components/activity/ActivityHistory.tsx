import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  FileText,
  GitCompareArrows,
  ListFilter,
  ShieldAlert,
  XCircle,
} from 'lucide-react'
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
          className="icon-button"
          aria-label="Previous"
          title="Previous page"
          disabled={search.page === 1}
          onClick={() => onSearchChange({ page: search.page - 1 })}
        >
          <ChevronLeft size="var(--icon-control)" />
        </button>
        <span>Page {search.page}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Next"
          title="Next page"
          disabled={(events.data?.length ?? 0) < pageSize}
          onClick={() => onSearchChange({ page: search.page + 1 })}
        >
          <ChevronRight size="var(--icon-control)" />
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
  const outcomeSummary = [
    counts.accepted > 0 ? `${counts.accepted} accepted` : undefined,
    counts.denied > 0 ? `${counts.denied} denied` : undefined,
    counts.conflict > 0 ? `${counts.conflict} conflict` : undefined,
    counts.failed > 0 ? `${counts.failed} failed` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <article className="activity-operation">
      <div className="activity-operation-summary">
        <time dateTime={first.created_at}>{new Date(first.created_at).toLocaleString()}</time>
        <div>
          <strong>
            {first.actor_display_name} · {actions.join(', ')} · {resources.size}{' '}
            {resources.size === 1 ? resourceTypes[0] : 'resources'}
          </strong>
          <small>
            {first.token_label ? `${first.token_label} · ` : ''}
            {outcomeSummary}
          </small>
          {first.created_at !== end.created_at && (
            <small>
              {new Date(end.created_at).toLocaleString()} to {new Date(first.created_at).toLocaleString()}
            </small>
          )}
        </div>
        <div className="activity-operation-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={`Copy operation ID ${first.operation_id}`}
            title="Copy operation ID"
            onClick={() => void navigator.clipboard.writeText(first.operation_id)}
          >
            <Clipboard size="var(--icon-control)" />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Filter operation"
            title="Filter operation"
            onClick={() => onSearchChange({ operation_id: first.operation_id })}
          >
            <ListFilter size="var(--icon-control)" />
          </button>
          <button
            type="button"
            className="icon-button activity-expand-operation"
            aria-label={expanded ? 'Hide details' : 'Expand details'}
            title={expanded ? 'Hide details' : 'Expand details'}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronDown size="var(--icon-control)" />
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
