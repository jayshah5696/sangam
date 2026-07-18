import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Columns2, MoreHorizontal, PanelRightClose, Rows2 } from 'lucide-react'
import { api, type Document } from '../../api'
import {
  useDocumentSession,
  useDocumentSessions,
  type EditorMode,
  type SaveState,
} from '../../documentSessions'
import { internalDocumentMarkdown } from '../../internalLinks'
import { useTheme } from '../../theme'
import { useWorkbenchActions } from '../../workbench'
import { canSplitActiveGroup } from '../../splitPolicy'
import { ActionMenu, ActionMenuItem } from '../ActionMenu'
import type { MarkdownEditorHandle } from '../MarkdownEditor'
import { ResizeHandle } from '../ResizeHandle'
import { DocumentInspector } from './DocumentInspector'

const MarkdownPreview = lazy(() =>
  import('../MarkdownPreview').then((module) => ({ default: module.MarkdownPreview })),
)
const MarkdownEditor = lazy(() =>
  import('../MarkdownEditor').then((module) => ({ default: module.MarkdownEditor })),
)
const HtmlPreview = lazy(() => import('../HtmlPreview').then((module) => ({ default: module.HtmlPreview })))
const TrustedHtmlPreview = lazy(() =>
  import('../TrustedHtmlPreview').then((module) => ({ default: module.TrustedHtmlPreview })),
)

