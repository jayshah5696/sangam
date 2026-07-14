import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { ApiError, api, type Document, type Tag } from '../api'
import { MarkdownEditor } from '../components/MarkdownEditor'
import { ResizeHandle } from '../components/ResizeHandle'
import { useTheme } from '../theme'

export const Route = createFileRoute('/documents/$documentId')({ component: DocumentPage })

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'failed'

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
  const queryClient = useQueryClient()
  const { preferences, updatePreferences } = useTheme()
  const document = queryClient.getQueryData<Document>(['document', documentId]) ?? initialDocument
  const historyQuery = useQuery({
    queryKey: ['history', documentId],
    queryFn: () => api.history(documentId),
  })
  const tagsQuery = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const [content, setContent] = useState(initialDocument.content)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [materializePath, setMaterializePath] = useState('projects/first-document.md')

  const updateCachedDocument = (nextDocument: Document) => {
    queryClient.setQueryData(['document', documentId], nextDocument)
    void queryClient.invalidateQueries({ queryKey: ['documents'] })
    void queryClient.invalidateQueries({ queryKey: ['history', documentId] })
    void queryClient.invalidateQueries({ queryKey: ['folders'] })
  }
  const save = useMutation({
    mutationFn: ({ base, nextContent }: { base: Document; nextContent: string }) => api.updateDocument(base, nextContent),
    onMutate: () => setSaveState('saving'),
    onSuccess: (nextDocument, variables) => {
      updateCachedDocument(nextDocument)
      setSaveState(content === variables.nextContent ? 'saved' : 'dirty')
    },
    onError: (error) => setSaveState(error instanceof ApiError && error.status === 409 ? 'conflict' : 'failed'),
  })
  useEffect(() => {
    if (content === document.content || save.isPending || saveState === 'conflict') return
    const timeout = window.setTimeout(() => save.mutate({ base: document, nextContent: content }), 800)
    return () => window.clearTimeout(timeout)
  }, [content, document, save, saveState])

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
    if (nextContent !== document.content && saveState !== 'conflict') setSaveState('dirty')
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
            </div>
          </div>
          <span className={`save-state ${saveState}`}>{saveLabel(saveState)}</span>
        </header>
        {saveState === 'conflict' && (
          <div className="notice conflict-notice">
            This document changed elsewhere. Your text is still here.
            <button onClick={() => void reloadAfterConflict()}>Reload current revision</button>
          </div>
        )}
        {saveState === 'failed' && <div className="notice error-notice">Save failed. Your text remains in this editor; edit again to retry.</div>}
        {!document.path && (
          <form className="materialize-bar" onSubmit={(event) => {
            event.preventDefault()
            materialize.mutate({ base: document, path: materializePath })
          }}>
            <input aria-label="Workspace path" value={materializePath} onChange={(event) => setMaterializePath(event.target.value)} />
            <button disabled={materialize.isPending || saveState !== 'saved'}>{materialize.isPending ? 'Saving file…' : 'Save to workspace'}</button>
          </form>
        )}
        <MarkdownEditor value={content} onChange={handleEditorChange} />
      </section>
      {preferences.rightVisible ? (
        <>
          <ResizeHandle
            side="right"
            value={preferences.rightWidth}
            min={270}
            max={460}
            onChange={(rightWidth) => updatePreferences({ rightWidth })}
          />
          <aside className="history-panel" style={{ width: preferences.rightWidth }}>
            <div className="right-panel-header">
              <p className="eyebrow">Document</p>
              <button className="icon-button" aria-label="Collapse document sidebar" onClick={() => updatePreferences({ rightVisible: false })}>›</button>
            </div>
            <MetadataEditor
              key={document.metadata_version}
              document={document}
              tags={tagsQuery.data ?? []}
              onUpdated={updateCachedDocument}
            />
            <section className="history-section">
              <p className="eyebrow">History</p>
              {historyQuery.data?.map((revision, index) => (
                <article className="revision" key={revision.revision_id}>
                  <div><strong>{revision.operation}</strong><time>{new Date(revision.created_at).toLocaleString()}</time></div>
                  <p>{revision.actor_id}{revision.summary ? ` · ${revision.summary}` : ''}</p>
                  {index > 0 && (
                    <button disabled={restore.isPending || saveState !== 'saved'} onClick={() => restore.mutate({ base: document, revisionId: revision.revision_id })}>Restore this version</button>
                  )}
                </article>
              ))}
            </section>
          </aside>
        </>
      ) : (
        <aside className="right-rail">
          <button className="icon-button" aria-label="Open document sidebar" onClick={() => updatePreferences({ rightVisible: true })}>‹</button>
        </aside>
      )}
    </div>
  )
}

function MetadataEditor({ document, tags, onUpdated }: { document: Document; tags: Tag[]; onUpdated: (document: Document) => void }) {
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
        <input value={category} placeholder="e.g. Research" onChange={(event) => setCategory(event.target.value)} />
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
                onChange={() => setSelectedTags((current) => current.includes(tag.tag_id) ? current.filter((id) => id !== tag.tag_id) : [...current, tag.tag_id])}
              />
              <i style={{ background: tag.color }} />{tag.name}
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

function saveLabel(state: SaveState) {
  return { saved: 'Saved', dirty: 'Unsaved changes', saving: 'Saving…', conflict: 'Conflict', failed: 'Save failed' }[state]
}
