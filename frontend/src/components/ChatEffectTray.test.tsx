// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEffect, ChatEffectsSummary } from '../api'
import { ChatEffectTray, formatAttentionSummary, formatHistorySummary } from './ChatEffectTray'

afterEach(cleanup)

function makeEffect(overrides: Partial<ChatEffect>): ChatEffect {
  return {
    effect_id: 'eff_1',
    thread_id: 'thread_1',
    requested_by: 'human:jay',
    capability_id: 'create_document',
    capability_version: 1,
    argument_digest: 'a'.repeat(64),
    preview: { title: 'Test Document' },
    effect_class: 'write',
    risk: 'workspace',
    status: 'failed',
    expires_at: '2026-08-23T12:00:00Z',
    resource_type: null,
    resource_id: null,
    result: null,
    failure: {
      code: 'effect_failed',
      message: 'Workspace document collision',
      retry_safe: false,
    },
    created_at: '2026-08-23T11:00:00Z',
    decided_at: '2026-08-23T11:01:00Z',
    completed_at: null,
    acknowledged_at: null,
    acknowledged_by: null,
    ...overrides,
  }
}

describe('ChatEffectTray summary formatters', () => {
  it('formats attention summary string accurately', () => {
    expect(
      formatAttentionSummary({
        recovering_active: 0,
        retryable_failures: 1,
        terminal_failures: 2,
      }),
    ).toBe('1 retry available, 2 failed plans')

    expect(
      formatAttentionSummary({
        recovering_active: 1,
        retryable_failures: 0,
        terminal_failures: 0,
      }),
    ).toBe('1 active recovery')
  })

  it('formats history summary string accurately', () => {
    expect(formatHistorySummary(1, 2, 3)).toBe(
      '1 document created · 2 publications completed · 3 organization plans applied',
    )
  })
})