export function DocumentWorkspace({
  initialDocument,
  showInspector,
  canCloseGroup,
  onSplit,
  onCloseGroup,
  onDeleted,
}: {
  initialDocument: Document
  showInspector: boolean
  canCloseGroup: boolean
  onSplit: (direction: 'horizontal' | 'vertical') => void
  onCloseGroup: () => void
  onDeleted: () => void
}) {
  const documentId = initialDocument.document_id
  const queryClient = useQueryClient()
  const { preferences, updatePreferences } = useTheme()
  const { updateDocumentTitle } = useWorkbenchActions()
  const sessions = useDocumentSessions()
  const session = useDocumentSession(documentId)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const document = queryClient.getQueryData<Document>(['document', documentId]) ?? initialDocument
  const content = session.content ?? document.content
  const saveState = session.saveState
  const mode = session.mode
  const selection = session.selection
  const documentsQuery = useQuery({ queryKey: ['documents', 'links'], queryFn: api.listDocuments })
  const [materializePath, setMaterializePath] = useState(
    document.content_type === 'text/html' ? 'projects/interactive.html' : 'projects/first-document.md',
  )
  const [linkTarget, setLinkTarget] = useState('')

  useEffect(() => {
    void sessions.initializeDocument(initialDocument)
  }, [initialDocument, sessions])
  useEffect(
    () => updateDocumentTitle(documentId, document.title),
    [document.title, documentId, updateDocumentTitle],
  )

  const updateCachedDocument = (nextDocument: Document, replaceContent = false) => {
    queryClient.setQueryData(['document', documentId], nextDocument)
    sessions.acceptServerDocument(nextDocument, replaceContent)
    updateDocumentTitle(documentId, nextDocument.title)
    void queryClient.invalidateQueries({ queryKey: ['documents'] })
    void queryClient.invalidateQueries({ queryKey: ['history', documentId] })
    void queryClient.invalidateQueries({ queryKey: ['folders'] })
  }
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (content !== document.content) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [content, document.content])

  const materialize = useMutation({
    mutationFn: ({ base, path }: { base: Document; path: string }) => api.materializeDocument(base, path),
    onSuccess: (nextDocument) => updateCachedDocument(nextDocument),
  })
  const reloadAfterConflict = async () => {
    const current = await api.getDocument(documentId)
    updateCachedDocument(current, true)
  }
  const handleEditorChange = (nextContent: string) => {
    sessions.updateSession(documentId, {
      content: nextContent,
      baseRevisionId: session.baseRevisionId ?? document.current_revision_id,
    })
  }
  const insertLink = () => {
    const target = documentsQuery.data?.find((candidate) => candidate.document_id === linkTarget)
    if (target) editorRef.current?.insertText(internalDocumentMarkdown(target))
  }

  return (
    <div className="document-layout tab-document-layout">
      <section className="document-workspace">
        <header className="document-header">
          <div>
            <p className="eyebrow">{document.path ?? 'Unmaterialized draft'}</p>
            <h1>{document.title}</h1>
            <div className="document-badges">
              {document.category && <span className="category-badge">{document.category}</span>}
              {document.tags.map((tag) => (
                <span className="tag-badge" key={tag.tag_id}>
                  <i style={{ background: tag.color }} />
                  {tag.name}
                </span>
              ))}
              <span className="actor-badge">Edited by {document.updated_by_name}</span>
              <span className="scope-badge">
                {document.content_type === 'text/html' ? 'HTML' : 'Markdown'}
              </span>
              {document.content_type === 'text/html' && (
                <span
                  className={`scope-badge ${document.trust_level === 'trusted_interactive' ? 'workspace' : ''}`}
                >
                  {document.trust_level === 'trusted_interactive' ? 'Trusted interactive' : 'Safe HTML'}
                </span>
              )}
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
          onMode={(nextMode) => sessions.updateSession(documentId, { mode: nextMode })}
          canCloseGroup={canCloseGroup}
          onSplit={onSplit}
          onCloseGroup={onCloseGroup}
          onUpdated={(updated) => updateCachedDocument(updated)}
          onDeleted={async () => {
            await queryClient.invalidateQueries({ queryKey: ['documents'] })
            onDeleted()
          }}
        />
        {saveState === 'conflict' && (
          <div className="notice conflict-notice">
            This document changed elsewhere. Your text is still here.
            <button onClick={() => void reloadAfterConflict()}>Reload current revision</button>
          </div>
        )}
        {saveState === 'failed' && (
          <div className="notice error-notice">
            Save failed. Your text remains in this editor; edit again to retry.
          </div>
        )}
        {saveState === 'offline' && (
          <div className="notice offline-notice">
            You are offline. Changes remain in this browser and will save after reconnecting.
          </div>
        )}
        {!document.path && (
          <form
            className="materialize-bar"
            onSubmit={(event) => {
              event.preventDefault()
              materialize.mutate({ base: document, path: materializePath })
            }}
          >
            <input
              aria-label="Workspace path"
              value={materializePath}
              onChange={(event) => setMaterializePath(event.target.value)}
            />
            <button disabled={materialize.isPending || saveState !== 'saved'}>
              {materialize.isPending ? 'Saving file…' : 'Save to workspace'}
            </button>
          </form>
        )}
        {mode !== 'preview' && (
          <div className="editor-tools">
            <label>
              Internal link
              <select value={linkTarget} onChange={(event) => setLinkTarget(event.target.value)}>
                <option value="">Choose a document…</option>
                {documentsQuery.data
                  ?.filter((candidate) => candidate.document_id !== documentId)
                  .map((candidate) => (
                    <option key={candidate.document_id} value={candidate.document_id}>
                      {candidate.path ?? candidate.title}
                    </option>
                  ))}
              </select>
            </label>
            <button type="button" disabled={!linkTarget} onClick={insertLink}>
              Insert link
            </button>
            <span>
              Ln {selection.line}, Col {selection.column}
              {selection.selectedCharacters ? ` · ${selection.selectedCharacters} selected` : ''}
            </span>
            <kbd>⌘F</kbd>
            <small>find/replace</small>
          </div>
        )}
        <div className={`editing-surface mode-${mode}`}>
          {mode !== 'preview' && (
            <Suspense fallback={<div className="editor muted">Preparing editor…</div>}>
              <MarkdownEditor
                ref={editorRef}
                value={content}
                contentType={document.content_type}
                onChange={handleEditorChange}
                onSelectionChange={(nextSelection) =>
                  sessions.updateSession(documentId, { selection: nextSelection })
                }
                initialViewState={session.viewState}
                onViewStateChange={(viewState) => sessions.updateSession(documentId, { viewState })}
              />
            </Suspense>
          )}
          {mode !== 'edit' && document.content_type === 'text/markdown' && (
            <Suspense fallback={<div className="markdown-preview muted">Preparing preview…</div>}>
              <MarkdownPreview content={content} />
            </Suspense>
          )}
          {mode !== 'edit' && document.content_type === 'text/html' && (
            <Suspense fallback={<div className="markdown-preview muted">Preparing HTML preview…</div>}>
              {document.trust_level === 'trusted_interactive' && saveState === 'saved' ? (
                <TrustedHtmlPreview document={document} revisionId={document.current_revision_id} />
              ) : (
                <HtmlPreview content={content} />
              )}
            </Suspense>
          )}
        </div>
      </section>
      {showInspector &&
        (preferences.rightVisible ? (
          <>
            <ResizeHandle
              side="right"
              value={preferences.rightWidth}
              min={290}
              max={720}
              onChange={(rightWidth) => updatePreferences({ rightWidth })}
            />
            <DocumentInspector
              width={preferences.rightWidth}
              document={document}
              content={content}
              onCollapse={() => updatePreferences({ rightVisible: false })}
              onUpdated={updateCachedDocument}
              onFocusEditor={() => editorRef.current?.focus()}
            />
          </>
        ) : (
          <aside className="right-rail">
            <button
              className="icon-button"
              aria-label="Open document sidebar"
              onClick={() => updatePreferences({ rightVisible: true })}
            >
              ‹
            </button>
          </aside>
        ))}
    </div>
  )
}

