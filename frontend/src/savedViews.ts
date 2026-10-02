import { useSyncExternalStore } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type SavedView, type SearchFilters } from './api'

/**
 * Saved views are named searches stored by the server for the workspace, so
 * they follow the owner across devices. Opening one re-runs the search, so it
 * always shows current matches.
 */

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

const SAVED_VIEWS_KEY = ['saved-views'] as const

export function useSavedViews(): SavedView[] {
  return useQuery({ queryKey: SAVED_VIEWS_KEY, queryFn: api.listSavedViews }).data ?? []
}

export function useSavedViewMutations() {
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: SAVED_VIEWS_KEY })
  return {
    save: useMutation({
      mutationFn: ({ name, filters }: { name: string; filters: SearchFilters }) =>
        api.saveView(name, filters),
      onSuccess: refresh,
    }),
    remove: useMutation({ mutationFn: (viewId: string) => api.deleteSavedView(viewId), onSuccess: refresh }),
  }
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
