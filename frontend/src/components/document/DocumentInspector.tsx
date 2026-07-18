import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api, type Document, type Revision, type Tag } from '../../api'
import { useDocumentSession, useDocumentSessions } from '../../documentSessions'
import { RevisionMergeView } from '../RevisionMergeView'

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
  const historyQuery = useQuery({ queryKey: ['history', documentId], queryFn: () => api.history(documentId) })
  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
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
    <aside className="history-panel document-inspector ui-rail ui-rail--surface" style={{ width }}>
      <div className="right-panel-header ui-rail-header">
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
        <MetadataEditor
          key={document.metadata_version}
          document={document}
          tags={tagsQuery.data ?? []}
          onUpdated={onUpdated}
        />
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
          <HistoryList
            history={history}
            currentRevisionId={document.current_revision_id}
            busy={restore.isPending || session.saveState !== 'saved'}
            onCompare={(revisionId) => setComparison(revisionId, document.current_revision_id)}
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
  onCopy,
  onRestore,
}: {
  history: Revision[]
  currentRevisionId: string
  busy: boolean
  onCompare: (revisionId: string) => void
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
          {revision.operation_id && (
            <small className="revision-operation-id">Operation {revision.operation_id}</small>
          )}
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
