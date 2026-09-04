import { RotateCcw } from 'lucide-react'
import { useEffect, useRef } from 'react'
import type { ActivitySearch } from '../../activitySearch'
import { useMediaQuery } from '../../useMediaQuery'

export function ActivityFilters({
  search,
  onChange,
}: {
  search: ActivitySearch
  onChange: (patch: Partial<ActivitySearch>) => void
}) {
  const compact = useMediaQuery('(max-width: 800px)')
  const disclosure = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if (disclosure.current) disclosure.current.open = !compact
  }, [compact])
  return (
    <details ref={disclosure} className="activity-filter-disclosure">
      <summary>Filters</summary>
      <div className="activity-filters">
        <label>
          <span>Actor ID</span>
          <input
            placeholder="agent:researcher"
            value={search.actor_id ?? ''}
            onChange={(event) => onChange({ actor_id: event.target.value || undefined })}
          />
        </label>
        <label>
          <span>Token</span>
          <input
            placeholder="agt_…"
            value={search.token_id ?? ''}
            onChange={(event) => onChange({ token_id: event.target.value || undefined })}
          />
        </label>
        <label>
          <span>Outcome</span>
          <select
            value={search.outcome ?? ''}
            onChange={(event) => {
              const value = event.target.value
              if (
                value === '' ||
                value === 'accepted' ||
                value === 'denied' ||
                value === 'conflict' ||
                value === 'failed'
              )
                onChange({ outcome: value || undefined })
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
            value={search.range}
            onChange={(event) => {
              const value = event.target.value
              if (
                value === 'all' ||
                value === 'today' ||
                value === '7d' ||
                value === '30d' ||
                value === 'custom'
              )
                onChange({ range: value })
            }}
          >
            <option value="all">All time</option>
            <option value="today">Today</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          <span>Action</span>
          <input
            value={search.action ?? ''}
            onChange={(event) => onChange({ action: event.target.value || undefined })}
          />
        </label>
        <label>
          <span>Resource type</span>
          <input
            value={search.resource_type ?? ''}
            onChange={(event) => onChange({ resource_type: event.target.value || undefined })}
          />
        </label>
        <label>
          <span>Resource ID</span>
          <input
            value={search.resource_id ?? ''}
            onChange={(event) => onChange({ resource_id: event.target.value || undefined })}
          />
        </label>
        <label>
          <span>Path contains</span>
          <input
            value={search.path ?? ''}
            onChange={(event) => onChange({ path: event.target.value || undefined })}
          />
        </label>
        <label>
          <span>Error code</span>
          <input
            value={search.error_code ?? ''}
            onChange={(event) => onChange({ error_code: event.target.value || undefined })}
          />
        </label>
        <label>
          <span>Operation ID</span>
          <input
            value={search.operation_id ?? ''}
            onChange={(event) => onChange({ operation_id: event.target.value || undefined })}
          />
        </label>
        {search.range === 'custom' && (
          <div className="activity-custom-range">
            <label>
              <span>Since</span>
              <input
                type="datetime-local"
                value={search.since ?? ''}
                onChange={(event) => onChange({ since: event.target.value || undefined })}
              />
            </label>
            <label>
              <span>Until</span>
              <input
                type="datetime-local"
                value={search.until ?? ''}
                onChange={(event) => onChange({ until: event.target.value || undefined })}
              />
            </label>
          </div>
        )}
        <button
          type="button"
          className="secondary-action activity-clear-filters"
          onClick={() =>
            onChange({
              actor_id: undefined,
              token_id: undefined,
              outcome: undefined,
              action: undefined,
              resource_type: undefined,
              resource_id: undefined,
              path: undefined,
              error_code: undefined,
              operation_id: undefined,
              attention: false,
              range: '7d',
              since: undefined,
              until: undefined,
            })
          }
        >
          <RotateCcw size="var(--icon-inline)" /> Clear all
        </button>
      </div>
    </details>
  )
}
