import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Archive, ExternalLink, FileText, RefreshCw, Search } from 'lucide-react'
import { api, type KarakeepImport } from '../api'

export const Route = createFileRoute('/karakeep')({ component: KarakeepConfluence })

function KarakeepConfluence() {
  const queryClient = useQueryClient()
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedImportId, setSelectedImportId] = useState<string | null>(null)
  const health = useQuery({ queryKey: ['karakeep', 'health'], queryFn: api.karakeepHealth })
  const imports = useQuery({ queryKey: ['karakeep', 'imports'], queryFn: api.listKarakeepImports })
  const effectiveImportId = selectedImportId ?? imports.data?.[0]?.import_id ?? null
  const bookmarks = useQuery({
    queryKey: ['karakeep', 'bookmarks', searchQuery],
    queryFn: () => api.searchKarakeep(searchQuery),
    enabled: Boolean(searchQuery) && health.data?.connected === true,
  })
  const detail = useQuery({
    queryKey: ['karakeep', 'import', effectiveImportId],
    queryFn: () => api.getKarakeepImport(effectiveImportId ?? ''),
    enabled: Boolean(effectiveImportId),
  })

  const refreshQueries = async (importId: string) => {
    setSelectedImportId(importId)
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['karakeep', 'imports'] }),
      queryClient.invalidateQueries({ queryKey: ['karakeep', 'import', importId] }),
      queryClient.invalidateQueries({ queryKey: ['karakeep', 'bookmarks'] }),
      queryClient.invalidateQueries({ queryKey: ['documents'] }),
    ])
  }
  const importBookmark = useMutation({
    mutationFn: api.importKarakeepBookmark,
    onSuccess: (result) => refreshQueries(result.import_id),
  })
  const refreshImport = useMutation({
    mutationFn: api.refreshKarakeepImport,
    onSuccess: (result) => refreshQueries(result.import_id),
  })
  const applyRefresh = useMutation({
    mutationFn: (content: string) => {
      if (!detail.data) throw new Error('Select an import first')
      return api.applyKarakeepRefresh(detail.data, content)
    },
    onSuccess: (result) => refreshQueries(result.import_id),
  })

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    const normalized = searchInput.trim()
    if (normalized) setSearchQuery(normalized)
  }

  return (
    <main className="karakeep-page">
      <header className="karakeep-header">
        <div>
          <p className="eyebrow">Archive confluence</p>
          <h1>Karakeep imports</h1>
          <p>
            Select archived sources, preserve provenance, and review refreshes before they become revisions.
          </p>
        </div>
        <ConnectionState health={health.data} loading={health.isLoading} />
      </header>

      <section className="karakeep-panel" aria-labelledby="karakeep-select-heading">
        <header>
          <Search size={18} />
          <div>
            <h2 id="karakeep-select-heading">Find archived content</h2>
            <p>Search stays in Karakeep. Only bookmarks you select become Sangam documents.</p>
          </div>
        </header>
        <div className="karakeep-panel-body">
          <form className="karakeep-search" onSubmit={submitSearch}>
            <label>
              <span>Bookmark search</span>
              <input
                type="search"
                value={searchInput}
                placeholder="Topic, title, tag, or Karakeep query"
                onChange={(event) => setSearchInput(event.target.value)}
                disabled={!health.data?.connected}
              />
            </label>
            <button className="secondary-action" disabled={!searchInput.trim() || bookmarks.isFetching}>
              <Search size={14} /> {bookmarks.isFetching ? 'Searching…' : 'Search'}
            </button>
          </form>
          {health.data && !health.data.configured && (
            <p className="karakeep-message">
              Configure the server-side base URL and API key. Credentials are never sent to the browser.
            </p>
          )}
          {bookmarks.data && (
            <div className="karakeep-bookmarks">
              {bookmarks.data.bookmarks.map((bookmark) => (
                <article key={bookmark.bookmark_id}>
                  <div>
                    <strong>{bookmark.title}</strong>
                    <small>{bookmark.author ?? bookmark.source_url ?? bookmark.content_type}</small>
                    <TagList tags={bookmark.tags} />
                  </div>
                  {bookmark.imported_document_id ? (
                    <Link
                      className="secondary-action"
                      to="/documents/$documentId"
                      params={{ documentId: bookmark.imported_document_id }}
                    >
                      <FileText size={14} /> Open document
                    </Link>
                  ) : (
                    <button
                      className="secondary-action"
                      disabled={importBookmark.isPending}
                      onClick={() => importBookmark.mutate(bookmark.bookmark_id)}
                    >
                      <Archive size={14} /> Import
                    </button>
                  )}
                </article>
              ))}
              {bookmarks.data.bookmarks.length === 0 && <p className="small-muted">No bookmarks matched.</p>}
            </div>
          )}
        </div>
      </section>

      <div className="karakeep-workspace">
        <ImportList
          imports={imports.data ?? []}
          selected={effectiveImportId}
          onSelect={setSelectedImportId}
        />
        <ImportReview
          key={`${detail.data?.import_id ?? 'none'}:${detail.data?.updated_at ?? ''}`}
          detail={detail.data}
          onRefresh={() => detail.data && refreshImport.mutate(detail.data.import_id)}
          onApply={(content) => applyRefresh.mutate(content)}
          refreshing={refreshImport.isPending}
          applying={applyRefresh.isPending}
        />
      </div>
      {(importBookmark.isError || refreshImport.isError || applyRefresh.isError) && (
        <p className="operation-result error-text">
          {(importBookmark.error ?? refreshImport.error ?? applyRefresh.error)?.message}
        </p>
      )}
    </main>
  )
}

