import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Cpu, Plus, RefreshCw, ServerCog, TestTube2 } from 'lucide-react'
import {
  ApiError,
  api,
  type ChatModelInfo,
  type ChatModelSettings as ChatModelSettingsData,
  type ProviderConnection,
  type ProviderConnectionInput,
} from '../api'

function settingsSignature(data: ChatModelSettingsData): string {
  return JSON.stringify({
    enabled: data.enabled_models,
    default: data.default_model,
    on: data.workspace_enabled,
    overrides: data.catalog.filter((model) => model.operator_override).map((model) => model.id),
  })
}

const emptyConnection: ProviderConnectionInput & { connection_id: string } = {
  connection_id: '',
  name: '',
  protocol: 'openai_responses',
  base_url: 'https://',
  credential_env: null,
  enabled: true,
}

export function ChatModelSettings() {
  const queryClient = useQueryClient()
  const models = useQuery({ queryKey: ['chat-models'], queryFn: api.chatModels })
  const connections = useQuery({ queryKey: ['chat-connections'], queryFn: api.chatConnections })
  const runtime = useQuery({ queryKey: ['chat-config'], queryFn: api.chatConfig })
  const [newConnection, setNewConnection] = useState(emptyConnection)
  const [enabled, setEnabled] = useState<Set<string>>(new Set())
  const [overrides, setOverrides] = useState<Set<string>>(new Set())
  const [defaultModel, setDefaultModel] = useState('')
  const [workspaceEnabled, setWorkspaceEnabled] = useState(true)
  const [search, setSearch] = useState('')
  const [manualConnection, setManualConnection] = useState('openrouter')
  const [manualModel, setManualModel] = useState('')
  const [manualModels, setManualModels] = useState<ChatModelInfo[]>([])
  const syncedVersion = useRef<number | null>(null)

  useEffect(() => {
    if (!models.data || syncedVersion.current === models.data.version) return
    syncedVersion.current = models.data.version
    setEnabled(new Set(models.data.enabled_models))
    setOverrides(
      new Set(models.data.catalog.filter((model) => model.operator_override).map((model) => model.id)),
    )
    setDefaultModel(models.data.default_model)
    setWorkspaceEnabled(models.data.workspace_enabled)
  }, [models.data])

  const selectedManualConnection = connections.data?.some(
    (connection) => connection.connection_id === manualConnection,
  )
    ? manualConnection
    : (connections.data?.[0]?.connection_id ?? manualConnection)

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['chat-models'] }),
      queryClient.invalidateQueries({ queryKey: ['chat-connections'] }),
      queryClient.invalidateQueries({ queryKey: ['chat-config'] }),
    ])
  }

  const createConnection = useMutation({
    mutationFn: () =>
      api.createChatConnection({
        ...newConnection,
        credential_env: newConnection.credential_env?.trim() || null,
      }),
    onSuccess: async () => {
      setNewConnection(emptyConnection)
      await invalidate()
    },
  })
  const save = useMutation({
    mutationFn: () =>
      api.updateChatModels({
        expected_version: models.data?.version ?? 0,
        workspace_enabled: workspaceEnabled,
        default_model: defaultModel,
        enabled_models: [...enabled],
        unknown_model_overrides: [...overrides],
      }),
    onSuccess: invalidate,
  })

  const addManualModel = (event: FormEvent) => {
    event.preventDefault()
    const modelId = manualModel.trim()
    const connection = connections.data?.find((item) => item.connection_id === selectedManualConnection)
    if (!modelId || !connection) return
    const id = `${connection.connection_id}::${modelId}`
    const model: ChatModelInfo = {
      id,
      model_id: modelId,
      connection_id: connection.connection_id,
      connection_name: connection.name,
      name: modelId.split('/').pop()?.replaceAll('-', ' ') || modelId,
      publisher: modelId.includes('/') ? (modelId.split('/')[0] ?? 'unknown') : 'unknown',
      protocol: connection.protocol,
      compatibility: 'unknown',
      supports_tools: null,
      supports_reasoning: null,
      operator_override: true,
      enabled: true,
    }
    setManualModels((current) => (current.some((item) => item.id === id) ? current : [...current, model]))
    setEnabled((current) => new Set([...current, id]))
    setOverrides((current) => new Set([...current, id]))
    if (!defaultModel) setDefaultModel(id)
    setManualModel('')
  }

  const catalog = useMemo(() => {
    const deduped = new Map<string, ChatModelInfo>()
    for (const model of [...(models.data?.catalog ?? []), ...manualModels]) deduped.set(model.id, model)
    const term = search.trim().toLowerCase()
    return [...deduped.values()].filter(
      (model) =>
        !term ||
        model.name.toLowerCase().includes(term) ||
        model.model_id.toLowerCase().includes(term) ||
        model.connection_name.toLowerCase().includes(term),
    )
  }, [manualModels, models.data, search])

  const groups = useMemo(() => {
    const grouped = new Map<string, ChatModelInfo[]>()
    for (const model of catalog) {
      const list = grouped.get(model.connection_id) ?? []
      list.push(model)
      grouped.set(model.connection_id, list)
    }
    return [...grouped.entries()]
  }, [catalog])

  const toggleModel = (model: ChatModelInfo) => {
    if (model.compatibility === 'unsupported') return
    setEnabled((current) => {
      const next = new Set(current)
      if (next.has(model.id)) {
        next.delete(model.id)
        if (defaultModel === model.id) setDefaultModel([...next][0] ?? '')
      } else {
        next.add(model.id)
        if (model.compatibility === 'unknown') setOverrides((value) => new Set([...value, model.id]))
        if (!defaultModel) setDefaultModel(model.id)
      }
      return next
    })
  }

  if (models.isLoading || connections.isLoading || runtime.isLoading) {
    return (
      <div className="settings-panel center-message" id="chat-models" tabIndex={-1}>
        Loading AI connections…
      </div>
    )
  }
  if (
    models.isError ||
    connections.isError ||
    runtime.isError ||
    !models.data ||
    !connections.data ||
    !runtime.data
  ) {
    return (
      <section className="settings-panel settings-query-error" id="chat-models" tabIndex={-1} role="alert">
        <strong>AI settings could not be loaded.</strong>
        <button
          className="secondary-action"
          onClick={() => void Promise.all([models.refetch(), connections.refetch(), runtime.refetch()])}
        >
          Retry
        </button>
      </section>
    )
  }

  const draftSignature = JSON.stringify({
    enabled: [...enabled],
    default: defaultModel,
    on: workspaceEnabled,
    overrides: [...overrides],
  })
  const dirty = settingsSignature(models.data) !== draftSignature
  const valid = enabled.size > 0 && enabled.has(defaultModel)

  return (
    <section className="settings-panel" id="chat-models" tabIndex={-1}>
      <header>
        <Cpu size="var(--icon-section)" />
        <div>
          <h2>AI connections & models</h2>
          <p>Connect any compatible endpoint, then choose the models available to workspace chat.</p>
        </div>
        <span className="scope-badge workspace">Shared workspace</span>
      </header>
      <div className="settings-panel-body chat-model-settings">
        <div className="setting-row">
          <div>
            <strong>Workspace inference</strong>
            <small>
              Controls model requests. Provider credentials are separate from the ChatKit browser transport.
            </small>
          </div>
          <label className="compact-switch">
            <input
              type="checkbox"
              checked={workspaceEnabled}
              onChange={(event) => setWorkspaceEnabled(event.target.checked)}
            />
            <span>{workspaceEnabled ? 'On' : 'Off'}</span>
          </label>
        </div>

        <div className="setting-row chat-transport-setting">
          <div>
            <strong>ChatKit browser transport</strong>
            <small>{runtime.data.transport_message}</small>
            {runtime.data.transport_status === 'misconfigured' && (
              <code>Set SANGAM_CHATKIT_DOMAIN_KEY on the server, then restart Sangam.</code>
            )}
          </div>
          <span className={`connection-status status-${runtime.data.transport_status}`}>
            {runtime.data.transport_status === 'ready' ? 'Ready' : 'Needs setup'}
          </span>
        </div>

        <div className="connection-list" aria-label="Provider connections">
          {connections.data.map((connection) => (
            <ConnectionCard key={connection.connection_id} connection={connection} onChanged={invalidate} />
          ))}
        </div>

        <details className="agent-advanced-disclosure connection-create">
          <summary>Add an OpenAI-compatible connection</summary>
          <form
            className="connection-form"
            onSubmit={(event) => {
              event.preventDefault()
              createConnection.mutate()
            }}
          >
            <label>
              Connection ID
              <input
                value={newConnection.connection_id}
                placeholder="local-vllm"
                onChange={(event) =>
                  setNewConnection((value) => ({ ...value, connection_id: event.target.value }))
                }
              />
            </label>
            <label>
              Display name
              <input
                value={newConnection.name}
                placeholder="Local vLLM"
                onChange={(event) => setNewConnection((value) => ({ ...value, name: event.target.value }))}
              />
            </label>
            <label>
              API protocol
              <select
                value={newConnection.protocol}
                onChange={(event) =>
                  setNewConnection((value) => ({
                    ...value,
                    protocol: event.target.value as ProviderConnection['protocol'],
                  }))
                }
              >
                <option value="openai_responses">Responses API</option>
                <option value="openai_chat_completions">Chat Completions API</option>
              </select>
            </label>
            <label>
              Base URL
              <input
                value={newConnection.base_url}
                placeholder="https://provider.example/v1"
                onChange={(event) =>
                  setNewConnection((value) => ({ ...value, base_url: event.target.value }))
                }
              />
            </label>
            <label className="connection-credential-field">
              Credential environment variable <span>(optional for local endpoints)</span>
              <input
                value={newConnection.credential_env ?? ''}
                placeholder="MY_PROVIDER_API_KEY"
                onChange={(event) =>
                  setNewConnection((value) => ({ ...value, credential_env: event.target.value || null }))
                }
              />
            </label>
            <button className="secondary-action" disabled={createConnection.isPending}>
              <Plus size="var(--icon-inline)" />
              {createConnection.isPending ? 'Adding…' : 'Add connection'}
            </button>
            {createConnection.isError && (
              <p className="error-text">{(createConnection.error as Error).message}</p>
            )}
          </form>
        </details>

        <div className="settings-subtitle">
          <div>
            <ServerCog size="var(--icon-control)" />
            <strong>Model catalog</strong>
          </div>
          <span>{catalog.length} models</span>
        </div>
        <form className="chat-model-add" onSubmit={addManualModel}>
          <select
            aria-label="Manual model connection"
            value={selectedManualConnection}
            onChange={(event) => setManualConnection(event.target.value)}
          >
            {connections.data.map((connection) => (
              <option key={connection.connection_id} value={connection.connection_id}>
                {connection.name}
              </option>
            ))}
          </select>
          <input
            value={manualModel}
            placeholder="Manual model ID"
            aria-label="Manual model ID"
            onChange={(event) => setManualModel(event.target.value)}
          />
          <button className="secondary-action" disabled={!manualModel.trim()}>
            <Plus size="var(--icon-inline)" /> Add unknown model
          </button>
        </form>
        <p className="small-muted">
          Manual models are marked unknown. Enabling one records an explicit operator override.
        </p>
        <input
          className="chat-model-search"
          type="search"
          placeholder="Search models or connections"
          aria-label="Search models or connections"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />

        <div className="chat-model-groups">
          {groups.map(([connectionId, connectionModels]) => (
            <div className="chat-model-group" key={connectionId}>
              <p className="eyebrow">{connectionModels[0]?.connection_name ?? connectionId}</p>
              {connectionModels.map((model) => {
                const isEnabled = enabled.has(model.id)
                return (
                  <div className={`chat-model-row compatibility-${model.compatibility}`} key={model.id}>
                    <label className="chat-model-toggle">
                      <input
                        type="checkbox"
                        checked={isEnabled}
                        disabled={model.compatibility === 'unsupported'}
                        onChange={() => toggleModel(model)}
                      />
                      <span className="chat-model-name">
                        <strong>{model.name}</strong>
                        <small>{model.model_id}</small>
                        <i>
                          {model.protocol.replaceAll('_', ' ')} · {model.compatibility}
                        </i>
                      </span>
                    </label>
                    <label className={`chat-model-default ${isEnabled ? '' : 'is-hidden'}`}>
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
          {save.isError && (
            <span className="error-text">
              {save.error instanceof ApiError && save.error.status === 409
                ? 'Settings changed elsewhere. Reload before saving.'
                : save.error.message}
            </span>
          )}
          {save.isSuccess && !dirty && (
            <span className="operation-result success">
              <Check size="var(--icon-inline)" /> Saved
            </span>
          )}
          <button
            className="primary-button"
            disabled={!dirty || !valid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save AI settings'}
          </button>
        </div>
      </div>
    </section>
  )
}

function ConnectionCard({
  connection,
  onChanged,
}: {
  connection: ProviderConnection
  onChanged: () => Promise<void>
}) {
  const [draft, setDraft] = useState<ProviderConnectionInput>({
    name: connection.name,
    protocol: connection.protocol,
    base_url: connection.base_url,
    credential_env: connection.credential_env,
    enabled: connection.enabled,
  })
  const save = useMutation({
    mutationFn: () => api.updateChatConnection(connection, draft),
    onSuccess: onChanged,
  })
  const test = useMutation({
    mutationFn: () => api.testChatConnection(connection.connection_id),
    onSuccess: onChanged,
  })
  const refresh = useMutation({
    mutationFn: () => api.refreshConnectionModels(connection.connection_id),
    onSuccess: onChanged,
  })
  const dirty =
    JSON.stringify(draft) !==
    JSON.stringify({
      name: connection.name,
      protocol: connection.protocol,
      base_url: connection.base_url,
      credential_env: connection.credential_env,
      enabled: connection.enabled,
    })
  return (
    <article className="connection-card">
      <div className="connection-card-heading">
        <div>
          <strong>{connection.name}</strong>
          <code>{connection.connection_id}</code>
        </div>
        <span className={`connection-status status-${connection.status}`}>
          {connection.status.replace('_', ' ')}
        </span>
      </div>
      <div className="connection-fields">
        <label>
          Name
          <input
            value={draft.name}
            onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
          />
        </label>
        <label>
          Protocol
          <select
            value={draft.protocol}
            onChange={(event) =>
              setDraft((value) => ({
                ...value,
                protocol: event.target.value as ProviderConnection['protocol'],
              }))
            }
          >
            <option value="openai_responses">Responses API</option>
            <option value="openai_chat_completions">Chat Completions API</option>
          </select>
        </label>
        <label>
          Base URL
          <input
            value={draft.base_url}
            onChange={(event) => setDraft((value) => ({ ...value, base_url: event.target.value }))}
          />
        </label>
        <label>
          Credential environment variable
          <input
            value={draft.credential_env ?? ''}
            onChange={(event) =>
              setDraft((value) => ({ ...value, credential_env: event.target.value || null }))
            }
          />
        </label>
      </div>
      <div className="connection-actions">
        <label className="compact-switch">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft((value) => ({ ...value, enabled: event.target.checked }))}
          />
          <span>{draft.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
        <button className="secondary-action" disabled={test.isPending || dirty} onClick={() => test.mutate()}>
          <TestTube2 size="var(--icon-inline)" /> {test.isPending ? 'Testing…' : 'Test'}
        </button>
        <button
          className="secondary-action"
          disabled={refresh.isPending || dirty}
          onClick={() => refresh.mutate()}
        >
          <RefreshCw size="var(--icon-inline)" className={refresh.isPending ? 'spin' : ''} />
          {refresh.isPending ? 'Discovering…' : 'Discover models'}
        </button>
        <button className="primary-button" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save connection'}
        </button>
      </div>
      {!connection.credential_present && connection.credential_env && (
        <small>Credential missing. Set {connection.credential_env} on the server and restart.</small>
      )}
      {connection.last_error && <small className="error-text">{connection.last_error}</small>}
      {test.isSuccess && <small className="operation-result success">{test.data.message}</small>}
      {(test.isError || refresh.isError || save.isError) && (
        <small className="error-text">{(test.error ?? refresh.error ?? save.error)?.message}</small>
      )}
    </article>
  )
}
