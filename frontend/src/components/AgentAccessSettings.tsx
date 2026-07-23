import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Bot, KeyRound, RefreshCw, ShieldOff } from 'lucide-react'
import { api, type IssuedAgentToken, type TokenScope } from '../api'
import { OneTimeSecret } from './OneTimeSecret'

type Capability = TokenScope['capability']

export type ScopePrefixes = {
  read: string
  search: string
  write: string
}

export type TokenPresetId = 'read-only' | 'scoped-writer'

const capabilities: Capability[] = [
  'read',
  'search',
  'create',
  'update',
  'move',
  'tag',
  'restore',
  'delete',
  'publish',
]

const mutationCapabilities = new Set<Capability>([
  'create',
  'update',
  'move',
  'tag',
  'restore',
  'delete',
  'publish',
])

const sensitiveCapabilityDescriptions: Partial<Record<Capability, string>> = {
  restore: 'Restore can replace the current document content with an earlier revision.',
  delete: 'Delete can move documents out of the active workspace and into trash.',
  publish: 'Publish can expose document content through a shareable publication.',
}

export const tokenPresets: Record<
  TokenPresetId,
  { label: string; description: string; capabilities: Capability[]; prefixes: ScopePrefixes }
> = {
  'read-only': {
    label: 'Read only',
    description: 'Read and search only under /agents/**.',
    capabilities: ['read', 'search'],
    prefixes: { read: 'agents', search: 'agents', write: 'agents' },
  },
  'scoped-writer': {
    label: 'Scoped writer',
    description: 'Read, search, and routine edits under /agents/**.',
    capabilities: ['read', 'search', 'create', 'update', 'move', 'tag'],
    prefixes: { read: 'agents', search: 'agents', write: 'agents' },
  },
}

export const defaultTokenLifetimeHours = 24

function normalizePrefixInput(value: string): string | null {
  const normalized = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/\*\*$/, '')
  return normalized || null
}

export function defaultExpirationValue(now = new Date()): string {
  const expiresAt = new Date(now.getTime() + defaultTokenLifetimeHours * 60 * 60 * 1000)
  const localTime = new Date(expiresAt.getTime() - expiresAt.getTimezoneOffset() * 60 * 1000)
  return localTime.toISOString().slice(0, 16)
}

export function buildTokenScopes(selected: Set<Capability>, prefixes: ScopePrefixes): TokenScope[] {
  return capabilities
    .filter((capability) => selected.has(capability))
    .map((capability) => ({
      capability,
      path_prefix: normalizePrefixInput(
        capability === 'read' ? prefixes.read : capability === 'search' ? prefixes.search : prefixes.write,
      ),
    }))
}

export function sensitiveCapabilities(selected: Set<Capability>): Capability[] {
  return capabilities.filter(
    (capability) => selected.has(capability) && sensitiveCapabilityDescriptions[capability] !== undefined,
  )
}

