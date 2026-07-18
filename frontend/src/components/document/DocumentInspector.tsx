import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useQueryClient } from '@tanstack/react-query'
import { api, type Document, type Publication, type Revision, type Tag } from '../../api'
import { useDocumentSession, useDocumentSessions } from '../../documentSessions'
import { RevisionMergeView } from '../RevisionMergeView'
import { HtmlPreview } from '../HtmlPreview'
import { MarkdownPreview } from '../MarkdownPreview'
import { TrustedHtmlPreview } from '../TrustedHtmlPreview'

export function DocumentInspector({
  width,
  document,
  content,
  onCollapse,
  onUpdated,
  onFocusEditor,
}: {
  width: number
  document: Document
  content: string
  onCollapse: () => void
  onUpdated: (document: Document, replaceContent?: boolean) => void
  onFocusEditor: () => void
}) {
  const documentId = document.document_id
  const session = useDocumentSession(documentId)
  const sessions = useDocumentSessions()
  const queryClient = useQueryClient()
  const historyQuery = useQuery({ queryKey: ['history', documentId], queryFn: () => api.history(documentId) })
  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const publicationQuery = useQuery({
    queryKey: ['publication', documentId],
    queryFn: () => api.getDocumentPublication(documentId),
  })
  const restore = useMutation({
    mutationFn: (revisionId: string) => api.restore(document, revisionId),
    onSuccess: (nextDocument) => {
      onUpdated(nextDocument, true)
      sessions.updateSession(documentId, { compareFrom: undefined, compareTo: undefined })
    },
  })
  const history = historyQuery.data ?? []
  const compareFrom = session.compareFrom
  const compareTo = session.compareTo ?? document.current_revision_id
  const [tab, setTab] = useState<'properties' | 'outline' | 'history'>('properties')
  const [previewRevision, setPreviewRevision] = useState<Revision | null>(null)
  const exposeRevision = useMutation({
    mutationFn: (revisionId: string) => {
      if (!publicationQuery.data) throw new Error('Publish the document first')
      return api.exposePublicationRevision(publicationQuery.data.publication_id, revisionId)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['publication', documentId] }),
  })
  const headings = content
    .split('\n')
    .map((line, index) => {
      const match = /^(#{1,6})\s+(.+)/.exec(line)
      return match ? { level: match[1]!.length, text: match[2]!, line: index + 1 } : null
    })
    .filter((heading): heading is { level: number; text: string; line: number } => Boolean(heading))
  const fromRevision = history.find((revision) => revision.revision_id === compareFrom)
  const toRevision = history.find((revision) => revision.revision_id === compareTo)
  const setComparison = (from: string, to: string) => {
    sessions.updateSession(documentId, { compareFrom: from, compareTo: to })
  }
  return (
    <aside className="history-panel document-inspector" style={{ width }}>
      <div className="right-panel-header">
        <p className="eyebrow">Inspector</p>
        <button className="icon-button" aria-label="Collapse document inspector" onClick={onCollapse}>
          ›
        </button>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="Document inspector">
        {(['properties', 'outline', 'history'] as const).map((candidate) => (
          <button
            role="tab"
            aria-selected={tab === candidate}
            className={tab === candidate ? 'active' : ''}
            key={candidate}
            onClick={() => setTab(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>
      {tab === 'properties' && (
        <>
          <MetadataEditor
            key={document.metadata_version}
            document={document}
            tags={tagsQuery.data ?? []}
            onUpdated={onUpdated}
          />
          {!publicationQuery.isLoading && (
            <PublicationEditor
              document={document}
              publication={publicationQuery.data ?? null}
              onDocumentUpdated={onUpdated}
            />
          )}
        </>
      )}
      {tab === 'outline' && (
        <section className="outline-panel">
          {headings.map((heading) => (
            <button
              key={`${heading.line}:${heading.text}`}
              style={{ paddingLeft: 8 + (heading.level - 1) * 10 }}
            >
              <span>{heading.text}</span>
              <small>Ln {heading.line}</small>
            </button>
          ))}
          {headings.length === 0 && <p className="small-muted">No Markdown headings in this document.</p>}
        </section>
      )}
      {tab === 'history' && (
        <>
          <section className="compare-controls">
            <label>
              From
              <select
                value={compareFrom ?? ''}
                onChange={(event) => {
                  if (event.target.value) setComparison(event.target.value, compareTo)
                }}
              >
                <option value="">Choose a revision…</option>
                {history.map((revision) => (
                  <option key={revision.revision_id} value={revision.revision_id}>
                    {revision.operation} · {new Date(revision.created_at).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <label>
              To
              <select
                value={compareTo}
                onChange={(event) => {
                  if (compareFrom) setComparison(compareFrom, event.target.value)
                }}
              >
                {history.map((revision) => (
                  <option key={revision.revision_id} value={revision.revision_id}>
                    {revision.operation} · {new Date(revision.created_at).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            {fromRevision && toRevision && fromRevision.revision_id !== toRevision.revision_id && (
              <button
                onClick={() =>
                  sessions.updateSession(documentId, { compareFrom: undefined, compareTo: undefined })
                }
              >
                Close comparison
              </button>
            )}
          </section>
          {fromRevision && toRevision && fromRevision.revision_id !== toRevision.revision_id && (
            <RevisionMergeView original={fromRevision.content} modified={toRevision.content} />
          )}
          {previewRevision && (
            <section className="revision-render-preview">
              <header>
                <strong>Rendered revision</strong>
                <button onClick={() => setPreviewRevision(null)}>Close</button>
              </header>
              {document.content_type === 'text/markdown' ? (
                <MarkdownPreview content={previewRevision.content} />
              ) : document.trust_level === 'trusted_interactive' ? (
                <TrustedHtmlPreview document={document} revisionId={previewRevision.revision_id} />
              ) : (
                <HtmlPreview content={previewRevision.content} />
              )}
            </section>
          )}
          <HistoryList
            history={history}
            currentRevisionId={document.current_revision_id}
            busy={restore.isPending || session.saveState !== 'saved'}
            onCompare={(revisionId) => setComparison(revisionId, document.current_revision_id)}
            onPreview={(revision) => setPreviewRevision(revision)}
            onExpose={
              publicationQuery.data?.active ? (revisionId) => exposeRevision.mutate(revisionId) : undefined
            }
            onCopy={(revision) => {
              sessions.updateSession(documentId, {
                content: revision.content,
                baseRevisionId: document.current_revision_id,
              })
              onFocusEditor()
            }}
            onRestore={(revisionId) => restore.mutate(revisionId)}
          />
        </>
      )}
    </aside>
  )
}

function HistoryList({
  history,
  currentRevisionId,
  busy,
  onCompare,
  onPreview,
  onExpose,
  onCopy,
  onRestore,
}: {
  history: Revision[]
  currentRevisionId: string
  busy: boolean
  onCompare: (revisionId: string) => void
  onPreview: (revision: Revision) => void
  onExpose?: (revisionId: string) => void
  onCopy: (revision: Revision) => void
  onRestore: (revisionId: string) => void
}) {
  return (
    <section className="history-section">
      <p className="eyebrow">History</p>
      {history.map((revision) => (
        <article className="revision" key={revision.revision_id}>
          <div>
            <strong>{revision.operation}</strong>
            <time>{new Date(revision.created_at).toLocaleString()}</time>
          </div>
          <p>
            <span className="actor-badge">
              {revision.actor_display_name ?? revision.actor_id}
              {revision.actor_kind ? ` · ${revision.actor_kind}` : ''}
            </span>
            {revision.summary ? ` · ${revision.summary}` : ''}
          </p>
          {revision.operation_id && <small>Operation {revision.operation_id}</small>}
          <div className="revision-actions">
            <button onClick={() => onPreview(revision)}>Preview</button>
            {onExpose && revision.revision_id !== currentRevisionId && (
              <button onClick={() => onExpose(revision.revision_id)}>Expose URL</button>
            )}
          </div>
          {revision.revision_id !== currentRevisionId && (
            <div className="revision-actions">
              <button onClick={() => onCompare(revision.revision_id)}>Compare</button>
              <button onClick={() => onCopy(revision)}>Copy to editor</button>
              <button disabled={busy} onClick={() => onRestore(revision.revision_id)}>
                Restore
              </button>
            </div>
          )}
        </article>
      ))}
    </section>
  )
}

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 64) || 'document'
  )
}

function PublicationEditor({
  document,
  publication,
  onDocumentUpdated,
}: {
  document: Document
  publication: Publication | null
  onDocumentUpdated: (document: Document) => void
}) {
  const queryClient = useQueryClient()
  const [slug, setSlug] = useState(publication?.slug ?? slugify(document.title))
  const [accessPolicy, setAccessPolicy] = useState<Publication['access_policy']>(
    publication?.access_policy ?? 'private',
  )
  const [oneTimeToken, setOneTimeToken] = useState<string | null>(null)
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['publication', document.document_id] })
  }
  const save = useMutation({
    mutationFn: () =>
      publication
        ? api.updatePublication(publication, slug, accessPolicy)
        : api.createPublication(document.document_id, slug, accessPolicy),
    onSuccess: async (result) => {
      setOneTimeToken(result.token)
      await refresh()
    },
  })
  const remove = useMutation({ mutationFn: () => api.unpublish(publication!), onSuccess: refresh })
  const rotate = useMutation({
    mutationFn: () => api.rotatePublicationToken(publication!.publication_id),
    onSuccess: async (result) => {
      setOneTimeToken(result.token)
      await refresh()
    },
  })
  const trust = useMutation({
    mutationFn: () =>
      api.updateDocumentTrust(
        document,
        document.trust_level === 'trusted_interactive' ? 'untrusted' : 'trusted_interactive',
      ),
    onSuccess: onDocumentUpdated,
  })
  const publicationHref = publication?.url ?? `/p/${slug}`
  return (
    <section className="metadata-editor publication-editor">
      <p className="eyebrow">Rendering & publication</p>
      {document.content_type === 'text/html' && (
        <div className="trust-control">
          <strong>
            {document.trust_level === 'trusted_interactive' ? 'Trusted interactive HTML' : 'Safe HTML'}
          </strong>
          <small>
            {document.trust_level === 'trusted_interactive'
              ? 'JavaScript runs only in the isolated preview origin.'
              : 'Scripts are removed and the preview iframe cannot execute code.'}
          </small>
          <button
            disabled={trust.isPending}
            onClick={() => {
              if (
                document.trust_level === 'trusted_interactive' ||
                window.confirm('Trust this HTML to run JavaScript in the isolated preview origin?')
              ) {
                trust.mutate()
              }
            }}
          >
            {document.trust_level === 'trusted_interactive'
              ? 'Return to safe HTML'
              : 'Trust interactive HTML'}
          </button>
        </div>
      )}
      <label>
        <span>Stable slug</span>
        <input value={slug} onChange={(event) => setSlug(event.target.value)} />
      </label>
      <label>
        <span>Access</span>
        <select
          value={accessPolicy}
          onChange={(event) => setAccessPolicy(event.target.value as Publication['access_policy'])}
        >
          <option value="private">Private</option>
          <option value="unlisted">Unlisted</option>
          <option value="public">Public</option>
        </select>
      </label>
      <button disabled={save.isPending || !slug} onClick={() => save.mutate()}>
        {publication ? 'Update publication' : 'Publish document'}
      </button>
      {publication?.active && (
        <div className="publication-actions">
          <a href={publicationHref} target="_blank" rel="noreferrer">
            Open stable URL
          </a>
          {publication.access_policy === 'unlisted' && (
            <button disabled={rotate.isPending} onClick={() => rotate.mutate()}>
              Rotate access token
            </button>
          )}
          <button disabled={remove.isPending} onClick={() => remove.mutate()}>
            Unpublish
          </button>
        </div>
      )}
      {oneTimeToken && (
        <div className="one-time-token compact" role="status">
          <strong>Copy this unlisted link now</strong>
          <code>{`${publicationHref}#token=${oneTimeToken}`}</code>
          <button
            onClick={() => void navigator.clipboard.writeText(`${publicationHref}#token=${oneTimeToken}`)}
          >
            Copy link
          </button>
        </div>
      )}
      {(save.isError || remove.isError || rotate.isError || trust.isError) && (
        <p className="error-text">The publication setting could not be saved.</p>
      )}
    </section>
  )
}

function MetadataEditor({
  document,
  tags,
  onUpdated,
}: {
  document: Document
  tags: Tag[]
  onUpdated: (document: Document) => void
}) {
  const [category, setCategory] = useState(document.category ?? '')
  const [selectedTags, setSelectedTags] = useState(document.tags.map((tag) => tag.tag_id))
  const mutation = useMutation({
    mutationFn: () => api.updateDocumentMetadata(document, category || null, selectedTags),
    onSuccess: onUpdated,
  })
  return (
    <section className="metadata-editor">
      <label>
        <span>Category</span>
        <input
          value={category}
          placeholder="e.g. Research"
          onChange={(event) => setCategory(event.target.value)}
        />
      </label>
      <fieldset>
        <legend>Tags</legend>
        {tags.length === 0 && <p className="small-muted">Create tags in Workspace settings.</p>}
        <div className="tag-checklist">
          {tags.map((tag) => (
            <label key={tag.tag_id}>
              <input
                type="checkbox"
                checked={selectedTags.includes(tag.tag_id)}
                onChange={() =>
                  setSelectedTags((current) =>
                    current.includes(tag.tag_id)
                      ? current.filter((id) => id !== tag.tag_id)
                      : [...current, tag.tag_id],
                  )
                }
              />
              <i style={{ background: tag.color }} />
              {tag.name}
            </label>
          ))}
        </div>
      </fieldset>
      <button className="panel-button" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save organization'}
      </button>
      {mutation.isError && <p className="error-text">{mutation.error.message}</p>}
    </section>
  )
}