function DocumentToolbar({
  document,
  content,
  saveState,
  mode,
  onMode,
  canCloseGroup,
  onSplit,
  onCloseGroup,
  onUpdated,
  onDeleted,
}: {
  document: Document
  content: string
  saveState: SaveState
  mode: EditorMode
  onMode: (mode: EditorMode) => void
  canCloseGroup: boolean
  onSplit: (direction: 'horizontal' | 'vertical') => void
  onCloseGroup: () => void
  onUpdated: (document: Document) => void
  onDeleted: () => Promise<void>
}) {
  const navigate = useNavigate()
  const [title, setTitle] = useState(document.title)
  const [path, setPath] = useState(document.path ?? '')
  const rename = useMutation({
    mutationFn: () => api.updateDocument(document, content, title),
    onSuccess: onUpdated,
  })
  const move = useMutation({ mutationFn: () => api.moveDocument(document, path), onSuccess: onUpdated })
  const duplicate = useMutation({
    mutationFn: () => api.duplicateDocument(document),
    onSuccess: async (created) =>
      navigate({ to: '/documents/$documentId', params: { documentId: created.document_id } }),
  })
  const remove = useMutation({ mutationFn: () => api.deleteDocument(document), onSuccess: onDeleted })
  const busy =
    saveState !== 'saved' || rename.isPending || move.isPending || duplicate.isPending || remove.isPending
  return (
    <div className="document-toolbar">
      <div className="mode-switch" aria-label="Editor view">
        {(['edit', 'split', 'preview'] as const).map((candidate) => (
          <button
            key={candidate}
            className={mode === candidate ? 'active' : ''}
            onClick={() => onMode(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>
      <ActionMenu
        label="Document actions"
        icon={<MoreHorizontal size={16} />}
        className="document-actions-trigger"
        role="dialog"
      >
        {(close) => (
          <div className="document-actions-form">
            <div className="document-layout-actions">
              <ActionMenuItem
                disabled={!canSplitActiveGroup('horizontal')}
                onSelect={() => {
                  onSplit('horizontal')
                  close()
                }}
              >
                <Columns2 size={13} /> Split right
              </ActionMenuItem>
              <ActionMenuItem
                disabled={!canSplitActiveGroup('vertical')}
                onSelect={() => {
                  onSplit('vertical')
                  close()
                }}
              >
                <Rows2 size={13} /> Split down
              </ActionMenuItem>
              {canCloseGroup && (
                <ActionMenuItem
                  onSelect={() => {
                    onCloseGroup()
                    close()
                  }}
                >
                  <PanelRightClose size={13} /> Close group
                </ActionMenuItem>
              )}
            </div>
            <hr />
            <label>
              Title
              <input value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <button
              disabled={busy || !title.trim() || title === document.title}
              onClick={() => rename.mutate(undefined, { onSuccess: close })}
            >
              Rename
            </button>
            {document.path && (
              <>
                <label>
                  Path
                  <input value={path} onChange={(event) => setPath(event.target.value)} />
                </label>
                <button
                  disabled={busy || path === document.path}
                  onClick={() => move.mutate(undefined, { onSuccess: close })}
                >
                  Move
                </button>
              </>
            )}
            <button
              disabled={busy}
              onClick={() => {
                duplicate.mutate()
                close()
              }}
            >
              Duplicate as draft
            </button>
            <button
              className="danger-button"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`Move “${document.title}” to trash?`)) remove.mutate()
                close()
              }}
            >
              Move to trash
            </button>
            {(rename.isError || move.isError || duplicate.isError || remove.isError) && (
              <p className="error-text">The document action could not be completed.</p>
            )}
          </div>
        )}
      </ActionMenu>
    </div>
  )
}

function saveLabel(state: SaveState) {
  return {
    saved: 'Saved',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    conflict: 'Conflict',
    failed: 'Save failed',
    offline: 'Offline · unsaved',
  }[state]
}
