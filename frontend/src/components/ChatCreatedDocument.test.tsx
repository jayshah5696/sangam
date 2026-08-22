// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '../api'

const state = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('@openai/chatkit-react', () => ({ ChatKit: () => null, useChatKit: () => ({ control: {} }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }))
vi.mock('../theme', () => ({ useTheme: () => ({ preferences: { theme: 'river' } }) }))
vi.mock('./RevisionMergeView', () => ({ RevisionMergeView: () => null }))

import { CompletionRow, CreatedFromChat } from './ChatPanel'

afterEach(cleanup)

describe('CreatedFromChat', () => {
  it('keeps chat mounted and lets the user open the created document explicitly', () => {
    state.navigate.mockReset()
    const queryClient = new QueryClient()
    const document = {
      document_id: 'doc-created-12345678',
      title: 'Created note',
    } as Document

    render(
      <QueryClientProvider client={queryClient}>
        <CreatedFromChat document={document} onDismiss={vi.fn()} />
      </QueryClientProvider>,
    )

    expect(screen.getByText('Document created')).toBeTruthy()
    expect(screen.getByText(/“Created note”/)).toBeTruthy()
    expect(screen.getByText(/doc-crea…5678/)).toBeTruthy()
    expect(state.navigate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open document' }))
    expect(state.navigate).toHaveBeenCalledWith({ href: '/documents/doc-created-12345678' })
  })

  it('uses the same grouped controls for publication results', () => {
    const onDismiss = vi.fn()
    render(
      <CompletionRow
        label="Publication created"
        detail="public"
        openLabel="Open publication"
        href="/p/example"
        onDismiss={onDismiss}
      />,
    )

    const actions = screen.getByRole('status').querySelector('.chat-effect-complete-actions')
    expect(actions?.children).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Open publication' }).getAttribute('class')).toContain(
      'secondary-action',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
