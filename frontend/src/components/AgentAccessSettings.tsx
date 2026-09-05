import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Activity, AlertTriangle, Bot, KeyRound, Pencil, RefreshCw, ShieldOff, X } from 'lucide-react'
import { api, type AgentToken, type IssuedAgentToken, type TokenScope } from '../api'
import { OneTimeSecret } from './OneTimeSecret'
import { StateMessage } from './ui/StateMessage'

type Capability = TokenScope['capability']

export type ScopePrefixes = {
  read: string
  search: string
  write: string
}

export type TokenPresetId = 'read-only' | 'assistant' | 'scoped-writer'

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
  'inference',
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

export type TokenPreset = {
  label: string
  description: string
  capabilities: Capability[]
  prefixes: ScopePrefixes
}

export interface SensitiveCapabilityMap {
  restore?: string
  delete?: string
  publish?: string
  inference?: string
  read?: string
  search?: string
  create?: string
  update?: string
  move?: string
  tag?: string
}

const sensitiveCapabilityDescriptions: SensitiveCapabilityMap = {
  restore: 'Restore can replace the current document content with an earlier revision.',
  delete: 'Delete can move documents out of the active workspace and into trash.',
  publish: 'Publish can expose document content through a shareable publication.',
  inference: 'Inference can spend the server operator’s external model budget.',
}

export interface PresetMap {
  'read-only': TokenPreset
  'scoped-writer': TokenPreset
  assistant: TokenPreset
}

export const tokenPresets: PresetMap = {
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
  assistant: {
    label: 'Workspace assistant',
    description: 'Read, search, and spend inference under /agents/**.',
    capabilities: ['read', 'search', 'inference'],
    prefixes: { read: 'agents', search: 'agents', write: 'agents' },
  },
}

export const defaultTokenLifetimeHours = 24
export const expiryWarningDays = 7

export function agentSetupInstructions(origin = window.location.origin): string {
  return [
    '# Store the one-time token in your agent secret manager as SANGAM_TOKEN.',
    `export SANGAM_API_URL='${origin}'`,
    `curl --fail "$SANGAM_API_URL/skills/sangam/SKILL.md"`,
    `curl --fail "$SANGAM_API_URL/api/v1/openapi.json"`,
    '',
    'Follow the Sangam skill. Send SANGAM_TOKEN only as an Authorization: Bearer header.',
  ].join('\n')
}

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

export function tokenStatus(
  token: AgentToken,
  now = new Date(),
): 'active' | 'expiring' | 'expired' | 'revoked' | 'rotated' {
  if (token.rotated_from_token_id) return 'rotated'
  if (token.revoked_at) return 'revoked'
  if (!token.expires_at) return 'active'
  const expiresAt = new Date(token.expires_at)
  if (expiresAt <= now) return 'expired'
  if (expiresAt.getTime() <= now.getTime() + expiryWarningDays * 24 * 60 * 60 * 1000) return 'expiring'
  return 'active'
}

