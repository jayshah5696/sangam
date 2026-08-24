// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatEffect } from '../api'
import { chatRequestNeedsTurnContext, CompactChatControls, DurableEffectStatus } from './ChatPanel'

afterEach(cleanup)

it('exposes accessible compact controls for a new chat and thread history', () => {
  const onNewChat = vi.fn()
  const onShowHistory = vi.fn()

  render(<CompactChatControls onNewChat={onNewChat} onShowHistory={onShowHistory} />)

  const newChat = screen.getByRole('button', { name: 'New chat' })
  const history = screen.getByRole('button', { name: 'Chat history' })
  expect(newChat.getAttribute('title')).toBe('New chat')
  expect(history.getAttribute('title')).toBe('Chat history')

  fireEvent.click(newChat)
  fireEvent.click(history)
  expect(onNewChat).toHaveBeenCalledOnce()
  expect(onShowHistory).toHaveBeenCalledOnce()
})

it('captures turn context only for requests that add a user message', () => {
  expect(chatRequestNeedsTurnContext(JSON.stringify({ type: 'threads.create' }))).toBe(true)
  expect(chatRequestNeedsTurnContext(JSON.stringify({ type: 'threads.add_user_message' }))).toBe(true)
  expect(chatRequestNeedsTurnContext(JSON.stringify({ type: 'threads.get_by_id' }))).toBe(false)
  expect(chatRequestNeedsTurnContext('not-json')).toBe(false)
})

it('offers a safe recovery action only when the durable effect permits it', () => {
  const onResume = vi.fn()
  const effect: ChatEffect = {
    effect_id: 'eff_interrupted',
    thread_id: 'thread_1',
    requested_by: 'human:jay',
    capability_id: 'create_document',
    capability_version: 1,
    argument_digest: 'a'.repeat(64),
    preview: { title: 'Recovered note' },
    effect_class: 'write',
    risk: 'workspace',
    status: 'executing',
    expires_at: '2026-08-23T12:00:00Z',
    resource_type: null,
    resource_id: null,
    result: null,
    failure: null,
    created_at: '2026-08-23T11:00:00Z',
    decided_at: '2026-08-23T11:01:00Z',
    completed_at: null,
  }

  render(<DurableEffectStatus effect={effect} resuming={false} resumeFailed={false} onResume={onResume} />)
  fireEvent.click(screen.getByRole('button', { name: 'Resume safely' }))
  expect(onResume).toHaveBeenCalledOnce()
  cleanup()

  render(
    <DurableEffectStatus
      effect={{ ...effect, status: 'failed', failure: { message: 'Conflict', retry_safe: false } }}
      resuming={false}
      resumeFailed={false}
      onResume={onResume}
    />,
  )
  expect(screen.queryByRole('button', { name: 'Retry safely' })).toBeNull()
  expect(screen.getByText(/A new review is required/)).toBeTruthy()
})