function ConnectionState({
  health,
  loading,
}: {
  health?: { configured: boolean; connected: boolean; message: string }
  loading: boolean
}) {
  const state = loading ? 'Checking' : health?.connected ? 'Connected' : 'Unavailable'
  return (
    <div className={`karakeep-connection ${health?.connected ? 'connected' : ''}`}>
      <span>{state}</span>
      <small>{health?.message ?? 'Checking Karakeep connection…'}</small>
    </div>
  )
}

function ImportList({
  imports,
  selected,
  onSelect,
}: {
  imports: KarakeepImport[]
  selected: string | null
  onSelect: (importId: string) => void
}) {
  return (
    <aside className="karakeep-import-list ui-rail ui-rail--surface">
      <header className="ui-rail-header">
        <div>
          <strong>Imported sources</strong>
          <small>{imports.length} selective imports</small>
        </div>
      </header>
      <div>
        {imports.map((item) => (
          <button
            key={item.import_id}
            className={selected === item.import_id ? 'active' : ''}
            onClick={() => onSelect(item.import_id)}
          >
            <span>{item.title ?? item.bookmark_id}</span>
            <small>{item.status.replace('_', ' ')}</small>
          </button>
        ))}
        {imports.length === 0 && <p className="small-muted">No bookmarks imported yet.</p>}
      </div>
    </aside>
  )
}

function ImportReview({
  detail,
  onRefresh,
  onApply,
  refreshing,
  applying,
}: {
  detail: Awaited<ReturnType<typeof api.getKarakeepImport>> | undefined
  onRefresh: () => void
  onApply: (content: string) => void
  refreshing: boolean
  applying: boolean
}) {
  const [reviewDraft, setReviewDraft] = useState(detail?.pending_markdown ?? '')
  if (!detail) {
    return (
      <section className="karakeep-empty empty-state">
        Select an imported source to inspect provenance.
      </section>
    )
  }
  return (
    <section className="karakeep-review">
      <header>
        <div>
          <p className="eyebrow">{detail.status.replace('_', ' ')}</p>
          <h2>{detail.title ?? detail.bookmark_id}</h2>
          <p>
            {detail.author ?? 'Unknown author'} · archived {formatDate(detail.source_created_at)}
          </p>
        </div>
        <div className="karakeep-actions">
          {detail.source_url && (
            <a className="secondary-action" href={detail.source_url} target="_blank" rel="noreferrer">
              <ExternalLink size={14} /> Original
            </a>
          )}
          {detail.document_id && (
            <Link
              className="secondary-action"
              to="/documents/$documentId"
              params={{ documentId: detail.document_id }}
            >
              <FileText size={14} /> Edit working copy
            </Link>
          )}
          <button className="secondary-action" disabled={refreshing} onClick={onRefresh}>
            <RefreshCw size={14} /> {refreshing ? 'Refreshing…' : 'Check for refresh'}
          </button>
        </div>
      </header>
      <div className="karakeep-provenance">
        <span>
          Karakeep ID <code>{detail.bookmark_id}</code>
        </span>
        <TagList tags={detail.tags} />
        <span>{detail.assets.length} attachments recorded</span>
      </div>
      {detail.last_error && <p className="karakeep-message error-text">{detail.last_error}</p>}
      <div className="karakeep-comparison">
        <SourceColumn title="Archived extraction" content={detail.accepted_markdown} />
        <SourceColumn title="Corrected working copy" content={detail.working_copy} />
      </div>
      {detail.pending_markdown && (
        <div className="karakeep-refresh-review">
          <div>
            <strong>Changed source is waiting for review</strong>
            <p>Edit the proposed Markdown below. Applying it creates a normal human-attributed revision.</p>
          </div>
          <textarea value={reviewDraft} onChange={(event) => setReviewDraft(event.target.value)} />
          <button
            className="secondary-action"
            disabled={applying || !reviewDraft}
            onClick={() => onApply(reviewDraft)}
          >
            {applying ? 'Applying…' : 'Apply reviewed revision'}
          </button>
        </div>
      )}
    </section>
  )
}

function SourceColumn({ title, content }: { title: string; content: string | null }) {
  return (
    <article>
      <strong>{title}</strong>
      <pre>{content ?? 'Source is not available yet.'}</pre>
    </article>
  )
}

function TagList({ tags }: { tags: string[] }) {
  return (
    <span className="karakeep-tags">
      {tags.map((tag) => (
        <i key={tag}>{tag}</i>
      ))}
    </span>
  )
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : 'unknown date'
}
