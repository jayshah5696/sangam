// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatModelSettings as ChatModelSettingsData } from '../api'

const snapshot: ChatModelSettingsData = {
  openrouter_configured: true,
  openrouter_enabled: true,
  default_model: 'openai/gpt-5.4-mini',
  enabled_models: ['openai/gpt-5.4-mini', 'openai/gpt-5.4-nano'],
  catalog: [
    { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai', enabled: true },
    { id: 'openai/gpt-5.4-nano', name: 'GPT-5.4 Nano', provider: 'openai', enabled: true },
    { id: 'openai/gpt-5.4', name: 'GPT-5.4', provider: 'openai', enabled: false },
    { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', provider: 'anthropic', enabled: false },
  ],
  catalog_fetched_at: null,
}

const chatModels = vi.fn(async () => snapshot)
const updateChatModels = vi.fn((selection: unknown) => {
  void selection
  return Promise.resolve(snapshot)
})
const refreshChatModels = vi.fn(async () => snapshot)

vi.mock('../api', () => ({
  api: {
    chatModels: () => chatModels(),
    updateChatModels: (selection: unknown) => updateChatModels(selection),
    refreshChatModels: () => refreshChatModels(),
  },
}))

import { ChatModelSettings } from './ChatModelSettings'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ChatModelSettings />
    </QueryClientProvider>,
  )
}

describe('ChatModelSettings', () => {
  it('renders the catalog grouped by provider with the default marked', async () => {
    renderPanel()
    await screen.findByText('GPT-5.4 Mini')
    expect(screen.getByText('OpenAI')).toBeTruthy()
    expect(screen.getByText('Anthropic')).toBeTruthy()
    const defaultRadios = screen.getAllByRole('radio') as HTMLInputElement[]
    // The enabled default model's radio is checked.
    const miniRow = screen.getByText('openai/gpt-5.4-mini').closest('.chat-model-row')!
    expect((miniRow.querySelector('input[type=radio]') as HTMLInputElement).checked).toBe(true)
    expect(defaultRadios.some((radio) => radio.checked)).toBe(true)
  })

  it('enables a model and saves the exact selection payload', async () => {
    renderPanel()
    await screen.findByText('GPT-5.4')
    const gpt54Row = screen.getByText('openai/gpt-5.4').closest('.chat-model-row')!
    const checkbox = gpt54Row.querySelector('input[type=checkbox]') as HTMLInputElement

    await act(async () => {
      fireEvent.click(checkbox)
    })

    const save = screen.getByRole('button', { name: /save model selection/i }) as HTMLButtonElement
    expect(save.disabled).toBe(false)

    await act(async () => {
      fireEvent.click(save)
    })

    await waitFor(() => expect(updateChatModels).toHaveBeenCalledTimes(1))
    expect(updateChatModels).toHaveBeenCalledWith({
      openrouter_enabled: true,
      default_model: 'openai/gpt-5.4-mini',
      enabled_models: ['openai/gpt-5.4-mini', 'openai/gpt-5.4-nano', 'openai/gpt-5.4'],
    })
  })

  it('keeps save disabled until the draft differs from the server', async () => {
    renderPanel()
    await screen.findByText('GPT-5.4 Mini')
    const save = screen.getByRole('button', { name: /save model selection/i }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
  })
})
