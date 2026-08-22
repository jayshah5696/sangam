export type ActivityRangePreset = 'all' | 'today' | '7d' | '30d' | 'custom'

export function activityRange(
  preset: ActivityRangePreset,
  now = new Date(),
  custom: { since: string; until: string } = { since: '', until: '' },
): { since?: string; until?: string } {
  if (preset === 'all') return {}
  if (preset === 'custom') {
    return {
      since: custom.since ? new Date(custom.since).toISOString() : undefined,
      until: custom.until ? new Date(custom.until).toISOString() : undefined,
    }
  }
  const since = new Date(now)
  if (preset === 'today') since.setHours(0, 0, 0, 0)
  else since.setDate(since.getDate() - (preset === '7d' ? 7 : 30))
  return { since: since.toISOString(), until: now.toISOString() }
}
