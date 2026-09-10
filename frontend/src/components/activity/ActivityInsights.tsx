import { useMutation, type UseQueryResult } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  ChartNoAxesCombined,
  BookOpen,
  CircleCheck,
  FilePenLine,
  KeyRound,
  ListFilter,
  RadioTower,
  ShieldAlert,
  Undo2,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import type { ActivitySearch } from '../../activitySearch'
import { api, type ActivitySummary } from '../../api'
import { citationHref } from '../../citationNavigation'
import { StateMessage } from '../ui/StateMessage'
import { useOnlineStatus } from '../../useOnlineStatus'
import { ActivityFilters } from './ActivityFilters'

export function ActivityInsights({
  search,
  summary,
  onSearchChange,
}: {
  search: ActivitySearch
  summary: UseQueryResult<ActivitySummary, Error>
  onSearchChange: (patch: Partial<ActivitySearch>) => void
}) {
  const data = summary.data
  const online = useOnlineStatus()
  const [showAllProblems, setShowAllProblems] = useState(false)
  const [showAcknowledged, setShowAcknowledged] = useState(false)
  const acknowledgement = useMutation({
    mutationFn: async ({ eventId, restore }: { eventId: string; restore: boolean }) => {
      if (restore) await api.restoreActivityProblem(eventId)
      else await api.acknowledgeActivityProblem(eventId)
    },
    onSuccess: () => summary.refetch(),
  })
  return (
    <div id="activity-insights-panel" role="tabpanel" aria-label="Activity insights">
      <ActivityFilters search={search} onChange={onSearchChange} />
      {!online && (
        <StateMessage
          compact
          kind="offline"
          title="Activity insights are offline"
          description="Showing the latest loaded summary. Reconnect to refresh it."
        />
      )}
      {summary.isLoading && <StateMessage compact kind="loading" title="Loading insights" />}
      {summary.isError && (
        <StateMessage
          compact
          kind="error"
          title="Insights could not be loaded"
          description={summary.error.message}
          action={<button onClick={() => void summary.refetch()}>Retry</button>}
        />
      )}
      {data && (
        <>
          <section className="activity-metrics" aria-label={`Summary for ${rangeLabel(search.range)}`}>
            {[
              ['Needs attention', data.attention_count],
              ['Changes', data.actors.reduce((total, actor) => total + actor.accepted_changes, 0)],
              ['Publications', data.publications.length],
              ['Active agents', data.counts.active_actors],
            ].map(([label, value]) => (
              <div key={label}>
                <strong>{value}</strong>
                <span>{label}</span>
              </div>
            ))}
          </section>

          <section
            className="activity-insight-section activity-attention"
            aria-labelledby="needs-attention-title"
          >
            <div className="activity-section-heading">
              <ShieldAlert size="var(--icon-section)" />
              <h2 id="needs-attention-title">Needs attention</h2>
            </div>
            {data.problems.length === 0 ? (
              <StateMessage compact kind="success" title="Nothing needs attention" />
            ) : (
              data.problems
                .slice(0, showAllProblems ? undefined : 3)
                .map((problem) => (
                  <ActivityProblem
                    key={problem.latest_event_id}
                    problem={problem}
                    pending={
                      acknowledgement.isPending &&
                      acknowledgement.variables.eventId === problem.latest_event_id
                    }
                    onAcknowledge={() =>
                      acknowledgement.mutate({ eventId: problem.latest_event_id, restore: false })
                    }
                    onSearchChange={onSearchChange}
                  />
                ))
            )}
            {data.problems.length > 3 && (
              <button
                type="button"
                className="activity-show-more secondary-action"
                onClick={() => setShowAllProblems((current) => !current)}
              >
                {showAllProblems
                  ? 'Show fewer'
                  : `Show ${data.attention_count - 3} more${data.problems_truncated ? '+' : ''}`}
              </button>
            )}
            {acknowledgement.isError && (
              <StateMessage compact kind="error" title="Acknowledgement could not be saved" />
            )}
            {data.acknowledged_problems.length > 0 && (
              <button
                type="button"
                className="activity-show-acknowledged"
                aria-expanded={showAcknowledged}
                onClick={() => setShowAcknowledged((current) => !current)}
              >
                {showAcknowledged ? 'Hide' : 'Show'} acknowledged ({data.acknowledged_problems.length}
                {data.acknowledged_problems_truncated ? '+' : ''})
              </button>
            )}
            {showAcknowledged && (
              <div className="activity-acknowledged-list" aria-label="Acknowledged issues">
                {data.acknowledged_problems.map((problem) => (
                  <ActivityProblem
                    key={problem.latest_event_id}
                    problem={problem}
                    acknowledged
                    pending={
                      acknowledgement.isPending &&
                      acknowledgement.variables.eventId === problem.latest_event_id
                    }
                    onAcknowledge={() =>
                      acknowledgement.mutate({ eventId: problem.latest_event_id, restore: true })
                    }
                    onSearchChange={onSearchChange}
                  />
                ))}
              </div>
            )}
          </section>

          <section className="activity-insight-section" aria-labelledby="trend-title">
            <div className="activity-section-heading">
              <ChartNoAxesCombined size="var(--icon-section)" />
              <h2 id="trend-title">Activity over time</h2>
            </div>
            {data.buckets.length === 0 ? (
              <StateMessage compact kind="empty" title="No activity to chart" />
            ) : (
              <ActivityTrendChart buckets={data.buckets} range={search.range} />
            )}
            <details className="activity-trend-table">
              <summary>Read activity values</summary>
              <table>
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Accepted</th>
                    <th>Denied</th>
                    <th>Conflict</th>
                    <th>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.buckets.map((bucket) => (
                    <tr key={bucket.start}>
                      <th>{new Date(bucket.start).toLocaleString()}</th>
                      <td>{bucket.accepted}</td>
                      <td>{bucket.denied}</td>
                      <td>{bucket.conflict}</td>
                      <td>{bucket.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </section>

          <div className="activity-insight-grid">
            <InsightList
              icon={Users}
              title="Actors"
              empty="No actor activity"
              isEmpty={data.actors.length === 0}
            >
              <>
                {data.actors.map((actor) => (
                  <Link
                    key={actor.actor_id}
                    to="/activity"
                    search={{ view: 'activity', range: search.range, actor_id: actor.actor_id }}
                  >
                    <span>
                      <strong>{actor.actor_display_name}</strong>
                    </span>
                    <span>
                      {actor.accepted_changes} changes · {actor.reads} reads ·{' '}
                      {actor.denied + actor.conflict + actor.failed} problems
                    </span>
                  </Link>
                ))}
              </>
            </InsightList>
            <DocumentInsight
              title="Most changed documents"
              icon={FilePenLine}
              rows={data.changed_documents}
            />
            <DocumentInsight title="Most read documents" icon={BookOpen} rows={data.read_documents} />
            <DocumentInsight
              title="Documents with problems"
              icon={AlertTriangle}
              rows={data.problem_documents}
            />
          </div>

          <section className="activity-insight-section" aria-labelledby="publication-activity-title">
            <div className="activity-section-heading">
              <RadioTower size="var(--icon-section)" />
              <h2 id="publication-activity-title">Publication activity</h2>
              <Link to="/publications">Manage publications</Link>
            </div>
            {data.publications.length === 0 ? (
              <StateMessage compact kind="empty" title="No publication activity" />
            ) : (
              <div className="activity-insight-list">
                {data.publications.map((publication) => (
                  <div key={`${publication.publication_id}:${publication.created_at}`}>
                    <span>
                      <strong>
                        {publication.document_title ?? publication.slug ?? 'Historical publication'}
                      </strong>
                      <small>
                        {publication.actor_id} · {publication.action} · {publication.outcome} ·{' '}
                        {publication.access_policy ?? 'historical policy'}
                      </small>
                    </span>
                    {publication.document_id && (
                      <Link to="/documents/$documentId" params={{ documentId: publication.document_id }}>
                        Open source
                      </Link>
                    )}
                    {publication.active && publication.access_policy === 'public' && publication.slug && (
                      <Link to="/p/$slug" params={{ slug: publication.slug }}>
                        Open public page
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function ActivityProblem({
  problem,
  acknowledged = false,
  pending,
  onAcknowledge,
  onSearchChange,
}: {
  problem: ActivitySummary['problems'][number]
  acknowledged?: boolean
  pending: boolean
  onAcknowledge: () => void
  onSearchChange: (patch: Partial<ActivitySearch>) => void
}) {
  const title =
    problem.category === 'access'
      ? 'Access denied'
      : problem.category === 'conflict'
        ? 'Revision conflict'
        : problem.category === 'publication'
          ? 'Publication failed'
          : 'Operation failed'
  const StatusIcon = acknowledged ? CircleCheck : AlertTriangle
  return (
    <article className={`activity-problem ${problem.category}${acknowledged ? ' acknowledged' : ''}`}>
      <StatusIcon size="var(--icon-control)" />
      <div>
        <strong>{title}</strong>
        <p>
          {problem.actor_display_name} attempted {problem.action} on{' '}
          {problem.path ? `/${problem.path}` : problem.resource_type}.{' '}
          {problem.count > 1 ? `${problem.count} occurrences.` : ''}
        </p>
        <small>
          {[problem.token_label, problem.capability, problem.error_code].filter(Boolean).join(' · ')} ·{' '}
          {new Date(problem.latest_at).toLocaleString()}
          {acknowledged && problem.acknowledged_at
            ? ` · Acknowledged ${new Date(problem.acknowledged_at).toLocaleString()}`
            : ''}
        </small>
      </div>
      <div className="activity-problem-actions">
        {problem.resource_type === 'document' &&
          problem.resource_id &&
          (problem.expected_revision_id ? (
            <a
              className="secondary-action"
              href={citationHref({
                documentId: problem.resource_id,
                revisionId: problem.expected_revision_id,
              })}
            >
              Review expected revision
            </a>
          ) : (
            <Link
              className="secondary-action"
              to="/documents/$documentId"
              params={{ documentId: problem.resource_id }}
            >
              Open document
            </Link>
          ))}
        {problem.resource_type === 'publication' && (
          <Link className="secondary-action" to="/publications">
            Open publications
          </Link>
        )}
        {problem.token_id && (
          <Link
            className="icon-button"
            aria-label="Manage access"
            title="Manage access"
            to="/settings"
            search={{ category: 'agents', destination: problem.token_id }}
          >
            <KeyRound size="var(--icon-control)" />
          </Link>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="View events"
          title="View events"
          onClick={() =>
            onSearchChange({
              view: 'activity',
              actor_id: problem.actor_id,
              token_id: problem.token_id ?? undefined,
              action: problem.action,
              resource_type: problem.resource_type,
              resource_id: problem.resource_id ?? undefined,
              path: problem.path ?? undefined,
              error_code: problem.error_code ?? undefined,
              attention: true,
            })
          }
        >
          <ListFilter size="var(--icon-control)" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={acknowledged ? 'Restore issue' : 'Acknowledge issue'}
          title={acknowledged ? 'Restore to needs attention' : 'Acknowledge issue'}
          disabled={pending}
          onClick={onAcknowledge}
        >
          {acknowledged ? <Undo2 size="var(--icon-control)" /> : <CircleCheck size="var(--icon-control)" />}
        </button>
      </div>
    </article>
  )
}

function InsightList({
  icon: Icon,
  title,
  empty,
  isEmpty,
  children,
}: {
  icon: typeof Users
  title: string
  empty: string
  isEmpty: boolean
  children: React.ReactNode
}) {
  return (
    <section className="activity-insight-section">
      <div className="activity-section-heading">
        <Icon size="var(--icon-section)" />
        <h2>{title}</h2>
      </div>
      <div className="activity-insight-list">
        {isEmpty ? <StateMessage compact kind="empty" title={empty} /> : children}
      </div>
    </section>
  )
}

function DocumentInsight({
  title,
  icon,
  rows,
}: {
  title: string
  icon: typeof Users
  rows: ActivitySummary['changed_documents']
}) {
  return (
    <InsightList icon={icon} title={title} empty={`No ${title.toLowerCase()}`} isEmpty={rows.length === 0}>
      <>
        {rows.map((row) => (
          <Link key={row.document_id} to="/documents/$documentId" params={{ documentId: row.document_id }}>
            <span>
              <strong>{row.title ?? 'Deleted document'}</strong>
              <small>{row.current_path ?? row.historical_path ?? row.document_id}</small>
            </span>
            <b>{row.count}</b>
          </Link>
        ))}
      </>
    </InsightList>
  )
}

function rangeLabel(range: ActivitySearch['range']): string {
  return range === '7d'
    ? 'the last 7 days'
    : range === '30d'
      ? 'the last 30 days'
      : range === 'today'
        ? 'today'
        : range === 'custom'
          ? 'the custom range'
          : 'all time'
}
function ActivityTrendChart({
  buckets,
  range,
}: {
  buckets: ActivitySummary['buckets']
  range: ActivitySearch['range']
}) {
  const points = fillDailyBuckets(buckets, range)
  const accepted = points.map((bucket) => bucket.accepted)
  const problems = points.map((bucket) => bucket.denied + bucket.conflict + bucket.failed)
  const maximum = Math.max(1, ...accepted, ...problems)
  return (
    <div className="activity-chart-panel">
      <svg className="activity-chart" viewBox="0 0 720 190" role="img">
        <title>Accepted activity and problems over time</title>
        {[35, 75, 115, 155].map((y) => (
          <line key={y} x1="28" x2="704" y1={y} y2={y} className="activity-chart-grid" />
        ))}
        <path d={linePath(accepted, maximum)} className="activity-chart-line accepted" />
        <path d={linePath(problems, maximum)} className="activity-chart-line problems" />
        {points.map((bucket, index) => (
          <g key={bucket.start}>
            <circle
              cx={chartX(index, points.length)}
              cy={chartY(bucket.accepted, maximum)}
              r="4"
              className="accepted"
            />
            <circle
              cx={chartX(index, points.length)}
              cy={chartY(bucket.denied + bucket.conflict + bucket.failed, maximum)}
              r="4"
              className="problems"
            />
          </g>
        ))}
      </svg>
      <div className="activity-chart-footer">
        <span>{formatBucketDate(points[0]?.start)}</span>
        <div className="activity-chart-legend">
          <span>
            <i className="accepted" />
            Accepted
          </span>
          <span>
            <i className="problems" />
            Problems
          </span>
        </div>
        <span>{formatBucketDate(points.at(-1)?.start)}</span>
      </div>
    </div>
  )
}

function formatBucketDate(value: string | undefined): string {
  return value
    ? new Date(value).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      })
    : ''
}

function chartX(index: number, length: number): number {
  return 28 + (index / Math.max(1, length - 1)) * 676
}

function chartY(value: number, maximum: number): number {
  return 155 - (value / maximum) * 120
}

function linePath(values: number[], maximum: number): string {
  return values
    .map(
      (value, index) =>
        `${index === 0 ? 'M' : 'L'} ${chartX(index, values.length)} ${chartY(value, maximum)}`,
    )
    .join(' ')
}

function fillDailyBuckets(
  buckets: ActivitySummary['buckets'],
  range: ActivitySearch['range'],
): ActivitySummary['buckets'] {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 0
  if (days === 0 || buckets.some((bucket) => !bucket.start.includes('T00:00:00'))) return buckets
  const byDay = new Map(buckets.map((bucket) => [bucket.start.slice(0, 10), bucket]))
  const end = new Date()
  end.setUTCHours(0, 0, 0, 0)
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end)
    date.setUTCDate(end.getUTCDate() - (days - index - 1))
    const start = date.toISOString().replace('.000Z', 'Z')
    return byDay.get(start.slice(0, 10)) ?? { start, accepted: 0, denied: 0, conflict: 0, failed: 0 }
  })
}