function formatEffectiveScope(scope: TokenScope): string {
  return `${scope.capability}: ${scope.path_prefix ? `/${scope.path_prefix}/**` : '/** (workspace-wide)'}`
}

export function AgentAccessSettings() {
  const queryClient = useQueryClient()
  const tokens = useQuery({ queryKey: ['agent-tokens'], queryFn: api.listAgentTokens })
  const [actorId, setActorId] = useState('agent:researcher')
  const [displayName, setDisplayName] = useState('Researcher')
  const [label, setLabel] = useState('Research workspace')
  const [prefixes, setPrefixes] = useState<ScopePrefixes>(() => ({ ...tokenPresets['read-only'].prefixes }))
  const [expiresAt, setExpiresAt] = useState(defaultExpirationValue)
  const [selected, setSelected] = useState<Set<Capability>>(
    () => new Set(tokenPresets['read-only'].capabilities),
  )
  const [activePreset, setActivePreset] = useState<TokenPresetId | null>('read-only')
  const [sensitiveConfirmed, setSensitiveConfirmed] = useState(false)
  const [issued, setIssued] = useState<IssuedAgentToken | null>(null)

  const scopes = buildTokenScopes(selected, prefixes)
  const selectedSensitiveCapabilities = sensitiveCapabilities(selected)
  const hasMutations = [...selected].some((capability) => mutationCapabilities.has(capability))
  const writePrefixMissing = hasMutations && normalizePrefixInput(prefixes.write) === null
  const sensitiveConfirmationMissing = selectedSensitiveCapabilities.length > 0 && !sensitiveConfirmed

  const choosePreset = (presetId: TokenPresetId) => {
    const preset = tokenPresets[presetId]
    setSelected(new Set(preset.capabilities))
    setPrefixes({ ...preset.prefixes })
    setActivePreset(presetId)
    setSensitiveConfirmed(false)
  }

  const updatePrefix = (kind: keyof ScopePrefixes, value: string) => {
    setPrefixes((current) => ({ ...current, [kind]: value }))
    setActivePreset(null)
  }

  const issue = useMutation({
    mutationFn: () =>
      api.issueAgentToken({
        actor_id: actorId,
        display_name: displayName,
        label,
        scopes,
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      }),
    onSuccess: async (token) => {
      setIssued(token)
      await queryClient.invalidateQueries({ queryKey: ['agent-tokens'] })
    },
  })

  const rotate = useMutation({
    mutationFn: api.rotateAgentToken,
    onSuccess: async (token) => {
      setIssued(token)
      await queryClient.invalidateQueries({ queryKey: ['agent-tokens'] })
    },
  })

  const revoke = useMutation({
    mutationFn: api.revokeAgentToken,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agent-tokens'] })
    },
  })

  return (
    <section className="settings-panel" id="agent-access">
      <header>
        <Bot size={18} />
        <div>
          <h2>Agents & tokens</h2>
          <p>Issue revocable credentials with explicit capabilities and workspace boundaries.</p>
        </div>
        <span className="scope-badge workspace">Shared workspace</span>
      </header>
      <div className="settings-panel-body agent-access-settings">
        {issued && (
          <OneTimeSecret
            title="Copy this token now"
            description="Sangam stores only its hash. This value will not be shown again."
            value={issued.token}
            copyLabel="Copy token"
            icon={<KeyRound size={18} />}
            dismissLabel="I saved it"
            onDismiss={() => setIssued(null)}
          />
        )}

        <form
          className="agent-token-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (
              selected.size > 0 &&
              !writePrefixMissing &&
              !sensitiveConfirmationMissing &&
              actorId &&
              displayName &&
              label
            ) {
              issue.mutate()
            }
          }}
        >
          <fieldset className="agent-token-presets">
            <legend>Start with a safe preset</legend>
            <div>
              {(Object.entries(tokenPresets) as [TokenPresetId, (typeof tokenPresets)[TokenPresetId]][]).map(
                ([presetId, preset]) => (
                  <button
                    key={presetId}
                    type="button"
                    className="agent-token-preset"
                    aria-pressed={activePreset === presetId}
                    onClick={() => choosePreset(presetId)}
                  >
                    <strong>{preset.label}</strong>
                    <small>{preset.description}</small>
                  </button>
                ),
              )}
            </div>
          </fieldset>

          <label>
            <span>Actor ID</span>
            <input
              required
              value={actorId}
              onChange={(event) => setActorId(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            <span>Display name</span>
            <input required value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>
            <span>Token label</span>
            <input required value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            <span>Expiration</span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
            <small>
              Defaults to {defaultTokenLifetimeHours} hours. Clear only for a managed long-lived integration.
            </small>
          </label>

          <div className="agent-token-prefixes">
            <label>
              <span>Read path prefix</span>
              <input value={prefixes.read} onChange={(event) => updatePrefix('read', event.target.value)} />
              <small>Empty means the whole workspace.</small>
            </label>
            <label>
              <span>Search path prefix</span>
              <input
                value={prefixes.search}
                onChange={(event) => updatePrefix('search', event.target.value)}
              />
              <small>Search is also limited by the read grant.</small>
            </label>
            <label>
              <span>Write path prefix</span>
              <input
                value={prefixes.write}
                aria-invalid={writePrefixMissing}
                onChange={(event) => updatePrefix('write', event.target.value)}
              />
              <small>
                {writePrefixMissing
                  ? 'A prefix is required for mutation capabilities.'
                  : 'Shared by all mutations.'}
              </small>
            </label>
          </div>

          <fieldset>
            <legend>Capabilities</legend>
            <div className="capability-grid">
              {capabilities.map((capability) => {
                const isSensitive = sensitiveCapabilityDescriptions[capability] !== undefined
                return (
                  <label key={capability} className={isSensitive ? 'sensitive' : undefined}>
                    <input
                      type="checkbox"
                      checked={selected.has(capability)}
                      onChange={() => {
                        setSelected((current) => {
                          const next = new Set(current)
                          if (next.has(capability)) next.delete(capability)
                          else next.add(capability)
                          return next
                        })
                        setActivePreset(null)
                        setSensitiveConfirmed(false)
                      }}
                    />
                    {capability}
                  </label>
                )
              })}
            </div>
          </fieldset>

          {selectedSensitiveCapabilities.length > 0 && (
            <div className="agent-capability-warning" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>High-impact access selected</strong>
                <ul>
                  {selectedSensitiveCapabilities.map((capability) => (
                    <li key={capability}>{sensitiveCapabilityDescriptions[capability]}</li>
                  ))}
                </ul>
                <label>
                  <input
                    type="checkbox"
                    checked={sensitiveConfirmed}
                    onChange={(event) => setSensitiveConfirmed(event.target.checked)}
                  />
                  I understand and intend to grant these high-impact capabilities.
                </label>
              </div>
            </div>
          )}

          <section className="agent-scope-preview" aria-labelledby="effective-scope-title">
            <div>
              <strong id="effective-scope-title">Effective scope</strong>
              <small>This is the authority encoded in the token.</small>
            </div>
            {scopes.length > 0 ? (
              <ul>
                {scopes.map((scope) => (
                  <li key={`${scope.capability}:${scope.path_prefix ?? '*'}`}>
                    {formatEffectiveScope(scope)}
                  </li>
                ))}
              </ul>
            ) : (
              <p>Choose at least one capability.</p>
            )}
            <small>
              {expiresAt ? `Expires ${new Date(expiresAt).toLocaleString()}` : 'No expiration set.'}
            </small>
          </section>

          <button
            disabled={
              issue.isPending || selected.size === 0 || writePrefixMissing || sensitiveConfirmationMissing
            }
          >
            <KeyRound size={14} /> {issue.isPending ? 'Issuing…' : 'Issue token'}
          </button>
        </form>
        {issue.isError && <p className="operation-result error-text">{issue.error.message}</p>}

        <div className="agent-token-list">
          <div className="settings-subtitle">
            <div>
              <KeyRound size={15} />
              <strong>Issued tokens</strong>
            </div>
            <Link to="/activity">Review agent activity</Link>
          </div>
          {tokens.data?.map((token) => (
            <article key={token.token_id} className={token.revoked_at ? 'token-row revoked' : 'token-row'}>
              <div>
                <strong>{token.actor_display_name}</strong>
                <small>
                  {token.actor_id} · {token.label}
                </small>
                <span>
                  {token.scopes.map((scope) => (
                    <i key={`${scope.capability}:${scope.path_prefix ?? '*'}`}>
                      {scope.capability}:{scope.path_prefix ? `/${scope.path_prefix}/**` : '/**'}
                    </i>
                  ))}
                </span>
                <small>
                  {token.revoked_at
                    ? `Revoked ${new Date(token.revoked_at).toLocaleString()}`
                    : token.last_used_at
                      ? `Last used ${new Date(token.last_used_at).toLocaleString()}`
                      : 'Never used'}
                </small>
                {token.expires_at && <small>Expires {new Date(token.expires_at).toLocaleString()}</small>}
              </div>
              {!token.revoked_at && (
                <div className="token-actions">
                  <button
                    className="secondary-action"
                    disabled={rotate.isPending}
                    onClick={() => rotate.mutate(token.token_id)}
                  >
                    <RefreshCw size={14} /> Rotate
                  </button>
                  <button
                    className="secondary-action danger"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(token.token_id)}
                  >
                    <ShieldOff size={14} /> Revoke
                  </button>
                </div>
              )}
            </article>
          ))}
          {tokens.data?.length === 0 && <p className="small-muted">No agent tokens have been issued.</p>}
        </div>
      </div>
    </section>
  )
}