export function buildTokenScopes(selected: Set<Capability>, prefixes: ScopePrefixes): TokenScope[] {
  return capabilities
    .filter((capability) => selected.has(capability))
    .map((capability) => ({
      capability,
      path_prefix:
        capability === 'inference'
          ? null
          : normalizePrefixInput(
              capability === 'read'
                ? prefixes.read
                : capability === 'search'
                  ? prefixes.search
                  : prefixes.write,
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

export function calculateFutureDate(days: number): string {
  const target = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  return localExpirationValue(target.toISOString())
}

export function calculateDurationExtension(createdAt: string, expiresAt: string): string {
  const created = new Date(createdAt).getTime()
  const expires = new Date(expiresAt).getTime()
  const duration = Math.max(expires - created, 7 * 24 * 60 * 60 * 1000)
  const target = new Date(Date.now() + duration)
  return localExpirationValue(target.toISOString())
}

function localExpirationValue(value: string | null): string {
  if (!value) return ''
  const expiresAt = new Date(value)
  return new Date(expiresAt.getTime() - expiresAt.getTimezoneOffset() * 60 * 1000).toISOString().slice(0, 16)
}

function prefixesFromScopes(scopes: TokenScope[]): ScopePrefixes {
  const prefix = (capability: Capability) =>
    scopes.find((scope) => scope.capability === capability)?.path_prefix ?? ''
  const write = scopes.find((scope) => mutationCapabilities.has(scope.capability))?.path_prefix ?? ''
  return { read: prefix('read'), search: prefix('search'), write }
}

export function AgentAccessSettings() {
  const queryClient = useQueryClient()
  const tokens = useQuery({ queryKey: ['agent-tokens'], queryFn: api.listAgentTokens })
  const health = useQuery({
    queryKey: ['activity-summary', 'access-health'],
    queryFn: () =>
      api.activitySummary({ since: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString() }),
  })
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
  const [validationAttempted, setValidationAttempted] = useState(false)
  const [editing, setEditing] = useState<AgentToken | null>(null)
  const [rotating, setRotating] = useState<AgentToken | null>(null)
  const [showRevoked, setShowRevoked] = useState(false)
  const secretDialogRef = useRef<HTMLDialogElement>(null)
  const writePrefixRef = useRef<HTMLInputElement>(null)
  const sensitiveConfirmationRef = useRef<HTMLInputElement>(null)

  const scopes = buildTokenScopes(selected, prefixes)
  const selectedSensitiveCapabilities = sensitiveCapabilities(selected)
  const hasMutations = [...selected].some((capability) => mutationCapabilities.has(capability))
  const writePrefixMissing = hasMutations && normalizePrefixInput(prefixes.write) === null
  const sensitiveConfirmationMissing = selectedSensitiveCapabilities.length > 0 && !sensitiveConfirmed
  const capabilityMissing = selected.size === 0

  useEffect(() => {
    const dialog = secretDialogRef.current
    if (issued && dialog && !dialog.open && dialog.showModal) dialog.showModal()
  }, [issued])

  const closeIssuedSecret = () => {
    secretDialogRef.current?.close()
    setIssued(null)
  }

  const focusFirstIssueError = () => {
    if (capabilityMissing) {
      document.querySelector<HTMLElement>('.capability-grid input')?.focus()
    } else if (writePrefixMissing) {
      writePrefixRef.current?.focus()
    } else if (sensitiveConfirmationMissing) {
      sensitiveConfirmationRef.current?.focus()
    }
  }

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
      setValidationAttempted(false)
      setIssued(token)
      await queryClient.invalidateQueries({ queryKey: ['agent-tokens'] })
      await queryClient.invalidateQueries({ queryKey: ['activity-summary'] })
    },
  })

  const rotate = useMutation({
    mutationFn: (tokenId: string) => api.rotateAgentToken(tokenId),
    onSuccess: async (token) => {
      setRotating(null)
      setIssued(token)
      await queryClient.invalidateQueries({ queryKey: ['agent-tokens'] })
      await queryClient.invalidateQueries({ queryKey: ['activity-summary'] })
    },
  })

  const update = useMutation({
    mutationFn: (input: {
      tokenId: string
      expected_version: number
      label: string
      scopes: TokenScope[]
      expires_at: string | null
    }) => {
      const { tokenId, ...body } = input
      return api.updateAgentToken(tokenId, body)
    },
    onSuccess: async () => {
      setEditing(null)
      await queryClient.invalidateQueries({ queryKey: ['agent-tokens'] })
      await queryClient.invalidateQueries({ queryKey: ['activity-summary'] })
    },
  })

  const revoke = useMutation({
    mutationFn: (tokenId: string) => api.revokeAgentToken(tokenId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['agent-tokens'] })
      await queryClient.invalidateQueries({ queryKey: ['activity-summary'] })
    },
  })

  return (
    <section className="settings-panel" id="agent-access" tabIndex={-1}>
      <header>
        <Bot size="var(--icon-section)" />
        <div>
          <h2>Access credentials</h2>
          <p>Issue revocable credentials with explicit permissions and workspace boundaries.</p>
        </div>
        <span className="scope-badge workspace">Shared workspace</span>
      </header>
      <div className="settings-panel-body agent-access-settings">
        <dialog
          ref={secretDialogRef}
          className="one-time-secret-dialog"
          aria-label="New agent token secret"
          onCancel={(event) => {
            event.preventDefault()
            closeIssuedSecret()
          }}
          onClose={() => setIssued(null)}
        >
          {issued && (
            <OneTimeSecret
              title={issued.rotated_from_token_id ? 'Token rotated' : 'Copy this token now'}
              description={
                issued.rotated_from_token_id
                  ? 'The previous token is revoked. Sangam stores only this new token’s hash.'
                  : 'Sangam stores only its hash. This value will not be shown again.'
              }
              value={issued.token}
              copyLabel="Copy token"
              secondaryCopy={{
                label: 'Copy agent setup',
                value: agentSetupInstructions(),
              }}
              icon={<KeyRound size="var(--icon-section)" />}
              dismissLabel="I saved it"
              onDismiss={closeIssuedSecret}
            />
          )}
        </dialog>
        {rotating && (
          <AgentTokenRotator
            token={rotating}
            pending={rotate.isPending}
            error={rotate.isError ? rotate.error.message : null}
            onClose={() => setRotating(null)}
            onRotate={() => rotate.mutate(rotating.token_id)}
          />
        )}
        {editing && (
          <AgentTokenEditor
            key={`${editing.token_id}:${editing.version}`}
            token={editing}
            pending={update.isPending}
            error={update.isError ? update.error.message : null}
            onClose={() => setEditing(null)}
            onSave={(input) => update.mutate({ tokenId: editing.token_id, ...input })}
          />
        )}
        <section className="agent-access-health" aria-labelledby="access-health-title">
          <div className="settings-subtitle">
            <div>
              <ShieldOff size="var(--icon-control)" />
              <h3 id="access-health-title">Access health</h3>
            </div>
            {health.data && health.data.access_health.attention_count > 0 && (
              <Link
                className="secondary-action"
                to="/activity"
                search={{ view: 'insights', range: '7d', attention: true }}
              >
                Review issues
              </Link>
            )}
          </div>
          {health.isLoading && <StateMessage compact kind="loading" title="Loading access health" />}
          {health.isError && (
            <StateMessage
              compact
              kind="error"
              title="Access health unavailable"
              description="Token management is still available."
              action={<button onClick={() => void health.refetch()}>Retry</button>}
            />
          )}
          {health.data && (
            <div className="agent-health-metrics">
              <span>
                <strong>{health.data.access_health.active_tokens}</strong> active
              </span>
              <span>
                <strong>{health.data.access_health.expiring_soon_tokens}</strong> expiring within{' '}
                {expiryWarningDays} days
              </span>
              <span>
                <strong>{health.data.access_health.expired_tokens}</strong> expired
              </span>
              <span>
                <strong>{health.data.access_health.recent_denied}</strong> denied today
              </span>
              <span>
                {health.data.access_health.latest_activity_at
                  ? `Last activity ${new Date(health.data.access_health.latest_activity_at).toLocaleString()}`
                  : 'No agent activity yet'}
              </span>
            </div>
          )}
        </section>
        <form
          className="agent-token-form"
          onSubmit={(event) => {
            event.preventDefault()
            setValidationAttempted(true)
            if (capabilityMissing || writePrefixMissing || sensitiveConfirmationMissing) {
              requestAnimationFrame(focusFirstIssueError)
              return
            }
            if (actorId && displayName && label) issue.mutate()
          }}
        >
          <fieldset className="agent-token-presets">
            <legend>Start with a safe preset</legend>
            <div>
              {(['read-only', 'scoped-writer', 'assistant'] as const).map((presetId) => {
                const preset = tokenPresets[presetId]
                return (
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
                )
              })}
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

          <details className="agent-advanced-disclosure" open={activePreset === null}>
            <summary>Custom capabilities and workspace boundaries</summary>
            <div className="agent-advanced-content">
              <div className="agent-token-prefixes">
                <label>
                  <span>Read path prefix</span>
                  <input
                    value={prefixes.read}
                    onChange={(event) => updatePrefix('read', event.target.value)}
                  />
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
                    ref={writePrefixRef}
                    value={prefixes.write}
                    aria-invalid={writePrefixMissing}
                    aria-describedby={writePrefixMissing ? 'write-prefix-error' : undefined}
                    onChange={(event) => updatePrefix('write', event.target.value)}
                  />
                  <small id={writePrefixMissing ? 'write-prefix-error' : undefined}>
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
                  <AlertTriangle size="var(--icon-section)" />
                  <div>
                    <strong>High-impact access selected</strong>
                    <ul>
                      {selectedSensitiveCapabilities.map((capability) => (
                        <li key={capability}>{sensitiveCapabilityDescriptions[capability]}</li>
                      ))}
                    </ul>
                    <label>
                      <input
                        ref={sensitiveConfirmationRef}
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
            </div>
          </details>

          {validationAttempted &&
            (capabilityMissing || writePrefixMissing || sensitiveConfirmationMissing) && (
              <div className="agent-token-validation" role="alert" tabIndex={-1}>
                <AlertTriangle size="var(--icon-control)" />
                <span>
                  {capabilityMissing
                    ? 'Choose at least one capability.'
                    : writePrefixMissing
                      ? 'Enter a write path prefix for mutation capabilities.'
                      : 'Confirm the high-impact capabilities before issuing this token.'}
                </span>
              </div>
            )}
          <button disabled={issue.isPending}>
            <KeyRound size="var(--icon-inline)" /> {issue.isPending ? 'Issuing…' : 'Issue token'}
          </button>
        </form>
        {issue.isError && <p className="operation-result error-text">{issue.error.message}</p>}
        {rotate.isError && (
          <p className="operation-result error-text" role="alert">
            Token rotation failed: {rotate.error.message}
          </p>
        )}
        <div className="agent-token-list">
          <div className="settings-subtitle">
            <div>
              <KeyRound size="var(--icon-control)" />
              <strong>Issued agents</strong>
            </div>
          </div>
          {(() => {
            const activeTokens = tokens.data?.filter((token) => !token.revoked_at) ?? []
            const revokedTokens = tokens.data?.filter((token) => !!token.revoked_at) ?? []

            return (
              <>
                {activeTokens.map((token) => {
                  const isExpired = token.expires_at ? new Date(token.expires_at) <= new Date() : false
                  return (
                    <article id={token.token_id} key={token.token_id} className="token-row" tabIndex={-1}>
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
                          {token.last_used_at
                            ? `Last used ${new Date(token.last_used_at).toLocaleString()}`
                            : 'Never used'}
                        </small>
                        {token.expires_at && (
                          <small className={isExpired ? 'token-expired-text' : undefined}>
                            {isExpired ? 'Expired' : 'Expires'} {new Date(token.expires_at).toLocaleString()}
                          </small>
                        )}
                        <small>
                          {token.recent_denied_count}{' '}
                          {token.recent_denied_count === 1 ? 'denied request' : 'denied requests'} today
                        </small>
                        <span className={`token-status ${tokenStatus(token)}`}>{tokenStatus(token)}</span>
                      </div>
                      <div className="token-actions">
                        <Link
                          className="secondary-action"
                          to="/activity"
                          search={{
                            view: 'activity',
                            range: '30d',
                            actor_id: token.actor_id,
                            token_id: token.token_id,
                          }}
                        >
                          View activity
                        </Link>
                        {isExpired ? (
                          <button
                            type="button"
                            className="secondary-action token-renew-button"
                            onClick={() => setEditing(token)}
                          >
                            <RefreshCw size="var(--icon-inline)" /> Renew token
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="secondary-action"
                            onClick={() => setEditing(token)}
                          >
                            <Pencil size="var(--icon-inline)" /> Edit
                          </button>
                        )}
                        <button
                          type="button"
                          className="secondary-action"
                          disabled={rotate.isPending}
                          onClick={() => setRotating(token)}
                        >
                          <KeyRound size="var(--icon-inline)" /> Rotate key…
                        </button>
                        <button
                          type="button"
                          className="secondary-action danger"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(token.token_id)}
                        >
                          <ShieldOff size="var(--icon-inline)" /> Revoke
                        </button>
                      </div>
                    </article>
                  )
                })}

                {activeTokens.length === 0 && revokedTokens.length === 0 && (
                  <p className="small-muted">No agent tokens have been issued.</p>
                )}
                {activeTokens.length === 0 && revokedTokens.length > 0 && (
                  <p className="small-muted">No active agent tokens. All issued tokens are revoked.</p>
                )}

                {revokedTokens.length > 0 && (
                  <div className="agent-token-history">
                    <button
                      type="button"
                      className="agent-token-history-toggle"
                      onClick={() => setShowRevoked((prev) => !prev)}
                    >
                      <span>
                        {showRevoked ? '▾' : '▸'} Inactive & rotated tokens ({revokedTokens.length})
                      </span>
                      <small>{showRevoked ? 'Click to hide history' : 'Click to view history'}</small>
                    </button>
                    {showRevoked && (
                      <div className="agent-token-history-list">
                        {revokedTokens.map((token) => (
                          <article
                            id={token.token_id}
                            key={token.token_id}
                            className="token-row revoked"
                            tabIndex={-1}
                          >
                            <div>
                              <strong>{token.actor_display_name}</strong>
                              <small>
                                {token.actor_id} · {token.label}
                              </small>
                              <small className="token-revoked-text">
                                Revoked {new Date(token.revoked_at!).toLocaleString()}
                                {token.rotated_from_token_id ? ' · Rotated predecessor' : ''}
                              </small>
                            </div>
                            <span className="token-history-badge">Revoked</span>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )
          })()}
        </div>
        <div className="maintenance-row" id="agent-activity" tabIndex={-1}>
          <div>
            <Activity size="var(--icon-control)" />
            <span>
              <strong>Agent activity</strong>
              <small>
                {health.data
                  ? `${health.data.access_health.attention_count} need attention · ${health.data.counts.accepted} accepted events in the last 7 days`
                  : 'Review operations and outcomes'}
              </small>
            </span>
          </div>
          <Link className="secondary-action" to="/activity" search={{ view: 'insights', range: '7d' }}>
            Open activity
          </Link>
        </div>
      </div>
    </section>
  )
}

function AgentTokenRotator({
  token,
  pending,
  error,
  onClose,
  onRotate,
}: {
  token: AgentToken
  pending: boolean
  error: string | null
  onClose: () => void
  onRotate: () => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open && dialog.showModal) dialog.showModal()
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="agent-token-rotate-dialog"
      aria-label={`Rotate secret for ${token.label}`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      <header>
        <div>
          <h3>Rotate secret key</h3>
          <p>{token.actor_display_name} · Invalidate old secret and generate a new key</p>
        </div>
        <button className="icon-button" aria-label="Close rotator" onClick={onClose}>
          <X size="var(--icon-control)" />
        </button>
      </header>
      <div className="agent-token-rotate-body">
        <div className="token-warning-callout" role="alert">
          <AlertTriangle size="var(--icon-inline)" />
          <div>
            <strong>Immediate runner disruption warning</strong>
            <p>
              Rotating will permanently revoke the current secret key. Any autonomous agent currently running
              with this token will stop working until you update it with the new secret.
            </p>
          </div>
        </div>

        <p className="token-rotate-help">
          A replacement secret key will be generated and displayed for one-time copy. Its lease duration will
          be preserved from today.
        </p>

        {error && (
          <p className="operation-result error-text" role="alert">
            {error}
          </p>
        )}

        <div className="agent-token-rotate-actions">
          <button type="button" className="secondary-action" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className="secondary-action danger"
            disabled={pending}
            onClick={() => onRotate()}
          >
            {pending ? 'Rotating…' : 'Revoke old key & generate new'}
          </button>
        </div>
      </div>
    </dialog>
  )
}

function AgentTokenEditor({
  token,
  pending,
  error,
  onClose,
  onSave,
}: {
  token: AgentToken
  pending: boolean
  error: string | null
  onClose: () => void
  onSave: (input: {
    expected_version: number
    label: string
    scopes: TokenScope[]
    expires_at: string | null
  }) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const isCurrentlyExpired = token.expires_at ? new Date(token.expires_at) <= new Date() : false
  const [label, setLabel] = useState(token.label)
  const [expiresAt, setExpiresAt] = useState(() =>
    isCurrentlyExpired ? calculateFutureDate(7) : localExpirationValue(token.expires_at),
  )
  const [selected, setSelected] = useState<Set<Capability>>(
    () => new Set(token.scopes.map((scope) => scope.capability)),
  )
  const [prefixes, setPrefixes] = useState<ScopePrefixes>(() => prefixesFromScopes(token.scopes))
  const [sensitiveConfirmed, setSensitiveConfirmed] = useState(false)
  const scopes = buildTokenScopes(selected, prefixes)
  const selectedSensitiveCapabilities = sensitiveCapabilities(selected)
  const hasMutations = [...selected].some((capability) => mutationCapabilities.has(capability))
  const writePrefixMissing = hasMutations && normalizePrefixInput(prefixes.write) === null
  const sensitiveConfirmationMissing = selectedSensitiveCapabilities.length > 0 && !sensitiveConfirmed

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open && dialog.showModal) dialog.showModal()
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="agent-token-edit-dialog"
      aria-label={isCurrentlyExpired ? `Renew ${token.label}` : `Edit ${token.label}`}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={onClose}
    >
      <header>
        <div>
          <h3>{isCurrentlyExpired ? 'Renew agent token' : 'Edit token details'}</h3>
          <p>
            {token.actor_display_name} ·{' '}
            {isCurrentlyExpired
              ? 'Instant reactivation with existing secret.'
              : 'Existing secret stays valid after saving.'}
          </p>
        </div>
        <button className="icon-button" aria-label="Close token editor" onClick={onClose}>
          <X size="var(--icon-control)" />
        </button>
      </header>
      <form
        className="agent-token-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (!label.trim() || selected.size === 0 || writePrefixMissing || sensitiveConfirmationMissing)
            return
          onSave({
            expected_version: token.version,
            label,
            scopes,
            expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
          })
        }}
      >
        {isCurrentlyExpired && (
          <div className="token-info-callout" role="status">
            <KeyRound size="var(--icon-inline)" />
            <div>
              <strong>No runner updates required</strong>
              <p>
                Extending expiration immediately reactivates this token with its existing secret key. Your
                agent runner will resume working without updating .env or configuration.
              </p>
            </div>
          </div>
        )}

        <label>
          <span>Token label</span>
          <input required value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <div className="agent-token-expiration-field">
          <div className="agent-token-expiration-header">
            <span>Expiration & extension</span>
            {isCurrentlyExpired && (
              <span className="token-expired-tag">
                Expired {new Date(token.expires_at!).toLocaleDateString()}
              </span>
            )}
          </div>
          <div className="agent-token-expiration-presets">
            <button
              type="button"
              className={`preset-pill ${expiresAt === calculateFutureDate(7) ? 'active' : ''}`}
              onClick={() => setExpiresAt(calculateFutureDate(7))}
            >
              Extend +7 Days (Default)
            </button>
            <button
              type="button"
              className={`preset-pill ${expiresAt === calculateFutureDate(30) ? 'active' : ''}`}
              onClick={() => setExpiresAt(calculateFutureDate(30))}
            >
              +30 Days
            </button>
            <button
              type="button"
              className={`preset-pill ${expiresAt === calculateFutureDate(90) ? 'active' : ''}`}
              onClick={() => setExpiresAt(calculateFutureDate(90))}
            >
              +90 Days
            </button>
            {token.expires_at && (
              <button
                type="button"
                className="preset-pill"
                onClick={() => setExpiresAt(calculateDurationExtension(token.created_at, token.expires_at!))}
              >
                Same duration
              </button>
            )}
            <button
              type="button"
              className={`preset-pill ${expiresAt === '' ? 'active' : ''}`}
              onClick={() => setExpiresAt('')}
            >
              No expiration
            </button>
          </div>
          <label className="agent-token-custom-date">
            <span>Custom date & time</span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
        </div>
        <div className="agent-token-prefixes">
          <label>
            <span>Read path prefix</span>
            <input
              value={prefixes.read}
              onChange={(event) => setPrefixes((current) => ({ ...current, read: event.target.value }))}
            />
          </label>
          <label>
            <span>Search path prefix</span>
            <input
              value={prefixes.search}
              onChange={(event) => setPrefixes((current) => ({ ...current, search: event.target.value }))}
            />
          </label>
          <label>
            <span>Write path prefix</span>
            <input
              value={prefixes.write}
              aria-invalid={writePrefixMissing}
              onChange={(event) => setPrefixes((current) => ({ ...current, write: event.target.value }))}
            />
            {writePrefixMissing && <small>A prefix is required for mutation capabilities.</small>}
          </label>
        </div>
        <fieldset>
          <legend>Capabilities</legend>
          <div className="capability-grid">
            {capabilities.map((capability) => (
              <label
                key={capability}
                className={sensitiveCapabilityDescriptions[capability] ? 'sensitive' : undefined}
              >
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
                    setSensitiveConfirmed(false)
                  }}
                />
                {capability}
              </label>
            ))}
          </div>
        </fieldset>
        {selectedSensitiveCapabilities.length > 0 && (
          <div className="agent-capability-warning" role="alert">
            <AlertTriangle size="var(--icon-section)" />
            <div>
              <strong>Confirm high-impact access</strong>
              <label>
                <input
                  type="checkbox"
                  checked={sensitiveConfirmed}
                  onChange={(event) => setSensitiveConfirmed(event.target.checked)}
                />
                I intend to save these high-impact capabilities.
              </label>
            </div>
          </div>
        )}
        {selected.size === 0 && <p className="error-text">Choose at least one capability.</p>}
        {error && (
          <p className="operation-result error-text" role="alert">
            {error}
          </p>
        )}
        <div className="agent-token-edit-actions">
          <button disabled={pending || selected.size === 0 || writePrefixMissing}>
            {pending
              ? isCurrentlyExpired
                ? 'Renewing…'
                : 'Saving…'
              : isCurrentlyExpired
                ? 'Renew token'
                : 'Save token'}
          </button>
          <button type="button" className="secondary-action" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  )
}
