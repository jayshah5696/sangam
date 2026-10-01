import { useDeferredValue, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Bookmark, FileCode2, FileText, Search, X } from 'lucide-react'
import {
  api,
  DOCUMENT_PAGE_SIZE,
  type DocumentSummary,
  type SearchFilters,
  type SearchMatch,
} from '../../api'
import { announceCitationNavigation, citationHref, type CitationTarget } from '../../citationNavigation'
import {
  activeSearch,
  describeFilters,
  hasActiveFilters,
  savedViewStore,
  useActiveSearch,
  useSavedViews,
  type SavedView,
} from '../../savedViews'
import { matchLocationLabel, matchSourceLabel, matchTarget, snippetParts } from '../../searchResults'
import { workspaceBasename } from '../../workspaceTree'
import { StateMessage } from '../ui/StateMessage'

const TYPE_OPTIONS = [
  { value: '', label: 'All types' },
  { value: 'text/markdown', label: 'Markdown' },
  { value: 'text/html', label: 'HTML' },
  { value: 'application/pdf', label: 'PDF' },
] as const

const SORT_OPTIONS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'updated', label: 'Updated' },
  { value: 'title', label: 'Title' },
  { value: 'path', label: 'Path' },
] as const

/** Sidebar search: located passages per result, filters, and saved views. */
export function WorkspaceSearch() {
  const filters = useActiveSearch()
  const deferredFilters = useDeferredValue(filters)
  const views = useSavedViews()
  const tags = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const [naming, setNaming] = useState<string | null>(null)
  const results = useInfiniteQuery({
    queryKey: ['documents', 'search-panel', deferredFilters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api.searchDocumentsPage(deferredFilters, pageParam),
    getNextPageParam: (lastPage, pages) => (lastPage.hasMore ? pages.length * DOCUMENT_PAGE_SIZE : undefined),
  })
  const documents = results.data?.pages.flatMap((page) => page.items) ?? []
  const update = (next: Partial<SearchFilters>) => activeSearch.set({ ...filters, ...next })
  const tagName = tags.data?.find((tag) => tag.tag_id === filters.tagId)?.name
  const activeView = views.find((view) => sameFilters(view.filters, filters))

  return (
    <div className="sidebar-content search-panel">
      <label className="sidebar-search-input">
        <Search size="var(--icon-control)" />
        <input
          autoFocus
          type="search"
          aria-label="Search documents"
          placeholder="Title, text, path, actor…"
          value={filters.query}
          onChange={(event) => update({ query: event.target.value })}
        />
      </label>
      <div className="search-filters">
        <label className="sidebar-sort">
          Type
          <select
            value={filters.contentType ?? ''}
            onChange={(event) => {
              const option = TYPE_OPTIONS.find((candidate) => candidate.value === event.target.value)
              update({ contentType: option?.value || undefined })
            }}
          >
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sidebar-sort">
          Sort
          <select
            value={filters.sort}
            onChange={(event) => {
              const option = SORT_OPTIONS.find((candidate) => candidate.value === event.target.value)
              if (option) update({ sort: option.value })
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {Boolean(tags.data?.length) && (
          <label className="sidebar-sort search-filter-wide">
            Tag
            <select
              value={filters.tagId ?? ''}
              onChange={(event) => update({ tagId: event.target.value || undefined })}
            >
              <option value="">Any tag</option>
              {tags.data?.map((tag) => (
                <option key={tag.tag_id} value={tag.tag_id}>
                  {tag.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <SavedViews views={views} activeId={activeView?.id} />
      <div className="sidebar-section-title">
        <span>Results</span>
        <small>{documents.length}</small>
        {hasActiveFilters(filters) && !activeView && naming === null && (
          <button
            type="button"
            className="sidebar-text-action"
            onClick={() => setNaming(describeFilters(filters, tagName))}
          >
            <Bookmark size="var(--icon-inline)" /> Save view
          </button>
        )}
      </div>
      {naming !== null && (
        <form
          className="sidebar-inline-form"
          aria-label="Save this search as a view"
          onSubmit={(event) => {
            event.preventDefault()
            savedViewStore().save(naming, filters, tagName)
            setNaming(null)
          }}
        >
          <input
            autoFocus
            aria-label="Saved view name"
            value={naming}
            maxLength={120}
            onChange={(event) => setNaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                setNaming(null)
              }
            }}
          />
          <button type="submit">Save</button>
          <button type="button" onClick={() => setNaming(null)}>
            Cancel
          </button>
        </form>
      )}
      <div className="search-results">
        {results.isError && (
          <StateMessage
            compact
            kind="error"
            title="Search failed"
            description="The current results could not be loaded."
            action={
              <button type="button" onClick={() => void results.refetch()}>
                Retry
              </button>
            }
          />
        )}
        {documents.map((document) => (
          <SearchResult key={document.document_id} document={document} />
        ))}
        {results.isFetchingNextPage && <p className="sidebar-message">Loading more results…</p>}
        {results.hasNextPage && (
          <button
            className="secondary-action search-load-more"
            type="button"
            disabled={results.isFetchingNextPage}
            onClick={() => void results.fetchNextPage()}
          >
            Load more results
          </button>
        )}
        {!results.isFetching && !results.isError && documents.length === 0 && (
          <p className="sidebar-message">No matching documents.</p>
        )}
      </div>
    </div>
  )
}

function SavedViews({ views, activeId }: { views: SavedView[]; activeId?: string }) {
  if (views.length === 0) return null
  return (
    <section className="saved-views" aria-label="Saved views">
      <div className="sidebar-section-title">
        <span>Saved views</span>
      </div>
      <ul>
        {views.map((view) => (
          <li key={view.id}>
            <button
              type="button"
              className={view.id === activeId ? 'active' : undefined}
              aria-pressed={view.id === activeId}
              onClick={() => activeSearch.set(view.filters)}
            >
              <Bookmark size="var(--icon-inline)" />
              <span>{view.name}</span>
            </button>
            <button
              type="button"
              className="quiet-icon"
              aria-label={`Remove saved view ${view.name}`}
              title="Remove saved view"
              onClick={() => savedViewStore().remove(view.id)}
            >
              <X size="var(--icon-inline)" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SearchResult({ document }: { document: DocumentSummary }) {
  const label = document.path ? workspaceBasename(document.path) : document.title
  const Icon = document.content_type === 'text/html' ? FileCode2 : FileText
  const passages = (document.search_matches ?? []).filter(
    (match) => match.source === 'content' || match.source === 'pdf_page' || match.source === 'annotation',
  )
  const reason = document.search_matches?.find((match) => !passages.includes(match))
  return (
    <article className="search-result" aria-label={label}>
      <Link
        to="/documents/$documentId"
        params={{ documentId: document.document_id }}
        className="file-link"
        activeProps={{ className: 'file-link active' }}
      >
        <Icon size="var(--icon-inline)" />
        <span>{label}</span>
        <small>{document.path ?? 'Draft'}</small>
        {!document.search_matches && document.search_snippet && (
          <span className="search-snippet">
            <Snippet value={document.search_snippet} />
          </span>
        )}
      </Link>
      {passages.length > 0 && (
        <ul className="search-passages">
          {passages.map((match, index) => (
            <li key={`${match.source}:${match.line ?? match.page_number ?? index}:${index}`}>
              <PassageLink document={document} match={match} />
            </li>
          ))}
        </ul>
      )}
      {passages.length === 0 && reason && <p className="search-reason">{matchSourceLabel(reason)}</p>}
    </article>
  )
}

function PassageLink({ document, match }: { document: DocumentSummary; match: SearchMatch }) {
  const navigate = useNavigate()
  const target: CitationTarget = { ...matchTarget(document.document_id, match), title: document.title }
  const location = matchLocationLabel(match)
  const href = citationHref(target)
  return (
    <a
      href={href}
      className="search-passage"
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        void navigate({ href }).then(() => announceCitationNavigation(target))
      }}
    >
      <span className="search-passage-where">
        {location && <strong>{location}</strong>}
        <span>{matchSourceLabel(match)}</span>
      </span>
      <span className="search-snippet">
        <Snippet value={match.snippet} />
      </span>
    </a>
  )
}

function Snippet({ value }: { value: string }) {
  return snippetParts(value).map((part, index) =>
    part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
  )
}

function sameFilters(left: SearchFilters, right: SearchFilters) {
  return (
    left.query.trim() === right.query.trim() &&
    left.sort === right.sort &&
    (left.tagId ?? '') === (right.tagId ?? '') &&
    (left.contentType ?? '') === (right.contentType ?? '')
  )
}
