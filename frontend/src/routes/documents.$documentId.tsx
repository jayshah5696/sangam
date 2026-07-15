import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { ApiError, api, type Document, type Revision, type Tag } from '../api'
import type { EditorSelection, MarkdownEditorHandle } from '../components/MarkdownEditor'
import { ResizeHandle } from '../components/ResizeHandle'
import { internalDocumentMarkdown } from '../internalLinks'
import { useTheme } from '../theme'

export const Route = createFileRoute('/documents/$documentId')({ component: DocumentPage })

const MarkdownPreview = lazy(() => import('../components/MarkdownPreview').then((module) => ({
  default: module.MarkdownPreview,
})))
const MarkdownEditor = lazy(() => import('../components/MarkdownEditor').then((module) => ({
  default: module.MarkdownEditor,
})))

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'failed' | 'offline'
type EditorMode = 'edit' | 'split' | 'preview'

function DocumentPage() {
  const { documentId } = Route.useParams()
  const documentQuery = useQuery({
    queryKey: ['document', documentId],
    queryFn: () => api.getDocument(documentId),
  })
  if (documentQuery.isLoading) return <div className="center-message">Opening document…</div>
  if (documentQuery.isError || !documentQuery.data) {
    return <div className="center-message error-text">Document could not be opened.</div>
  }
  return <DocumentWorkspace key={documentId} initialDocument={documentQuery.data} />
}

