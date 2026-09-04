import { ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { ActivitySearch } from '../../activitySearch'
import { api } from '../../api'

export function ActivityFilters({
  search,
  onChange,
}: {
  search: ActivitySearch
  onChange: (patch: Partial<ActivitySearch>) => void
}) {
  const activeFilterCount = [
    search.actor_id,
    search.token_id,
    search.outcome,
    search.action,
    search.resource_type,
    search.resource_id,
    search.path,
    search.error_code,
    search.operation_id,
    search.attention ? 'attention' : undefined,
    search.range !== '7d' ? search.range : undefined,
  ].filter(Boolean).length
  const [filtersOpen, setFiltersOpen] = useState(activeFilterCount > 0)
  const directory = useQuery({
    queryKey: ['activity-filter-directory'],
    queryFn: async () => {
      const [summary, tokens] = await Promise.all([api.activitySummary(), api.listAgentTokens()])
      const actorNames = new Map(summary.actors.map((actor) => [actor.actor_id, actor.actor_display_name]))
      for (const token of tokens) actorNames.set(token.actor_id, token.actor_display_name)
      return {
        actors: [...actorNames].sort((left, right) => left[1].localeCompare(right[1])),
        tokens,
      }
    },
  })
  const selectedActorKnown = directory.data?.actors.some(([id]) => id === search.actor_id) ?? false
  const selectedTokenKnown =
    directory.data?.tokens.some((token) => token.token_id === search.token_id) ?? false
  return (
    <details
      className="activity-filter-disclosure"
      open={filtersOpen}
      onToggle={(event) => setFiltersOpen(event.currentTarget.open)}
    >
      <summary>
        <span>
          <SlidersHorizontal size="var(--icon-inline)" /> Filters
          {activeFilterCount > 0 && <b>{activeFilterCount}</b>}
        </span>
        <ChevronDown className="activity-filter-chevron" size="var(--icon-inline)" />
      </summary>
      <div className="activity-filters">
        <label>
          <span>Agent</span>
          <select
            aria-label="Agent"
            value={search.actor_id ?? ''}
            onChange={(event) => onChange({ actor_id: event.target.value || undefined })}
          >
            <option value="">All agents</option>
            {search.actor_id && !selectedActorKnown && (
              <option value={search.actor_id}>{search.actor_id} (historical)</option>
            )}
            {directory.data?.actors.map(([id, name]) => (
              <option key={id} value={id}>
                {name} ({id})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Token</span>
          <select
            value={search.token_id ?? ''}
            onChange={(event) => onChange({ token_id: event.target.value || undefined })}
          >
            <option value="">All tokens</option>
            {search.token_id && !selectedTokenKnown && (
              <option value={search.token_id}>{search.token_id} (historical)</option>
            )}
            {directory.data?.tokens.map((token) => (
              <option key={token.token_id} value={token.token_id}>
                {token.label} · {token.actor_display_name}
              </option>
            ))}
          </select>
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
