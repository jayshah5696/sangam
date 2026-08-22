import { describe, expect, it } from 'vitest'
import { activityRange } from './activityFilters'

describe('activityRange', () => {
  it('builds UTC boundaries for fixed ranges', () => {
    const now = new Date('2026-08-22T12:30:00-04:00')
    expect(activityRange('7d', now)).toEqual({
      since: '2026-08-15T16:30:00.000Z',
      until: '2026-08-22T16:30:00.000Z',
    })
  })

  it('converts custom local datetime values and leaves empty boundaries open', () => {
    const range = activityRange('custom', new Date(), {
      since: '2026-08-20T09:00',
      until: '',
    })
    expect(range.since).toBe(new Date('2026-08-20T09:00').toISOString())
    expect(range.until).toBeUndefined()
  })
})