function DocumentWorkspace({ initialDocument }: { initialDocument: Document }) {
  const documentId = initialDocument.document_id
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { preferences, updatePreferences } = useTheme()
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const document = queryClient.getQueryData<Document>(['document', documentId]) ?? initialDocument
  const historyQuery = useQuery({ queryKey: ['history', documentId], queryFn: () => api.history(documentId) })
  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const documentsQuery = useQuery({ queryKey: ['documents', 'links'], queryFn: api.listDocuments })
  const [content, setContent] = useState(initialDocument.content)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [materializePath, setMaterializePath] = useState('projects/first-document.md')
  const [mode, setMode] = useState<EditorMode>('edit')
  const [selection, setSelection] = useState<EditorSelection>({ line: 1, column: 1, selectedCharacters: 0 })
  const [compareRevision, setCompareRevision] = useState<string | null>(null)
  const [linkTarget, setLinkTarget] = useState('')

  const updateCachedDocument = (nextDocument: Document) => {
    queryClient.setQueryData(['document', documentId], nextDocument)
    void queryClient.invalidateQueries({ queryKey: ['documents'] })
    void queryClient.invalidateQueries({ queryKey: ['history', documentId] })
    void queryClient.invalidateQueries({ queryKey: ['folders'] })
  }
  const save = useMutation({
    mutationFn: ({ base, nextContent }: { base: Document; nextContent: string }) => api.updateDocument(base, nextContent),
    onMutate: () => setSaveState(navigator.onLine ? 'saving' : 'offline'),
    onSuccess: (nextDocument, variables) => {
      updateCachedDocument(nextDocument)
      setSaveState(content === variables.nextContent ? 'saved' : 'dirty')
    },
    onError: (error) => setSaveState(error instanceof ApiError && error.status === 409 ? 'conflict' : navigator.onLine ? 'failed' : 'offline'),
  })
  useEffect(() => {
    if (content === document.content || save.isPending || saveState === 'conflict' || !navigator.onLine) return
    const timeout = window.setTimeout(() => save.mutate({ base: document, nextContent: content }), 800)
    return () => window.clearTimeout(timeout)
  }, [content, document, save, saveState])
  useEffect(() => {
    const handleOnline = () => setSaveState(content === document.content ? 'saved' : 'dirty')
    const handleOffline = () => setSaveState(content === document.content ? 'saved' : 'offline')
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [content, document.content])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (content !== document.content) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [content, document.content])

  const materialize = useMutation({
    mutationFn: ({ base, path }: { base: Document; path: string }) => api.materializeDocument(base, path),
    onSuccess: updateCachedDocument,
  })
  const restore = useMutation({
    mutationFn: ({ base, revisionId }: { base: Document; revisionId: string }) => api.restore(base, revisionId),
    onSuccess: (nextDocument) => {
      updateCachedDocument(nextDocument)
      setContent(nextDocument.content)
      setSaveState('saved')
      setCompareRevision(null)
    },
  })
  const reloadAfterConflict = async () => {
    const current = await api.getDocument(documentId)
    updateCachedDocument(current)
    setContent(current.content)
    setSaveState('saved')
  }
  const handleEditorChange = (nextContent: string) => {
    setContent(nextContent)
    if (nextContent !== document.content && saveState !== 'conflict') setSaveState(navigator.onLine ? 'dirty' : 'offline')
  }
  const insertLink = () => {
    const target = documentsQuery.data?.find((candidate) => candidate.document_id === linkTarget)
    if (target) editorRef.current?.insertText(internalDocumentMarkdown(target))
  }

  return (
    <div className="document-layout">
      <section className="document-workspace">
        <header className="document-header">
          <div>
            <p className="eyebrow">{document.path ?? 'Unmaterialized draft'}</p>
            <h1>{document.title}</h1>
            <div className="document-badges">
              {document.category && <span className="category-badge">{document.category}</span>}
              {document.tags.map((tag) => <span className="tag-badge" key={tag.tag_id}><i style={{ background: tag.color }} />{tag.name}</span>)}
              <span className="actor-badge">Edited by {document.updated_by_name}</span>
              <time>{new Date(document.updated_at).toLocaleString()}</time>
            </div>
          </div>
          <span className={`save-state ${saveState}`}>{saveLabel(saveState)}</span>
        </header>
        <DocumentToolbar
          document={document}
          content={content}
          saveState={saveState}
          mode={mode}
          onMode={setMode}
          onUpdated={(updated) => {
            updateCachedDocument(updated)
            setContent(updated.content)
            setSaveState('saved')
          }}
          onDeleted={async () => {
            await queryClient.invalidateQueries({ queryKey: ['documents'] })
            await navigate({ to: '/trash' })
          }}
        />
        {saveState === 'conflict' && (
          <div className="notice conflict-notice">This document changed elsewhere. Your text is still here.<button onClick={() => void reloadAfterConflict()}>Reload current revision</button></div>
        )}
        {saveState === 'failed' && <div className="notice error-notice">Save failed. Your text remains in this editor; edit again to retry.</div>}
        {saveState === 'offline' && <div className="notice offline-notice">You are offline. Changes remain in this editor and will save after reconnecting.</div>}
        {!document.path && (
          <form className="materialize-bar" onSubmit={(event) => {
            event.preventDefault()
            materialize.mutate({ base: document, path: materializePath })
          }}>
            <input aria-label="Workspace path" value={materializePath} onChange={(event) => setMaterializePath(event.target.value)} />
            <button disabled={materialize.isPending || saveState !== 'saved'}>{materialize.isPending ? 'Saving file…' : 'Save to workspace'}</button>
          </form>
        )}
        {mode !== 'preview' && (
          <div className="editor-tools">
            <label>Internal link
              <select value={linkTarget} onChange={(event) => setLinkTarget(event.target.value)}>
                <option value="">Choose a document…</option>
                {documentsQuery.data?.filter((candidate) => candidate.document_id !== documentId).map((candidate) => (
                  <option key={candidate.document_id} value={candidate.document_id}>{candidate.path ?? candidate.title}</option>
                ))}
              </select>
            </label>
            <button type="button" disabled={!linkTarget} onClick={insertLink}>Insert link</button>
            <span>Ln {selection.line}, Col {selection.column}{selection.selectedCharacters ? ` · ${selection.selectedCharacters} selected` : ''}</span>
            <kbd>⌘F</kbd><small>find/replace</small>
          </div>
        )}
        <div className={`editing-surface mode-${mode}`}>
          {mode !== 'preview' && <Suspense fallback={<div className="editor muted">Preparing editor…</div>}><MarkdownEditor ref={editorRef} value={content} onChange={handleEditorChange} onSelectionChange={setSelection} /></Suspense>}
          {mode !== 'edit' && <Suspense fallback={<div className="markdown-preview muted">Preparing preview…</div>}><MarkdownPreview content={content} /></Suspense>}
        </div>
      </section>
      {preferences.rightVisible ? (
        <>
          <ResizeHandle side="right" value={preferences.rightWidth} min={270} max={520} onChange={(rightWidth) => updatePreferences({ rightWidth })} />
          <aside className="history-panel" style={{ width: preferences.rightWidth }}>
            <div className="right-panel-header"><p className="eyebrow">Document</p><button className="icon-button" aria-label="Collapse document sidebar" onClick={() => updatePreferences({ rightVisible: false })}>›</button></div>
            <MetadataEditor key={document.metadata_version} document={document} tags={tagsQuery.data ?? []} onUpdated={updateCachedDocument} />
            {compareRevision && <RevisionDiffView documentId={documentId} revisionId={compareRevision} onClose={() => setCompareRevision(null)} />}
            <HistoryList
              history={historyQuery.data ?? []}
              currentRevisionId={document.current_revision_id}
              busy={restore.isPending || saveState !== 'saved'}
              onCompare={setCompareRevision}
              onCopy={(revision) => {
                setContent(revision.content)
                setSaveState(revision.content === document.content ? 'saved' : 'dirty')
                editorRef.current?.focus()
              }}
              onRestore={(revisionId) => restore.mutate({ base: document, revisionId })}
            />
          </aside>
        </>
      ) : (
        <aside className="right-rail"><button className="icon-button" aria-label="Open document sidebar" onClick={() => updatePreferences({ rightVisible: true })}>‹</button></aside>
      )}
    </div>
  )
}

