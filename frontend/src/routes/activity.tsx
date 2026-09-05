import { keepPreviousData, useIsFetching, useQuery } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { activityRange } from '../activityFilters'
import { activitySearchSchema, type ActivitySearch } from '../activitySearch'
import { api, type ActivityFilters } from '../api'
import { ActivityHistory } from '../components/activity/ActivityHistory'
import { ActivityInsights } from '../components/activity/ActivityInsights'
import { activateTabFromKeyboard } from '../components/tabKeyboard'
import { StateMessage } from '../components/ui/StateMessage'

export const Route = createFileRoute('/activity')({
  validateSearch: activitySearchSchema,
  component: ActivityPage,
})

function ActivityPage() {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/activity' })
  const [refresh, setRefresh] = useState(() => ({ anchor: new Date(), key: 0 }))
  const custom = { since: search.since ?? '', until: search.until ?? '' }
  const range = activityRange(search.range, refresh.anchor, custom)
  const invalidRange = Boolean(range.since && range.until && range.since > range.until)
  const filters: ActivityFilters = {
    actorId: search.actor_id,
    tokenId: search.token_id,
    outcome: search.outcome,
    action: search.action,
    resourceType: search.resource_type,
    resourceId: search.resource_id,
    path: search.path,
    errorCode: search.error_code,
    operationId: search.operation_id,
    attention: search.attention,
    ...range,
  }
  const summary = useQuery({
    queryKey: ['activity-summary', filters, refresh.key],
    queryFn: () => api.activitySummary(filters),
    enabled: search.view === 'insights' && !invalidRange,
    placeholderData: keepPreviousData,
  })
  const refreshQueryRoot = search.view === 'insights' ? 'activity-summary' : 'activity'
  const refreshing = useIsFetching({ queryKey: [refreshQueryRoot] }) > 0

  const updateSearch = (patch: Partial<ActivitySearch>) => {
    void navigate({
      search: (current) => ({ ...current, ...patch, page: patch.page ?? 1 }),
      replace: true,
    })
  }

  return (
    <section className="activity-page">
      <header>
        <div>
          <h1>Activity</h1>
          <p>Understand agent work, investigate problems, and review the immutable operation ledger.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh activity"
          title="Refresh activity"
          disabled={refreshing}
          onClick={() => setRefresh((current) => ({ anchor: new Date(), key: current.key + 1 }))}
        >
          <RefreshCw className={refreshing ? 'spin' : undefined} size="var(--icon-control)" />
        </button>
      </header>

      <div className="activity-view-tabs" role="tablist" aria-label="Activity views">
        {(['insights', 'activity'] as const).map((view) => (
          <button
            key={view}
            type="button"
            role="tab"
            aria-selected={search.view === view}
            aria-controls={`activity-${view}-panel`}
            tabIndex={search.view === view ? 0 : -1}
            onKeyDown={activateTabFromKeyboard}
            onClick={() => updateSearch({ view })}
          >
            {view === 'insights' ? 'Insights' : 'Activity'}
          </button>
        ))}
      </div>

      {invalidRange && (
        <StateMessage
          compact
          kind="error"
          title="Start must not be after end"
          description="Choose an end time after the start time."
        />
      )}

      {search.view === 'insights' ? (
        <ActivityInsights search={search} summary={summary} onSearchChange={updateSearch} />
      ) : (
        <ActivityHistory
          search={search}
          filters={filters}
          invalidRange={invalidRange}
          refreshKey={refresh.key}
          onSearchChange={updateSearch}
        />
      )}
    </section>
  )
}
