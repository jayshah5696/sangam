import { describe, expect, it } from 'vitest'
import { activitySearchSchema } from './activitySearch'

describe('activitySearchSchema', () => {
  it('uses safe defaults for invalid route state', () => {
    expect(activitySearchSchema.parse({ view: 'unknown', range: 'forever', page: '-2' })).toEqual({
      view: 'insights',
      range: '7d',
      attention: false,
      page: 1,
    })
  })

  it('preserves validated deep-link filters', () => {
    expect(
      activitySearchSchema.parse({
        view: 'activity',
        range: '30d',
        actor_id: 'agent:researcher',
        token_id: 'agt_123',
        outcome: 'denied',
        operation_id: 'op_123',
        page: '2',
      }),
    ).toMatchObject({
      view: 'activity',
      range: '30d',
      actor_id: 'agent:researcher',
      token_id: 'agt_123',
      outcome: 'denied',
      operation_id: 'op_123',
      page: 2,
    })
  })
})
