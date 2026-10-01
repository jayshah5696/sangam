import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import type { SearchFilters } from './api'

/**
 * Saved views remember a search query and its supported filters in this
 * browser. Opening one re-runs the search, so it always shows current matches.
 */

const STORAGE_KEY = 'sangam.saved-views.v1'
const MAX_VIEWS = 50

const filtersSchema = z.object({
  query: z.string().max(500),
  sort: z.enum(['relevance', 'updated', 'title', 'path']),
  tagId: z.string().optional(),
  contentType: z.enum(['text/markdown', 'text/html', 'application/pdf']).optional(),
})

const savedViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  filters: filtersSchema,
  createdAt: z.string(),
})

export type SavedView = z.infer<typeof savedViewSchema>

type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>

const TYPE_LABELS = {
  'text/markdown': 'Markdown',
  'text/html': 'HTML',
  'application/pdf': 'PDF',
} satisfies Record<NonNullable<SearchFilters['contentType']>, string>

const SORT_LABELS = {
  relevance: null,
  updated: 'Recently updated',
  title: 'By title',
  path: 'By path',
} satisfies Record<SearchFilters['sort'], string | null>

export const DEFAULT_FILTERS: SearchFilters = { query: '', sort: 'relevance' }

export function hasActiveFilters(filters: SearchFilters): boolean {
  return Boolean(filters.query.trim() || filters.sort !== 'relevance' || filters.tagId || filters.contentType)
}

export function describeFilters(filters: SearchFilters, tagName?: string): string {
  const parts = [
    filters.query.trim() ? `“${filters.query.trim()}”` : null,
    filters.contentType ? TYPE_LABELS[filters.contentType] : null,
    filters.tagId ? `Tag ${tagName ?? 'filter'}` : null,
    SORT_LABELS[filters.sort],
  ].filter(Boolean)
  return parts.join(' · ') || 'All documents'
}

export function createSavedViewStore(storage: ViewStorage) {
  const listeners = new Set<() => void>()
  let views = read()

  function read(): SavedView[] {
    try {
      const parsed = z.array(z.unknown()).safeParse(JSON.parse(storage.getItem(STORAGE_KEY) ?? '[]'))
      if (!parsed.success) return []
      return parsed.data.flatMap((item) => {
        const view = savedViewSchema.safeParse(item)
        return view.success ? [view.data] : []
      })
    } catch {
      return []
    }
  }

  function write(next: SavedView[]) {
    views = next
    storage.setItem(STORAGE_KEY, JSON.stringify(next))
    for (const listener of listeners) listener()
  }

  return {
    list: () => views,
    save(name: string, filters: SearchFilters, tagName?: string): SavedView {
      const view: SavedView = {
        id: crypto.randomUUID(),
        name: (name.trim() || describeFilters(filters, tagName)).slice(0, 120),
        filters: filtersSchema.parse({ ...filters, query: filters.query.trim() }),
        createdAt: new Date().toISOString(),
      }
      const others = views.filter((existing) => existing.name.toLowerCase() !== view.name.toLowerCase())
      write([view, ...others].slice(0, MAX_VIEWS))
      return view
    },
    remove(id: string) {
      write(views.filter((view) => view.id !== id))
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export type SavedViewStore = ReturnType<typeof createSavedViewStore>

let browserStore: SavedViewStore | null = null
export function savedViewStore(): SavedViewStore {
  browserStore ??= createSavedViewStore(window.localStorage)
  return browserStore
}

export function useSavedViews(): SavedView[] {
  const store = savedViewStore()
  return useSyncExternalStore(store.subscribe, store.list)
}

/**
 * The sidebar search is global chrome, so other surfaces (Home, the palette)
 * open a view by publishing filters here and asking the shell to show Search.
 */
export const OPEN_SEARCH_EVENT = 'sangam:open-search'
let activeFilters: SearchFilters = DEFAULT_FILTERS
const activeListeners = new Set<() => void>()

export const activeSearch = {
  get: () => activeFilters,
  set(next: SearchFilters) {
    activeFilters = next
    for (const listener of activeListeners) listener()
  },
  subscribe(listener: () => void) {
    activeListeners.add(listener)
    return () => activeListeners.delete(listener)
  },
}

export function useActiveSearch(): SearchFilters {
  return useSyncExternalStore(activeSearch.subscribe, activeSearch.get)
}

export function openSearch(filters: SearchFilters) {
  activeSearch.set(filters)
  window.dispatchEvent(new Event(OPEN_SEARCH_EVENT))
}