describe('ChatEffectTray component behavior', () => {
  it('renders nothing when there is no attention required and no history', () => {
    const { container } = render(
      <ChatEffectTray
        attentionEffects={[]}
        resumingEffectId={null}
        resumeErrorIds={new Set()}
        dismissingEffectId={null}
        onResume={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders collapsed disclosure row and expands on click', () => {
    const effect = makeEffect({
      effect_id: 'eff_fail',
      failure: { code: 'net_err', message: 'Transient network error', retry_safe: true },
    })

    render(
      <ChatEffectTray
        attentionEffects={[effect]}
        resumingEffectId={null}
        resumeErrorIds={new Set()}
        dismissingEffectId={null}
        onResume={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    const disclosure = screen.getByRole('button', { name: /Attention required/i })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')

    // Click to expand
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('region', { name: 'Attention effects list' })).toBeDefined()
    expect(screen.getByText(/Transient network error/)).toBeDefined()
  })

  it('sorts active recovery items before retryable failures, before terminal failures', () => {
    const active = makeEffect({
      effect_id: 'eff_active',
      status: 'approved',
      failure: null,
    })
    const retryable = makeEffect({
      effect_id: 'eff_retry',
      status: 'failed',
      failure: { message: 'Retryable network timeout', retry_safe: true },
    })
    const terminal = makeEffect({
      effect_id: 'eff_term',
      status: 'failed',
      failure: { message: 'Deterministic validation error', retry_safe: false },
    })

    // Pass in reverse order
    render(
      <ChatEffectTray
        attentionEffects={[terminal, active, retryable]}
        resumingEffectId={null}
        resumeErrorIds={new Set()}
        dismissingEffectId={null}
        onResume={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    // Expand tray
    fireEvent.click(screen.getByRole('button', { name: /Attention required/i }))

    const titles = screen.getAllByRole('strong').map((el) => el.textContent)
    expect(titles).toEqual([
      'Approved effect ready to resume',
      'Document creation failed',
      'Document creation failed',
    ])

    // Active item shows "Approved effect ready to resume"
    expect(screen.getByText('Approved effect ready to resume')).toBeDefined()
    // Retryable offers "Retry safely"
    expect(screen.getByRole('button', { name: 'Retry safely' })).toBeDefined()
  })

  it('provides Dismiss action and invokes onDismiss callback', () => {
    const onDismiss = vi.fn()
    const effect = makeEffect({
      effect_id: 'eff_dismiss',
      status: 'failed',
      failure: { message: 'Terminal failure', retry_safe: false },
    })

    render(
      <ChatEffectTray
        attentionEffects={[effect]}
        resumingEffectId={null}
        resumeErrorIds={new Set()}
        dismissingEffectId={null}
        onResume={vi.fn()}
        onDismiss={onDismiss}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Attention required/i }))
    const dismissBtn = screen.getByRole('button', { name: 'Dismiss' })
    fireEvent.click(dismissBtn)

    expect(onDismiss).toHaveBeenCalledWith(effect)
  })

  it('shows Clear resolved failures when 2 or more eligible failures exist', () => {
    const onClearResolved = vi.fn()
    const effect1 = makeEffect({ effect_id: 'eff_1', status: 'failed' })
    const effect2 = makeEffect({ effect_id: 'eff_2', status: 'failed' })

    render(
      <ChatEffectTray
        attentionEffects={[effect1, effect2]}
        resumingEffectId={null}
        resumeErrorIds={new Set()}
        dismissingEffectId={null}
        onResume={vi.fn()}
        onDismiss={vi.fn()}
        onClearResolved={onClearResolved}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Attention required/i }))
    const clearBtn = screen.getByRole('button', { name: 'Clear resolved failures' })
    expect(clearBtn).toBeDefined()

    fireEvent.click(clearBtn)
    expect(onClearResolved).toHaveBeenCalledOnce()
  })

  it('uses summary data from server when provided', () => {
    const summary: ChatEffectsSummary = {
      thread_id: 'thread_1',
      total_attention: 3,
      recovering_active: 0,
      retryable_failures: 1,
      terminal_failures: 2,
      total_history: 10,
    }

    render(
      <ChatEffectTray
        attentionEffects={[]}
        summary={summary}
        resumingEffectId={null}
        resumeErrorIds={new Set()}
        dismissingEffectId={null}
        onResume={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('1 retry available, 2 failed plans')).toBeDefined()
  })

  it('announces newly arrived failures once via live region', () => {
    const effect = makeEffect({ effect_id: 'eff_announced', status: 'failed' })

    const { rerender } = render(
      <ChatEffectTray
        attentionEffects={[]}
        resumingEffectId={null}
        resumeErrorIds={new Set()}
        dismissingEffectId={null}
        onResume={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    // Initially no announcement
    expect(screen.queryByRole('status')).toBeNull()

    // Add failure
    act(() => {
      rerender(
        <ChatEffectTray
          attentionEffects={[effect]}
          resumingEffectId={null}
          resumeErrorIds={new Set()}
          dismissingEffectId={null}
          onResume={vi.fn()}
          onDismiss={vi.fn()}
        />,
      )
    })

    // Now polite announcer has the message
    expect(screen.getByText(/1 new failed effect require attention/)).toBeDefined()
  })

  it('renders history section and supports loading older history', () => {
    const onLoadMore = vi.fn()
    const onOpen = vi.fn()
    const historyEffect = makeEffect({
      effect_id: 'eff_hist_1',
      status: 'completed',
      capability_id: 'create_document',
      resource_id: 'doc_1',
    })

    render(
      <ChatEffectTray
        attentionEffects={[]}
        historyEffects={[historyEffect]}
        hasMoreHistory={true}
        onLoadMoreHistory={onLoadMore}
        onOpenHistory={onOpen}
        resumingEffectId={null}
        resumeErrorIds={new Set()}
        dismissingEffectId={null}
        onResume={vi.fn()}
        onDismiss={vi.fn()}
      />,
    )

    expect(screen.getByText('1 document created')).toBeDefined()
    expect(
      screen.getByText('Completed effects are collapsed to keep the conversation visible.'),
    ).toBeDefined()

    const loadMoreBtn = screen.getByRole('button', { name: 'Load older history' })
    fireEvent.click(loadMoreBtn)
    expect(onLoadMore).toHaveBeenCalledOnce()
  })
})
