import { describe, expect, it } from 'vitest'
import { operationEventSchema } from './api'
import { groupActivityEvents } from './activityGrouping'

function event(eventId: string, operationId: string, outcome: 'accepted' | 'denied') {
  return operationEventSchema.parse({
    event_id: eventId,
    operation_id: operationId,
    actor_id: 'agent:researcher',
    actor_display_name: 'Researcher',
    actor_kind: 'agent',
    token_id: 'agt_123',
    token_label: 'Research token',
    action: 'update',
    resource_type: 'document',
    resource_id: `doc_${eventId}`,
    path: `agents/${eventId}.md`,
    outcome,
    error_code: null,
    revision_id: null,
    details: {},
    created_at: '2026-09-03T12:00:00Z',
  })
}

describe('groupActivityEvents', () => {
  it('keeps immutable events together by operation ID and preserves order', () => {
    const groups = groupActivityEvents([
      event('one', 'op_shared', 'accepted'),
      event('two', 'op_other', 'denied'),
      event('three', 'op_shared', 'denied'),
    ])
    expect(groups.map((group) => group.map((item) => item.event_id))).toEqual([['one', 'three'], ['two']])
  })
})
