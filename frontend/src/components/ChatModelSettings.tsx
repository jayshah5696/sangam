import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Cpu, RefreshCw } from 'lucide-react'
import { api, type ChatModelInfo, type ChatModelSettings as ChatModelSettingsData } from '../api'

function signatureOf(data: ChatModelSettingsData): string {
  return JSON.stringify({
    enabled: data.enabled_models,
    default: data.default_model,
    on: data.openrouter_enabled,
    catalog: data.catalog.map((model) => model.id),
    fetched: data.catalog_fetched_at,
  })
}

function providerLabel(provider: string): string {
  if (provider === 'openai') return 'OpenAI'
  if (provider === 'x-ai') return 'xAI'
  return provider.charAt(0).toUpperCase() + provider.slice(1).replace(/-/g, ' ')
}

export function ChatModelSettings() {
  const queryClient = useQueryClient()
  const models = useQuery({ queryKey: ['chat-models'], queryFn: api.chatModels })

  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  const [defaultModel, setDefaultModel] = useState('')
  const [openrouterEnabled, setOpenrouterEnabled] = useState(true)
  const [search, setSearch] = useState('')
  const syncedSignature = useRef<string | null>(null)

  useEffect(() => {
    if (!models.data) return
    const signature = signatureOf(models.data)
    if (syncedSignature.current === signature) return
    syncedSignature.current = signature
    setEnabled(new Set(models.data.enabled_models))
    setDefaultModel(models.data.default_model)
    setOpenrouterEnabled(models.data.openrouter_enabled)
  }, [models.data])

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['chat-models'] }),
      queryClient.invalidateQueries({ queryKey: ['chat-config'] }),
    ])
  }

  const refresh = useMutation({ mutationFn: api.refreshChatModels, onSuccess: invalidate })
  const save = useMutation({
    mutationFn: () =>
      api.updateChatModels({
        openrouter_enabled: openrouterEnabled,
        default_model: defaultModel,
        enabled_models: [...enabled],
      }),
    onSuccess: invalidate,
  })

  const groups = useMemo(() => {
    const catalog = models.data?.catalog ?? []
    const term = search.trim().toLowerCase()
    const filtered = term
      ? catalog.filter(
          (model) => model.name.toLowerCase().includes(term) || model.id.toLowerCase().includes(term),
        )
      : catalog
    const byProvider = new Map<string, ChatModelInfo[]>()
    for (const model of filtered) {
      const list = byProvider.get(model.provider) ?? []
      list.push(model)
      byProvider.set(model.provider, list)
    }
    return [...byProvider.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [models.data, search])

  const toggleModel = (id: string) => {
    setEnabled((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
        if (defaultModel === id) {
          const fallback = [...next][0] ?? ''
          setDefaultModel(fallback)
        }
      } else {
        next.add(id)
        if (!defaultModel) setDefaultModel(id)
      }
      return next
    })
  }

  const serverSignature = models.data ? signatureOf(models.data) : ''
  const draftSignature = models.data
    ? JSON.stringify({
        enabled: [...enabled],
        default: defaultModel,
        on: openrouterEnabled,
        catalog: models.data.catalog.map((model) => model.id),
        fetched: models.data.catalog_fetched_at,
      })
    : ''
  const dirty = serverSignature !== draftSignature
  const valid = enabled.size > 0 && !!defaultModel && enabled.has(defaultModel)

  const configured = models.data?.openrouter_configured ?? false
  const fetchedAt = models.data?.catalog_fetched_at
  const catalogCount = models.data?.catalog.length ?? 0

  return (
    <section className="settings-panel" id="chat-models">
      <header>
        <Cpu size={18} />
        <div>
          <h2>Workspace chat models</h2>
          <p>Choose which OpenRouter models the chat composer offers and which one is default.</p>
        </div>
        <span className="scope-badge workspace">Shared workspace</span>
      </header>
      <div className="settings-panel-body chat-model-settings">
        <div className="setting-row">
          <div>
            <strong>OpenRouter runtime</strong>
            <small>
              {configured
                ? 'API key detected. Turn the assistant on or off for the whole workspace.'
                : 'Set SANGAM_OPENROUTER_API_KEY to connect the assistant.'}
            </small>
          </div>
          <label className="compact-switch">
            <input
              type="checkbox"
              checked={openrouterEnabled}
              onChange={(event) => setOpenrouterEnabled(event.target.checked)}
            />
            <span>{openrouterEnabled ? 'On' : 'Off'}</span>
          </label>
        </div>

        <div className="setting-row">
          <div>
            <strong>Model catalog</strong>
            <small>
              {catalogCount} model{catalogCount === 1 ? '' : 's'} available
              {fetchedAt ? ` · updated ${new Date(fetchedAt).toLocaleString()}` : ' · curated list'}
            </small>
          </div>
          <button
            className="secondary-action"
            disabled={!configured || refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw size={14} className={refresh.isPending ? 'spin' : ''} />
            {refresh.isPending ? 'Fetching…' : 'Fetch latest models'}
          </button>
        </div>
        {refresh.isError && (
          <p className="operation-result error-text">
            Models could not be fetched: {(refresh.error as Error).message}
          </p>
        )}

        <input
          className="chat-model-search"
          type="search"
          placeholder="Search models"
          aria-label="Search models"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />

        <div className="chat-model-groups">
          {groups.map(([provider, providerModels]) => (
            <div className="chat-model-group" key={provider}>
              <p className="eyebrow">{providerLabel(provider)}</p>
              {providerModels.map((model) => {
                const isEnabled = enabled.has(model.id)
                return (
                  <div className="chat-model-row" key={model.id}>
                    <label className="chat-model-toggle">
                      <input type="checkbox" checked={isEnabled} onChange={() => toggleModel(model.id)} />
                      <span className="chat-model-name">
                        <strong>{model.name}</strong>
                        <small>{model.id}</small>
                      </span>
                    </label>
                    <label
                      className={`chat-model-default ${isEnabled ? '' : 'is-hidden'}`}
                      aria-hidden={!isEnabled}
                    >
                      <input
                        type="radio"
                        name="chat-default-model"
                        checked={defaultModel === model.id}
                        disabled={!isEnabled}
                        onChange={() => setDefaultModel(model.id)}
                      />
                      <span>Default</span>
                    </label>
                  </div>
                )
              })}
            </div>
          ))}
          {groups.length === 0 && <p className="small-muted">No models match your search.</p>}
        </div>

        <div className="chat-model-save">
          {!valid && enabled.size === 0 && (
            <span className="small-muted">Enable at least one model to save.</span>
          )}
          {save.isError && (
            <span className="error-text">Could not save: {(save.error as Error).message}</span>
          )}
          {save.isSuccess && !dirty && (
            <span className="operation-result success">
              <Check size={14} />
              Saved
            </span>
          )}
          <button
            className="primary-button"
            disabled={!dirty || !valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save model selection'}
          </button>
        </div>
      </div>
    </section>
  )
}
