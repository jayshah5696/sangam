import { describe, expect, it } from 'vitest'
import { agentTokenSchema, issuedAgentTokenSchema } from '../api'
import {
  buildTokenScopes,
  defaultExpirationValue,
  defaultTokenLifetimeHours,
  sensitiveCapabilities,
  tokenPresets,
} from './AgentAccessSettings'

describe('agent access contracts', () => {
  it('keeps read, search, and mutation prefixes independently scoped', () => {
    expect(
      buildTokenScopes(new Set(['read', 'search', 'create', 'update']), {
        read: 'sources',
        search: '/sources/research/**',
        write: '/agents/**',
      }),
    ).toEqual([
      { capability: 'read', path_prefix: 'sources' },
      { capability: 'search', path_prefix: 'sources/research' },
      { capability: 'create', path_prefix: 'agents' },
      { capability: 'update', path_prefix: 'agents' },
    ])
  })

  it('starts from a scoped read-only grant and offers a routine scoped writer', () => {
    expect(tokenPresets['read-only'].capabilities).toEqual(['read', 'search'])
    expect(tokenPresets['read-only'].prefixes).toMatchObject({ read: 'agents', search: 'agents' })
    expect(tokenPresets['scoped-writer'].capabilities).toEqual([
      'read',
      'search',
      'create',
      'update',
      'move',
      'tag',
    ])
    expect(tokenPresets['scoped-writer'].capabilities).not.toContain('restore')
    expect(tokenPresets['scoped-writer'].capabilities).not.toContain('delete')
    expect(tokenPresets['scoped-writer'].capabilities).not.toContain('publish')
  })

  it('uses a short default expiration', () => {
    const now = new Date('2026-07-22T12:00:00.000Z')
    const expiration = new Date(defaultExpirationValue(now))
    expect(expiration.getTime() - now.getTime()).toBe(defaultTokenLifetimeHours * 60 * 60 * 1000)
    expect(defaultTokenLifetimeHours).toBe(24)
  })

  it('identifies only high-impact capabilities for explicit confirmation', () => {
    expect(sensitiveCapabilities(new Set(['read', 'restore', 'delete', 'publish']))).toEqual([
      'restore',
      'delete',
      'publish',
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
