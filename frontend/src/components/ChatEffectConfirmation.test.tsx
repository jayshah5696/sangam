// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEffect } from '../api'
import { parseProjectChange } from '../chatEffectCopy'
import { ChatProjectConfirmation } from './ChatProjectConfirmation'

afterEach(cleanup)

const effect: ChatEffect = {
  effect_id: 'eff_project',
  thread_id: 'thread_1',
  requested_by: 'human:jay',
  capability_id: 'update_project',
  capability_version: 1,
  argument_digest: 'a'.repeat(64),
  preview: { change: { kind: 'create_project', name: 'Atlas', create_brief: false } },
  effect_class: 'write',
  risk: 'workspace',
  status: 'pending_approval',
  expires_at: '2026-08-23T12:00:00Z',
  resource_type: null,
  resource_id: null,
  result: null,
  failure: null,
  created_at: '2026-08-23T11:00:00Z',
  decided_at: null,
  completed_at: null,
}

function renderCard(props: { pending?: boolean; error?: boolean } = {}) {
  const change = parseProjectChange(effect.preview)
  if (!change) throw new Error('fixture preview must parse')
  const onApprove = vi.fn()
  const onCancel = vi.fn()
  render(
    <ChatProjectConfirmation
      effect={effect}
      change={change}
      pending={props.pending ?? false}
      error={props.error ?? false}
      onApprove={onApprove}
      onCancel={onCancel}
    />,
  )
  return { onApprove, onCancel }
}

describe('ChatProjectConfirmation', () => {
  it('names the exact change and lets the reviewer approve or cancel it', () => {
    const { onApprove, onCancel } = renderCard()

    expect(screen.getByRole('alertdialog', { name: /Create project "Atlas"/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve project change' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }))
    expect(onApprove).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('announces a failed decision and blocks a second one while one is in flight', () => {
    renderCard({ pending: true, error: true })

    expect(screen.getByRole('alert').textContent).toContain('The decision could not be completed')
    expect(screen.getByRole('button', { name: 'Applying…' }).hasAttribute('disabled')).toBe(true)
  })
})
