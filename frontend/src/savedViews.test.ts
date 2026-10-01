// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { createSavedViewStore, describeFilters, hasActiveFilters } from './savedViews'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
}

describe('saved views', () => {
  let storage: MemoryStorage
  beforeEach(() => {
    storage = new MemoryStorage()
  })

  it('saves a named query with its filters and survives a reload', () => {
    const store = createSavedViewStore(storage)
    const view = store.save('Recent PDFs', { query: '', sort: 'updated', contentType: 'application/pdf' })
    expect(view.name).toBe('Recent PDFs')
    const reloaded = createSavedViewStore(storage)
    expect(reloaded.list()).toEqual([view])
  })

  it('replaces a view with the same name instead of duplicating it', () => {
    const store = createSavedViewStore(storage)
    store.save('Memory', { query: 'memory', sort: 'relevance' })
    store.save('memory', { query: 'memory gb', sort: 'relevance' })
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]?.filters.query).toBe('memory gb')
  })

  it('names an unnamed view after its filters', () => {
    const store = createSavedViewStore(storage)
    expect(store.save('  ', { query: 'memory', sort: 'updated', contentType: 'text/markdown' }).name).toBe(
      '“memory” · Markdown · Recently updated',
    )
  })

  it('removes a view', () => {
    const store = createSavedViewStore(storage)
    const view = store.save('A', { query: 'a', sort: 'relevance' })
    store.remove(view.id)
    expect(store.list()).toEqual([])
  })

  it('ignores corrupt storage rather than failing to load', () => {
    storage.setItem('sangam.saved-views.v1', '{not json')
    expect(createSavedViewStore(storage).list()).toEqual([])
    storage.setItem('sangam.saved-views.v1', JSON.stringify([{ id: 1 }]))
    expect(createSavedViewStore(storage).list()).toEqual([])
  })

  it('notifies subscribers when views change', () => {
    const store = createSavedViewStore(storage)
    let calls = 0
    const unsubscribe = store.subscribe(() => (calls += 1))
    store.save('A', { query: 'a', sort: 'relevance' })
    unsubscribe()
    store.save('B', { query: 'b', sort: 'relevance' })
    expect(calls).toBe(1)
  })
})

describe('filters', () => {
  it('reports whether anything beyond the default is set', () => {
    expect(hasActiveFilters({ query: ' ', sort: 'relevance' })).toBe(false)
    expect(hasActiveFilters({ query: '', sort: 'updated' })).toBe(true)
    expect(hasActiveFilters({ query: '', sort: 'relevance', tagId: 't' })).toBe(true)
  })

  it('describes filters for people', () => {
    expect(describeFilters({ query: '', sort: 'relevance' })).toBe('All documents')
    expect(describeFilters({ query: '', sort: 'relevance', tagId: 't' }, 'reading')).toBe('Tag reading')
  })
})
