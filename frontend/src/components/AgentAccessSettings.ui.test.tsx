// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentAccessSettings } from './AgentAccessSettings'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/activity">{children}</a>,
}))

vi.mock('../api', () => ({
  api: {
    listAgentTokens: vi.fn().mockResolvedValue([]),
    issueAgentToken: vi.fn(),
    rotateAgentToken: vi.fn(),
    revokeAgentToken: vi.fn(),
  },
}))

afterEach(() => cleanup())

function renderSettings() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentAccessSettings />
    </QueryClientProvider>,
  )
}

describe('AgentAccessSettings', () => {
  it('starts with an expiring, path-scoped read-only token', () => {
    renderSettings()

    expect(screen.getByRole('button', { name: /Read only/ }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByRole('checkbox', { name: 'read' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'search' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'create' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('read: /agents/**')).not.toBeNull()
    expect(screen.getByText('search: /agents/**')).not.toBeNull()
    expect((screen.getByLabelText(/Expiration/) as HTMLInputElement).value).not.toBe('')
  })

  it('blocks issuance until high-impact capabilities are acknowledged', () => {
    renderSettings()

    fireEvent.click(screen.getByRole('checkbox', { name: 'publish' }))

    expect(screen.getByRole('alert').textContent).toContain('Publish can expose document content')
    expect((screen.getByRole('button', { name: 'Issue token' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(
      screen.getByRole('checkbox', {
        name: 'I understand and intend to grant these high-impact capabilities.',
      }),
    )

    expect((screen.getByRole('button', { name: 'Issue token' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
