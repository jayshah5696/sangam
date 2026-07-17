import { describe, expect, it } from 'vitest'
import { agentTokenSchema, issuedAgentTokenSchema } from '../api'
import { buildTokenScopes } from './AgentAccessSettings'

describe('agent access contracts', () => {
  it('keeps read/search global and mutations inside the selected prefix', () => {
    expect(buildTokenScopes(new Set(['read', 'search', 'create', 'update']), 'agents')).toEqual([
      { capability: 'read', path_prefix: null },
      { capability: 'search', path_prefix: null },
      { capability: 'create', path_prefix: 'agents' },
      { capability: 'update', path_prefix: 'agents' },
    ])
  })

  it('accepts a one-time issued secret but excludes it from persisted token records', () => {
    const record = {
      token_id: 'agt_123',
      actor_id: 'agent:researcher',
      actor_display_name: 'Researcher',
      label: 'Research workspace',
      scopes: [{ capability: 'read' as const, path_prefix: null }],
      created_at: '2026-07-15T00:00:00+00:00',
      expires_at: null,
      revoked_at: null,
      last_used_at: null,
      rotated_from_token_id: null,
    }
    expect(agentTokenSchema.parse(record)).toEqual(record)
    expect(issuedAgentTokenSchema.parse({ ...record, token: 'sgm_agt_123.secret' }).token).toBe(
      'sgm_agt_123.secret',
    )
    expect(agentTokenSchema.parse({ ...record, token: 'discarded' })).not.toHaveProperty('token')
  })
})
