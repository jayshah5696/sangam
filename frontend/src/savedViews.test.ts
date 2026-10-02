import { describe, expect, it } from 'vitest'
import { describeFilters, hasActiveFilters } from './savedViews'

describe('filters', () => {
  it('reports whether anything beyond the default is set', () => {
    expect(hasActiveFilters({ query: ' ', sort: 'relevance' })).toBe(false)
    expect(hasActiveFilters({ query: '', sort: 'updated' })).toBe(true)
    expect(hasActiveFilters({ query: '', sort: 'relevance', tagId: 't' })).toBe(true)
  })

  it('describes filters for people', () => {
    expect(describeFilters({ query: 'memory', sort: 'updated', contentType: 'text/markdown' })).toBe(
      '“memory” · Markdown · Recently updated',
    )
    expect(describeFilters({ query: '', sort: 'relevance' })).toBe('All documents')
    expect(describeFilters({ query: '', sort: 'relevance', tagId: 't' }, 'reading')).toBe('Tag reading')
  })
})
