import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Bot, Check, Copy, KeyRound, RefreshCw, ShieldOff } from 'lucide-react'
import { api, type IssuedAgentToken, type TokenScope } from '../api'

const capabilities: TokenScope['capability'][] = [
  'read',
  'search',
  'create',
  'update',
  'move',
  'tag',
  'restore',
  'delete',
]

const defaultCapabilities = new Set<TokenScope['capability']>([
  'read',
  'search',
  'create',
  'update',
  'move',
  'tag',
  'restore',
])

export function buildTokenScopes(selected: Set<TokenScope['capability']>, pathPrefix: string): TokenScope[] {
  return [...selected].map((capability) => ({
    capability,
    path_prefix: capability === 'read' || capability === 'search' ? null : pathPrefix,
  }))
}

export function AgentAccessSettings() {
  const queryClient = useQueryClient()
  const tokens = useQuery({ queryKey: ['agent-tokens'], queryFn: api.listAgentTokens })
  const [actorId, setActorId] = useState('agent:researcher')
  const [displayName, setDisplayName] = useState('Researcher')
  const [label, setLabel] = useState('Research workspace')
  const [pathPrefix, setPathPrefix] = useState('agents')
  const [expiresAt, setExpiresAt] = useState('')
  const [selected, setSelected] = useState(defaultCapabilities)
  const [issued, setIssued] = useState<IssuedAgentToken | null>(null)

  const issue = useMutation({
    mutationFn: () =>
      api.issueAgentToken({
        actor_id: actorId,
        display_name: displayName,
        label,
        scopes: buildTokenScopes(selected, pathPrefix),
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
          <div className="one-time-token" role="status">
            <div>
              <KeyRound size={18} />
              <span>
                <strong>Copy this token now</strong>
                <small>Sangam stores only its hash. This value will not be shown again.</small>
              </span>
            </div>
            <code>{issued.token}</code>
            <div className="token-actions">
              <button
                className="secondary-action"
                onClick={() => void navigator.clipboard.writeText(issued.token)}
              >
                <Copy size={14} /> Copy token
              </button>
              <button className="secondary-action" onClick={() => setIssued(null)}>
                <Check size={14} /> I saved it
              </button>
            </div>
          </div>
        )}

        <form
          className="agent-token-form"
          onSubmit={(event) => {
            event.preventDefault()
            if (selected.size > 0) issue.mutate()
          }}
        >
          <label>
            <span>Actor ID</span>
            <input value={actorId} onChange={(event) => setActorId(event.target.value)} />
          </label>
          <label>
            <span>Display name</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <label>
            <span>Token label</span>
            <input value={label} onChange={(event) => setLabel(event.target.value)} />
          </label>
          <label>
            <span>Write path prefix</span>
            <input value={pathPrefix} onChange={(event) => setPathPrefix(event.target.value)} />
            <small>Read and search are workspace-wide. Mutations stay under this prefix.</small>
          </label>
          <label>
            <span>Expiration (optional)</span>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
            />
          </label>
          <fieldset>
            <legend>Capabilities</legend>
            <div className="capability-grid">
              {capabilities.map((capability) => (
                <label key={capability}>
                  <input
                    type="checkbox"
                    checked={selected.has(capability)}
                    onChange={() =>
                      setSelected((current) => {
                        const next = new Set(current)
                        if (next.has(capability)) next.delete(capability)
                        else next.add(capability)
                        return next
                      })
                    }
                  />
                  {capability}
                </label>
              ))}
            </div>
          </fieldset>
          <button disabled={issue.isPending || selected.size === 0}>
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
