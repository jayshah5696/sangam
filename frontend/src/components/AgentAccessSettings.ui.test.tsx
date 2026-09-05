// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { AgentAccessSettings } from './AgentAccessSettings'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/activity">{children}</a>,
}))

vi.mock('../api', () => ({
  api: {
    listAgentTokens: vi.fn().mockResolvedValue([]),
    issueAgentToken: vi.fn(),
    updateAgentToken: vi.fn(),
    rotateAgentToken: vi.fn(),
    revokeAgentToken: vi.fn(),
  },
}))

afterEach(() => {
  cleanup()
  vi.mocked(api.listAgentTokens).mockResolvedValue([])
  vi.clearAllMocks()
})

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
    // SAFETY: role checkbox renders as an HTMLInputElement in jsdom
    expect((screen.getByRole('checkbox', { name: 'read' }) as HTMLInputElement).checked).toBe(true)
    // SAFETY: role checkbox renders as an HTMLInputElement in jsdom
    expect((screen.getByRole('checkbox', { name: 'search' }) as HTMLInputElement).checked).toBe(true)
    // SAFETY: role checkbox renders as an HTMLInputElement in jsdom
    expect((screen.getByRole('checkbox', { name: 'create' }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByText('read: /agents/**')).not.toBeNull()
    expect(screen.getByText('search: /agents/**')).not.toBeNull()
    // SAFETY: expiration input renders as an HTMLInputElement in jsdom
    expect((screen.getByLabelText(/Expiration/) as HTMLInputElement).value).not.toBe('')
  })

  it('edits active token authority without exposing or rotating the secret', async () => {
    const sampleToken = {
      token_id: 'agt_123',
      actor_id: 'agent:researcher',
      actor_display_name: 'Researcher',
      label: 'Research workspace',
      scopes: [{ capability: 'read' as const, path_prefix: 'agents' }],
      version: 3,
      created_at: '2026-08-20T12:00:00Z',
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      rotated_from_token_id: null,
    }
    vi.mocked(api.listAgentTokens).mockResolvedValue([sampleToken])
    vi.mocked(api.updateAgentToken).mockResolvedValue(sampleToken)
    renderSettings()

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const dialog = document.querySelector<HTMLDialogElement>('[aria-label="Edit Research workspace"]')
    expect(dialog).not.toBeNull()
    expect(screen.getByText('Edit token details')).not.toBeNull()
    fireEvent.change(dialog!.querySelector<HTMLInputElement>('input[required]')!, {
      target: { value: 'Incident reviewer' },
    })
    fireEvent.click(dialog!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!)
    fireEvent.submit(dialog!.querySelector('form')!)

    await waitFor(() =>
      expect(api.updateAgentToken).toHaveBeenCalledWith('agt_123', {
        expected_version: 3,
        label: 'Incident reviewer',
        scopes: [
          { capability: 'read', path_prefix: 'agents' },
          { capability: 'search', path_prefix: null },
        ],
        expires_at: null,
      }),
    )
  })

  it('explains and focuses high-impact confirmation before issuing', async () => {
    renderSettings()

    fireEvent.click(screen.getByRole('checkbox', { name: 'publish' }))
    expect(screen.getByRole('alert').textContent).toContain('Publish can expose document content')

    // SAFETY: button element is an HTMLButtonElement
    const issue = screen.getByRole('button', { name: 'Issue token' }) as HTMLButtonElement
    expect(issue.disabled).toBe(false)
    fireEvent.click(issue)

    const confirmation = screen.getByRole('checkbox', {
      name: 'I understand and intend to grant these high-impact capabilities.',
    })
    expect(screen.getByText('Confirm the high-impact capabilities before issuing this token.')).not.toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(confirmation))

    fireEvent.click(confirmation)
    expect(issue.disabled).toBe(false)
  })

  it('extends and reactivates an expired token with quick duration presets', async () => {
    const expiredToken = {
      token_id: 'agt_expired',
      actor_id: 'agent:researcher',
      actor_display_name: 'Researcher',
      label: 'Research runner',
      scopes: [{ capability: 'read' as const, path_prefix: 'agents' }],
      version: 2,
      created_at: '2026-08-01T12:00:00Z',
      expires_at: '2026-08-08T12:00:00Z',
      revoked_at: null,
      last_used_at: '2026-08-07T12:00:00Z',
      rotated_from_token_id: null,
    }
    vi.mocked(api.listAgentTokens).mockResolvedValue([expiredToken])
    vi.mocked(api.updateAgentToken).mockResolvedValue({
      ...expiredToken,
      version: 3,
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    })
    renderSettings()

    const renewBtn = await screen.findByRole('button', { name: /Renew token/ })
    expect(renewBtn).not.toBeNull()
    fireEvent.click(renewBtn)

    const dialog = document.querySelector<HTMLDialogElement>('[aria-label="Renew Research runner"]')
    expect(dialog).not.toBeNull()
    expect(screen.getByText('Renew agent token')).not.toBeNull()
    expect(screen.getByText(/No runner updates required/)).not.toBeNull()

    const saveBtn = dialog!.querySelector<HTMLButtonElement>('.agent-token-edit-actions button')
    expect(saveBtn?.textContent).toBe('Renew token')

    const thirtyDaysBtn = Array.from(dialog!.querySelectorAll<HTMLButtonElement>('.preset-pill')).find(
      (btn) => btn.textContent?.includes('+30 Days'),
    )
    expect(thirtyDaysBtn).not.toBeUndefined()
    fireEvent.click(thirtyDaysBtn!)

    fireEvent.submit(dialog!.querySelector('form')!)

    await waitFor(() =>
      expect(api.updateAgentToken).toHaveBeenCalledWith(
        'agt_expired',
        expect.objectContaining({
          expected_version: 2,
          label: 'Research runner',
          scopes: [{ capability: 'read', path_prefix: 'agents' }],
        }),
      ),
    )
  })

  it('confirms rotation with explicit consequence warning and manages inactive history', async () => {
    const activeToken = {
      token_id: 'agt_active',
      actor_id: 'agent:researcher',
      actor_display_name: 'Researcher',
      label: 'Research runner',
      scopes: [{ capability: 'read' as const, path_prefix: 'agents' }],
      version: 1,
      created_at: '2026-08-01T12:00:00Z',
      expires_at: '2026-09-01T12:00:00Z',
      revoked_at: null,
      last_used_at: null,
      rotated_from_token_id: 'agt_old',
    }
    const revokedToken = {
      token_id: 'agt_old',
      actor_id: 'agent:researcher',
      actor_display_name: 'Researcher',
      label: 'Research runner',
      scopes: [{ capability: 'read' as const, path_prefix: 'agents' }],
      version: 1,
      created_at: '2026-07-01T12:00:00Z',
      expires_at: '2026-08-01T12:00:00Z',
      revoked_at: '2026-08-01T12:00:00Z',
      last_used_at: null,
      rotated_from_token_id: 'agt_prev',
    }
    vi.mocked(api.listAgentTokens).mockResolvedValue([activeToken, revokedToken])
    vi.mocked(api.rotateAgentToken).mockResolvedValue({
      ...activeToken,
      token_id: 'agt_new',
      token: 'sg_agent_newsecretkey123',
    })

    renderSettings()

    // Main active token is shown
    expect(await screen.findByText(/Research runner/)).not.toBeNull()

    // Revoked token is not in main table by default, but in the history toggle
    const toggleBtn = screen.getByRole('button', { name: /Inactive & rotated tokens \(1\)/ })
    expect(toggleBtn).not.toBeNull()

    // Expanding history reveals the revoked token
    fireEvent.click(toggleBtn)
    expect(screen.getByText(/Rotated predecessor/)).not.toBeNull()

    // Clicking Rotate key... opens the dedicated warning dialog
    const rotateBtn = screen.getByRole('button', { name: /Rotate key…/ })
    fireEvent.click(rotateBtn)

    const rotateDialog = document.querySelector<HTMLDialogElement>(
      '[aria-label="Rotate secret for Research runner"]',
    )
    expect(rotateDialog).not.toBeNull()
    expect(screen.getByText('Rotate secret key')).not.toBeNull()
    expect(screen.getByText(/Immediate runner disruption warning/)).not.toBeNull()

    // Confirm rotation
    const confirmBtn = rotateDialog!.querySelector<HTMLButtonElement>('.agent-token-rotate-actions .danger')
    expect(confirmBtn?.textContent).toContain('Revoke old key & generate new')
    fireEvent.click(confirmBtn!)

    await waitFor(() => expect(api.rotateAgentToken).toHaveBeenCalledWith('agt_active'))
  })
})
