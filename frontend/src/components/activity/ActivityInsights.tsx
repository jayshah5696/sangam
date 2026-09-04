import type { UseQueryResult } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  BookOpen,
  FilePenLine,
  RadioTower,
  ShieldAlert,
  Users,
} from 'lucide-react'
import type { ActivitySearch } from '../../activitySearch'
import type { ActivitySummary } from '../../api'
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
              ['Operations', data.counts.operations, 'Unique operation IDs'],
              ['Accepted', data.counts.accepted, 'Accepted events'],
              ['Denied', data.counts.denied, 'Denied access attempts'],
              ['Conflicts', data.counts.conflict, 'Revision or metadata conflicts'],
              ['Failed', data.counts.failed, 'Failed events'],
              ['Active actors', data.counts.active_actors, 'Actors with activity'],
            ].map(([label, value, description]) => (
              <div key={label} title={`${description} in ${rangeLabel(search.range)}`}>
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
              <div>
                <h2 id="needs-attention-title">Needs attention</h2>
                <p>Recent ledger outcomes, not durable incident status.</p>
              </div>
            </div>
            {data.problems.length === 0 ? (
              <StateMessage compact kind="success" title="No problems in this range" />
            ) : (
              data.problems.map((problem) => (
                <article
                  key={`${problem.category}:${problem.actor_id}:${problem.action}:${problem.resource_id ?? problem.path}`}
                  className={`activity-problem ${problem.category}`}
                >
                  <AlertTriangle size="var(--icon-control)" />
                  <div>
                    <strong>
                      {problem.category === 'access'
                        ? 'Access denied'
                        : problem.category === 'conflict'
                          ? 'Revision conflict'
                          : problem.category === 'publication'
                            ? 'Publication failed'
                            : 'Operation failed'}
                    </strong>
                    <p>
                      {problem.actor_display_name} attempted {problem.action} on{' '}
                      {problem.path ? `/${problem.path}` : problem.resource_type}.{' '}
                      {problem.count > 1 ? `${problem.count} occurrences.` : ''}
                    </p>
                    <small>
                      {problem.token_label ? `Token ${problem.token_label} · ` : ''}
                      {problem.capability ? `Capability ${problem.capability} · ` : ''}
                      {problem.error_code ?? 'No error code'}
                    </small>
                    {problem.current_revision_id && problem.expected_revision_id && (
                      <small>
                        Expected revision {problem.expected_revision_id} · current revision{' '}
                        {problem.current_revision_id}
                      </small>
                    )}
                    <small>
                      {problem.count > 1
                        ? `${new Date(problem.first_at).toLocaleString()} to ${new Date(problem.latest_at).toLocaleString()}`
                        : new Date(problem.latest_at).toLocaleString()}
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
                        className="secondary-action"
                        to="/settings"
                        search={{ category: 'agents', destination: problem.token_id }}
                      >
                        Manage access
                      </Link>
                    )}
                    <button
                      type="button"
                      className="secondary-action"
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
                      View events <ArrowRight size="var(--icon-inline)" />
                    </button>
                  </div>
                </article>
              ))
            )}
          </section>

          <section className="activity-insight-section" aria-labelledby="trend-title">
            <div className="activity-section-heading">
              <BarChart3 size="var(--icon-section)" />
              <div>
                <h2 id="trend-title">Activity over time</h2>
                <p>Accepted, denied, conflict, and failed outcomes.</p>
              </div>
            </div>
            {data.buckets.length === 0 ? (
              <StateMessage compact kind="empty" title="No activity to chart" />
            ) : (
              <div className="activity-trend" role="list" aria-label="Activity over time">
                {data.buckets.map((bucket) => {
                  const total = bucket.accepted + bucket.denied + bucket.conflict + bucket.failed
                  const largestBucket = Math.max(
                    ...data.buckets.map(
                      (candidate) =>
                        candidate.accepted + candidate.denied + candidate.conflict + candidate.failed,
                    ),
                  )
                  const height = `${Math.max((total / largestBucket) * 100, 8)}%`
                  return (
                    <button
                      key={bucket.start}
                      type="button"
                      role="listitem"
                      title={`${new Date(bucket.start).toLocaleString()}: ${bucket.accepted} accepted, ${bucket.denied} denied, ${bucket.conflict} conflict, ${bucket.failed} failed`}
                      aria-label={`${new Date(bucket.start).toLocaleString()}: ${total} events`}
                      onClick={() =>
                        onSearchChange({
                          view: 'activity',
                          range: 'custom',
                          since: bucket.start,
                          until: bucketEnd(bucket.start),
                        })
                      }
                    >
                      <span className="activity-trend-stack" style={{ height }}>
                        {bucket.accepted > 0 && (
                          <span className="accepted" style={{ flexGrow: bucket.accepted }} />
                        )}
                        {bucket.denied > 0 && <span className="denied" style={{ flexGrow: bucket.denied }} />}
                        {bucket.conflict > 0 && (
                          <span className="conflict" style={{ flexGrow: bucket.conflict }} />
                        )}
                        {bucket.failed > 0 && <span className="failed" style={{ flexGrow: bucket.failed }} />}
                      </span>
                      <small>
                        {new Date(bucket.start).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                        })}
                      </small>
                    </button>
                  )
                })}
              </div>
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
                      <small>{actor.actor_id}</small>
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
              <div>
                <h2 id="publication-activity-title">Publication activity</h2>
                <p>History here; current state remains in Publications.</p>
              </div>
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
function bucketEnd(start: string): string {
  const date = new Date(start)
  date.setUTCDate(date.getUTCDate() + (start.includes('T00:00:00') ? 1 : 0))
  if (!start.includes('T00:00:00')) date.setUTCHours(date.getUTCHours() + 1)
  return date.toISOString()
}
