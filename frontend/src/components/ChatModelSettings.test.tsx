// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatModelInfo, ChatModelSettings as ChatModelSettingsData, ProviderConnection } from '../api'

function model(modelId: string, name: string, enabled: boolean): ChatModelInfo {
  return {
    id: `openrouter::${modelId}`,
    model_id: modelId,
    connection_id: 'openrouter',
    connection_name: 'OpenRouter',
    name,
    publisher: modelId.split('/')[0] ?? 'unknown',
    protocol: 'openai_responses',
    compatibility: 'verified',
    supports_tools: true,
    supports_reasoning: true,
    operator_override: false,
    enabled,
  }
}

const snapshot: ChatModelSettingsData = {
  workspace_enabled: true,
  default_model: 'openrouter::openai/gpt-5.4-mini',
  enabled_models: ['openrouter::openai/gpt-5.4-mini', 'openrouter::openai/gpt-5.4-nano'],
  catalog: [
    model('openai/gpt-5.4-mini', 'GPT-5.4 Mini', true),
    model('openai/gpt-5.4-nano', 'GPT-5.4 Nano', true),
    model('openai/gpt-5.4', 'GPT-5.4', false),
  ],
  catalog_fetched_at: null,
  version: 3,
}

const connection: ProviderConnection = {
  connection_id: 'openrouter',
  name: 'OpenRouter',
  preset: 'openrouter',
  protocol: 'openai_responses',
  base_url: 'https://openrouter.ai/api/v1',
  credential_env: 'SANGAM_OPENROUTER_API_KEY',
  credential_present: true,
  enabled: true,
  version: 1,
  status: 'ready',
  last_checked_at: null,
  last_error: null,
}

const runtime = {
  status: 'ready' as const,
  inference_enabled: true,
  message: 'Ready through OpenRouter.',
  transport: 'chatkit' as const,
  transport_status: 'misconfigured' as const,
  transport_message: 'Register this application origin with ChatKit.',
  chat_enabled: false,
  domain_key: 'local-dev',
  default_model: snapshot.default_model,
  available_models: snapshot.catalog,
  reasoning_effort: 'low' as const,
}

const updateChatModels = vi.fn(async (selection: unknown) => {
  void selection
  return snapshot
})
vi.mock('../api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    chatModels: async () => snapshot,
    chatConnections: async () => [connection],
    chatConfig: async () => runtime,
    updateChatModels: (selection: unknown) => updateChatModels(selection),
    updateChatConnection: async () => connection,
    createChatConnection: async () => connection,
    testChatConnection: async () => ({ message: 'Connected', discovered_models: 3 }),
    refreshConnectionModels: async () => snapshot,
  },
}))

import { ChatModelSettings } from './ChatModelSettings'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderPanel() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ChatModelSettings />
    </QueryClientProvider>,
  )
}

describe('ChatModelSettings', () => {
  it('shows connection, protocol, status, and model compatibility', async () => {
    renderPanel()
    await screen.findByText('GPT-5.4 Mini')
    expect(screen.getAllByText('OpenRouter').length).toBeGreaterThan(0)
    expect(screen.getByText('ready')).toBeTruthy()
    expect(screen.getAllByText(/openai responses · verified/i).length).toBeGreaterThan(0)
    expect(screen.getByText('ChatKit browser transport')).toBeTruthy()
    expect(screen.getByText('Needs setup')).toBeTruthy()
    expect(screen.getByText('SANGAM_CHATKIT_DOMAIN_KEY', { exact: false })).toBeTruthy()
  })

  it('saves versioned connection-scoped model selection', async () => {
    renderPanel()
    const row = (await screen.findByText('openai/gpt-5.4')).closest('.chat-model-row')!
    await act(async () => fireEvent.click(row.querySelector('input[type=checkbox]')!))
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /save ai settings/i })))

    await waitFor(() => expect(updateChatModels).toHaveBeenCalledTimes(1))
    expect(updateChatModels).toHaveBeenCalledWith({
      expected_version: 3,
      workspace_enabled: true,
      default_model: 'openrouter::openai/gpt-5.4-mini',
      enabled_models: [
        'openrouter::openai/gpt-5.4-mini',
        'openrouter::openai/gpt-5.4-nano',
        'openrouter::openai/gpt-5.4',
      ],
      unknown_model_overrides: [],
    })
  })

  it('marks a manual model as an explicit compatibility override', async () => {
    renderPanel()
    await screen.findByText('GPT-5.4 Mini')
    fireEvent.change(screen.getByLabelText('Manual model ID'), {
      target: { value: 'meta-llama/llama-3.3-70b-instruct' },
    })
    fireEvent.click(screen.getByRole('button', { name: /add unknown model/i }))
    await screen.findByText('meta-llama/llama-3.3-70b-instruct')
    fireEvent.click(screen.getByRole('button', { name: /save ai settings/i }))

    await waitFor(() => expect(updateChatModels).toHaveBeenCalledTimes(1))
    expect(updateChatModels.mock.calls[0]?.[0]).toMatchObject({
      unknown_model_overrides: ['openrouter::meta-llama/llama-3.3-70b-instruct'],
    })
  })
})
