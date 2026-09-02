import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { AlertTriangle, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react'
import type { ChatEffect, ChatEffectsSummary } from '../api'

export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

export function formatAttentionSummary(summary: {
  recovering_active: number
  retryable_failures: number
  terminal_failures: number
}): string {
  const parts: string[] = []
  if (summary.recovering_active > 0) {
    parts.push(
      `${summary.recovering_active} active recovery${summary.recovering_active === 1 ? '' : ' items'}`,
    )
  }
  if (summary.retryable_failures > 0) {
    parts.push(`${summary.retryable_failures} retry available`)
  }
  if (summary.terminal_failures > 0) {
    parts.push(`${summary.terminal_failures} failed plan${summary.terminal_failures === 1 ? '' : 's'}`)
  }
  return parts.join(', ') || 'Pending attention'
}

export function formatHistorySummary(creations: number, publications: number, plans: number): string {
  const parts = [
    creations ? `${creations} document${creations === 1 ? '' : 's'} created` : '',
    publications ? `${publications} publication${publications === 1 ? '' : 's'} completed` : '',
    plans ? `${plans} organization plan${plans === 1 ? '' : 's'} applied` : '',
  ].filter(Boolean)
  return parts.join(' · ') || 'Recorded history'
}

export function DurableEffectStatus({
  effect,
  resuming,
  resumeFailed,
  dismissing = false,
  onResume,
  onDismiss,
}: {
  effect: ChatEffect
  resuming: boolean
  resumeFailed: boolean
  dismissing?: boolean
  onResume: () => void
  onDismiss?: () => void
}) {
  const effectResultSchema = z.object({ url: z.string().optional() })
  const failed = effect.status === 'failed'
  const retrySafe = effect.failure?.retry_safe === true
  const interrupted = effect.status === 'approved' || effect.status === 'executing'
  const canResume = interrupted || (failed && retrySafe)
  const noun =
    effect.capability_id === 'publish_document'
      ? 'Publication'
      : effect.capability_id === 'apply_workspace_organization_plan'
        ? 'Organization plan'
        : 'Document creation'
  const href =
    effectResultSchema.safeParse(effect.result).data?.url ??
    (effect.capability_id === 'create_document' && effect.resource_id
      ? `/documents/${effect.resource_id}`
      : undefined)

  let failureDetail = ''
  if (failed) {
    const rawMessage = String(effect.failure?.message ?? 'The effect could not be completed.')
    if (retrySafe) {
      failureDetail = `${rawMessage} This transient failure is safe to retry with the same approved parameters.`
    } else if (effect.capability_id === 'apply_workspace_organization_plan') {
      failureDetail = `${rawMessage} The workspace changed or the plan was invalid. Inspect current state and prepare a new request. A new review is required.`
    } else if (effect.capability_id === 'publish_document') {
      failureDetail = `${rawMessage} The document could not be published at that slug. Check permissions and slug availability. A new review is required.`
    } else if (effect.capability_id === 'create_document') {
      failureDetail = `${rawMessage} The document could not be created at that path. Check for collisions or invalid extensions. A new review is required.`
    } else {
      failureDetail = `${rawMessage} A new review is required.`
    }
  }

  let completedDetail = `Recorded effect ${shortId(effect.effect_id)}`
  if (effect.status === 'completed') {
    if (effect.capability_id === 'create_document') {
      completedDetail = `The document was created and is open in the workspace. Recorded effect ${shortId(effect.effect_id)}`
    } else if (effect.capability_id === 'publish_document') {
      completedDetail = `The document is published. Recorded effect ${shortId(effect.effect_id)}`
    } else if (effect.capability_id === 'apply_workspace_organization_plan') {
      completedDetail = `The organization plan was applied successfully. Recorded effect ${shortId(effect.effect_id)}`
    }
  }

  return (
    <div
      className={`chat-effect-complete ${failed || interrupted ? 'is-failed' : ''}`}
      role={failed || resumeFailed ? 'alert' : 'status'}
      data-effect-id={effect.effect_id}
    >
      <div className="chat-effect-complete-copy">
        <strong>
          {interrupted ? 'Approved effect ready to resume' : failed ? `${noun} failed` : `${noun} completed`}
        </strong>
        <span>
          {resumeFailed
            ? 'Resume failed. The stored operation key makes another attempt safe.'
            : interrupted
              ? 'An interrupted effect must be resumed or retried before continuing. The exact approval is stored. Resume with the original operation key.'
              : failed
                ? failureDetail
                : completedDetail}
        </span>
      </div>
      <div className="chat-effect-complete-actions">
        {canResume && (
          <button type="button" className="secondary-action" disabled={resuming} onClick={onResume}>
            {resuming ? 'Resuming…' : failed ? 'Retry safely' : 'Resume safely'}
          </button>
        )}
        {failed && onDismiss && (
          <button type="button" className="secondary-action" disabled={dismissing} onClick={onDismiss}>
            {dismissing ? 'Dismissing…' : 'Dismiss'}
          </button>
        )}
        {href && (
          <a className="secondary-action" href={href}>
            <ExternalLink size="var(--icon-inline)" />
            Open result
          </a>
        )}
      </div>
    </div>
  )
}

export interface ChatEffectTrayProps {
  attentionEffects: ChatEffect[]
  summary?: ChatEffectsSummary
  resumingEffectId: string | null
  resumeErrorIds: Set<string>
  dismissingEffectId: string | null
  onResume: (effect: ChatEffect) => void
  onDismiss: (effect: ChatEffect) => void
  onClearResolved?: () => void
  clearingResolved?: boolean
  historyEffects?: ChatEffect[]
  hasMoreHistory?: boolean
  loadingHistory?: boolean
  onLoadMoreHistory?: () => void
  onOpenHistory?: () => void
}

export function ChatEffectTray({
  attentionEffects,
  summary,
  resumingEffectId,
  resumeErrorIds,
  dismissingEffectId,
  onResume,
  onDismiss,
  onClearResolved,
  clearingResolved = false,
  historyEffects = [],
  hasMoreHistory = false,
  loadingHistory = false,
  onLoadMoreHistory,
  onOpenHistory,
}: ChatEffectTrayProps) {
  const [isOpen, setIsOpen] = useState(false)
  const disclosureRef = useRef<HTMLButtonElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const announcedFailureIdsRef = useRef<Set<string>>(new Set())
  const [announcement, setAnnouncement] = useState<string>('')
  const headingId = useId()

  // Track and announce new failures once
  useEffect(() => {
    const unannounced = attentionEffects.filter(
      (effect) => effect.status === 'failed' && !announcedFailureIdsRef.current.has(effect.effect_id),
    )
    if (unannounced.length > 0) {
      unannounced.forEach((effect) => announcedFailureIdsRef.current.add(effect.effect_id))
      setAnnouncement(
        `${unannounced.length} new failed effect${unannounced.length === 1 ? '' : 's'} require attention`,
      )
    }
  }, [attentionEffects])

  const attentionItems = useMemo(() => {
    return attentionEffects.filter((e) => e.status !== 'completed' && !e.acknowledged_at)
  }, [attentionEffects])

  const historyItems = useMemo(() => {
    const fromAttention = attentionEffects.filter(
      (e) => e.status === 'completed' || Boolean(e.acknowledged_at),
    )
    const existingIds = new Set(fromAttention.map((e) => e.effect_id))
    const additional = historyEffects.filter((h) => !existingIds.has(h.effect_id))
    return [...fromAttention, ...additional]
  }, [attentionEffects, historyEffects])

  const totalAttention = summary?.total_attention ?? attentionItems.length
  const totalHistory = summary?.total_history ?? historyItems.length

  const sortedAttention = useMemo(() => {
    return [...attentionItems].sort((a, b) => {
      const score = (effect: ChatEffect) => {
        if (effect.status === 'approved' || effect.status === 'executing') return 1
        if (effect.status === 'failed' && effect.failure?.retry_safe) return 2
        if (effect.status === 'failed') return 3
        return 4
      }
      return score(a) - score(b)
    })
  }, [attentionItems])

  const eligibleForClear = useMemo(() => {
    return sortedAttention.filter((effect) => effect.status === 'failed')
  }, [sortedAttention])

  const attentionSummaryText = useMemo(() => {
    if (summary) {
      return formatAttentionSummary(summary)
    }
    const recovering = sortedAttention.filter(
      (e) => e.status === 'approved' || e.status === 'executing',
    ).length
    const retryable = sortedAttention.filter((e) => e.status === 'failed' && e.failure?.retry_safe).length
    const terminal = sortedAttention.filter((e) => e.status === 'failed' && !e.failure?.retry_safe).length
    return formatAttentionSummary({
      recovering_active: recovering,
      retryable_failures: retryable,
      terminal_failures: terminal,
    })
  }, [summary, sortedAttention])

  const historySummaryText = useMemo(() => {
    const creations = historyItems.filter(
      (e) => e.capability_id === 'create_document' && e.status === 'completed',
    ).length
    const publications = historyItems.filter(
      (e) => e.capability_id === 'publish_document' && e.status === 'completed',
    ).length
    const plans = historyItems.filter(
      (e) => e.capability_id === 'apply_workspace_organization_plan' && e.status === 'completed',
    ).length
    return formatHistorySummary(creations, publications, plans)
  }, [historyItems])

  const handleDismiss = useCallback(
    (effect: ChatEffect) => {
      const currentIndex = sortedAttention.findIndex((e) => e.effect_id === effect.effect_id)
      const nextEffect = sortedAttention[currentIndex + 1] ?? sortedAttention[currentIndex - 1]
      onDismiss(effect)
      setTimeout(() => {
        if (nextEffect) {
          const nextElement = containerRef.current?.querySelector<HTMLButtonElement>(
            `[data-effect-id="${nextEffect.effect_id}"] button`,
          )
          if (nextElement) {
            nextElement.focus()
            return
          }
        }
        disclosureRef.current?.focus()
      }, 50)
    },
    [sortedAttention, onDismiss],
  )

  const handleClearResolved = useCallback(() => {
    if (onClearResolved) {
      onClearResolved()
      setTimeout(() => {
        disclosureRef.current?.focus()
      }, 50)
    }
  }, [onClearResolved])

  if (totalAttention === 0 && totalHistory === 0) {
    return null
  }

  return (
    <div className="chat-effect-history" ref={containerRef}>
      {announcement && (
        <div className="chat-effect-live-announcer" role="status" aria-live="polite">
          {announcement}
        </div>
      )}
      {totalAttention > 0 && (
        <section
          className={`chat-effect-tray ${isOpen ? 'is-expanded' : 'is-collapsed'}`}
          aria-labelledby={headingId}
        >
          <div className="chat-effect-tray-header">
            <button
              ref={disclosureRef}
              type="button"
              id={headingId}
              className="chat-effect-tray-disclosure"
              aria-expanded={isOpen}
              aria-label={`Attention required: ${attentionSummaryText}. ${isOpen ? 'Collapse' : 'Expand'} tray`}
              onClick={() => setIsOpen((prev) => !prev)}
            >
              <AlertTriangle size="var(--icon-inline)" aria-hidden="true" />
              <span>{attentionSummaryText}</span>
              {isOpen ? (
                <ChevronUp size="var(--icon-inline)" aria-hidden="true" />
              ) : (
                <ChevronDown size="var(--icon-inline)" aria-hidden="true" />
              )}
            </button>
            {isOpen && eligibleForClear.length >= 2 && onClearResolved && (
              <button
                type="button"
                className="secondary-action chat-effect-clear-btn"
                onClick={handleClearResolved}
                disabled={clearingResolved}
              >
                {clearingResolved ? 'Clearing…' : 'Clear resolved failures'}
              </button>
            )}
          </div>
          {isOpen && (
            <div className="chat-effect-tray-scroll" role="region" aria-label="Attention effects list">
              {sortedAttention.map((effect) => (
                <DurableEffectStatus
                  key={effect.effect_id}
                  effect={effect}
                  resuming={resumingEffectId === effect.effect_id}
                  resumeFailed={resumeErrorIds.has(effect.effect_id)}
                  dismissing={dismissingEffectId === effect.effect_id}
                  onResume={() => onResume(effect)}
                  onDismiss={() => handleDismiss(effect)}
                />
              ))}
            </div>
          )}
        </section>
      )}
      {totalHistory > 0 && (
        <details
          className="chat-effect-stack chat-effect-history-section"
          onToggle={(e) => {
            // SAFETY: target is the HTMLDetailsElement onToggle event
            const details = e.currentTarget as HTMLDetailsElement
            if (details.open && onOpenHistory) {
              onOpenHistory()
            }
          }}
        >
          <summary>
            <span>
              <strong>{historySummaryText}</strong>
              <small>Completed effects are collapsed to keep the conversation visible.</small>
            </span>
            <ChevronDown size="var(--icon-inline)" aria-hidden="true" />
          </summary>
          <div>
            {historyItems.map((effect) => (
              <DurableEffectStatus
                key={effect.effect_id}
                effect={effect}
                resuming={resumingEffectId === effect.effect_id}
                resumeFailed={resumeErrorIds.has(effect.effect_id)}
                onResume={() => onResume(effect)}
              />
            ))}
            {hasMoreHistory && onLoadMoreHistory && (
              <button
                type="button"
                className="secondary-action load-more-history-btn"
                onClick={onLoadMoreHistory}
                disabled={loadingHistory}
              >
                {loadingHistory ? 'Loading…' : 'Load older history'}
              </button>
            )}
          </div>
        </details>
      )}
    </div>
  )
}