function DocumentToolbar({ document, content, saveState, mode, onMode, onUpdated, onDeleted }: {
  document: Document
  content: string
  saveState: SaveState
  mode: EditorMode
  onMode: (mode: EditorMode) => void
  onUpdated: (document: Document) => void
  onDeleted: () => Promise<void>
}) {
  const navigate = useNavigate()
  const [title, setTitle] = useState(document.title)
  const [path, setPath] = useState(document.path ?? '')
  const rename = useMutation({ mutationFn: () => api.updateDocument(document, content, title), onSuccess: onUpdated })
  const move = useMutation({ mutationFn: () => api.moveDocument(document, path), onSuccess: onUpdated })
  const duplicate = useMutation({
    mutationFn: () => api.duplicateDocument(document),
    onSuccess: async (created) => navigate({ to: '/documents/$documentId', params: { documentId: created.document_id } }),
  })
  const remove = useMutation({ mutationFn: () => api.deleteDocument(document), onSuccess: onDeleted })
  const busy = saveState !== 'saved' || rename.isPending || move.isPending || duplicate.isPending || remove.isPending
  return (
    <div className="document-toolbar">
      <div className="mode-switch" aria-label="Editor view">
        {(['edit', 'split', 'preview'] as const).map((candidate) => <button key={candidate} className={mode === candidate ? 'active' : ''} onClick={() => onMode(candidate)}>{candidate}</button>)}
      </div>
      <details className="document-actions">
        <summary>Document actions</summary>
        <div className="action-popover">
          <label>Title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <button disabled={busy || !title.trim() || title === document.title} onClick={() => rename.mutate()}>Rename</button>
          {document.path && <><label>Path<input value={path} onChange={(event) => setPath(event.target.value)} /></label><button disabled={busy || path === document.path} onClick={() => move.mutate()}>Move</button></>}
          <button disabled={busy} onClick={() => duplicate.mutate()}>Duplicate as draft</button>
          <button className="danger-button" disabled={busy} onClick={() => { if (window.confirm(`Move “${document.title}” to trash?`)) remove.mutate() }}>Move to trash</button>
          {(rename.isError || move.isError || duplicate.isError || remove.isError) && <p className="error-text">The document action could not be completed.</p>}
        </div>
      </details>
    </div>
  )
}

function HistoryList({ history, currentRevisionId, busy, onCompare, onCopy, onRestore }: {
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
          <div><strong>{revision.operation}</strong><time>{new Date(revision.created_at).toLocaleString()}</time></div>
          <p>{revision.actor_id}{revision.summary ? ` · ${revision.summary}` : ''}</p>
          {revision.revision_id !== currentRevisionId && <div className="revision-actions"><button onClick={() => onCompare(revision.revision_id)}>Compare</button><button onClick={() => onCopy(revision)}>Copy to editor</button><button disabled={busy} onClick={() => onRestore(revision.revision_id)}>Restore</button></div>}
        </article>
      ))}
    </section>
  )
}

function RevisionDiffView({ documentId, revisionId, onClose }: { documentId: string; revisionId: string; onClose: () => void }) {
  const diff = useQuery({ queryKey: ['diff', documentId, revisionId], queryFn: () => api.revisionDiff(documentId, revisionId) })
  return (
    <section className="diff-panel">
      <div><p className="eyebrow">Revision diff</p><button className="icon-button" aria-label="Close diff" onClick={onClose}>×</button></div>
      {diff.isLoading && <p className="muted">Building line diff…</p>}
      {diff.isError && <p className="error-text">Diff could not be loaded.</p>}
      {diff.data && <><p className="diff-summary"><span>+{diff.data.additions}</span> <span>−{diff.data.deletions}</span></p><pre className="revision-diff">{diff.data.unified_diff.split('\n').map((line, index) => <code className={line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : line.startsWith('@@') ? 'hunk' : ''} key={`${index}-${line}`}>{line || ' '}{'\n'}</code>)}</pre></>}
    </section>
  )
}

function MetadataEditor({ document, tags, onUpdated }: { document: Document; tags: Tag[]; onUpdated: (document: Document) => void }) {
  const [category, setCategory] = useState(document.category ?? '')
  const [selectedTags, setSelectedTags] = useState(document.tags.map((tag) => tag.tag_id))
  const mutation = useMutation({ mutationFn: () => api.updateDocumentMetadata(document, category || null, selectedTags), onSuccess: onUpdated })
  return (
    <section className="metadata-editor">
      <label><span>Category</span><input value={category} placeholder="e.g. Research" onChange={(event) => setCategory(event.target.value)} /></label>
      <fieldset><legend>Tags</legend>{tags.length === 0 && <p className="small-muted">Create tags in Workspace settings.</p>}<div className="tag-checklist">{tags.map((tag) => <label key={tag.tag_id}><input type="checkbox" checked={selectedTags.includes(tag.tag_id)} onChange={() => setSelectedTags((current) => current.includes(tag.tag_id) ? current.filter((id) => id !== tag.tag_id) : [...current, tag.tag_id])} /><i style={{ background: tag.color }} />{tag.name}</label>)}</div></fieldset>
      <button className="panel-button" onClick={() => mutation.mutate()} disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save organization'}</button>
      {mutation.isError && <p className="error-text">{mutation.error.message}</p>}
    </section>
  )
}

function saveLabel(state: SaveState) {
  return { saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', conflict: 'Conflict', failed: 'Save failed', offline: 'Offline · unsaved' }[state]
}
