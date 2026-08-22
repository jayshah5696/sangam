import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Columns2, MoreHorizontal, PanelRightClose, PanelRightOpen, Rows2 } from 'lucide-react'
import { api, type Document, type Revision } from '../../api'
import {
  CITATION_NAVIGATION_EVENT,
  citationTargetFromLocation,
  type CitationTarget,
} from '../../citationNavigation'
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
import { ActionDialog } from '../ActionMenu'
import type { MarkdownEditorHandle } from '../MarkdownEditor'
import { ConflictRecoveryNotice } from './ConflictRecoveryNotice'
import { DraftRecoveryNotice, offlineRecoveryMessage } from './DraftRecoveryNotice'

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
const PdfResearchWorkspace = lazy(() =>
  import('../PdfResearchWorkspace').then((module) => ({ default: module.PdfResearchWorkspace })),
)

export function DocumentWorkspace({
  initialDocument,
  canCloseGroup,
  onSplit,
  onCloseGroup,
  onDeleted,
}: {
  initialDocument: Document
  canCloseGroup: boolean
  onSplit: (direction: 'horizontal' | 'vertical') => void
  onCloseGroup: () => void
  onDeleted: () => void
}) {
  const documentId = initialDocument.document_id
  const queryClient = useQueryClient()
  const { updateDocumentTitle } = useWorkbenchActions()
  const sessions = useDocumentSessions()
  const session = useDocumentSession(documentId)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const document = queryClient.getQueryData<Document>(['document', documentId]) ?? initialDocument
  const content = session.content ?? document.content
  const saveState = session.saveState
  const mode = session.mode
  const selection = session.selection
  const documentsQuery = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments })
  const htmlJavascript = useQuery({
    queryKey: ['html-javascript-settings'],
    queryFn: api.getHtmlJavascriptSettings,
    enabled: document.content_type === 'text/html',
  })
  const [materializePath, setMaterializePath] = useState(
    document.content_type === 'text/html' ? 'projects/interactive.html' : 'projects/first-document.md',
  )
  const [linkTarget, setLinkTarget] = useState('')
  const [citationTarget, setCitationTarget] = useState<CitationTarget | null>(() =>
    citationTargetFromLocation(documentId),
  )

  useEffect(() => {
    void sessions.initializeDocument(initialDocument)
  }, [initialDocument, sessions])
  useEffect(
    () => updateDocumentTitle(documentId, document.title),
    [document.title, documentId, updateDocumentTitle],
  )
  const workspaceRef = useRef<HTMLElement>(null)
  useEffect(
    () =>
      sessions.registerEditor(
        documentId,
        () => editorRef.current?.focus(),
        (line) => {
          editorRef.current?.scrollToLine(line)
          const target = workspaceRef.current?.querySelector(`[data-line="${line}"]`)
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        },
      ),
    [documentId, sessions],
  )
  useEffect(() => {
    const receiveCitation = (event: Event) => {
      const target = (event as CustomEvent<CitationTarget>).detail
      if (target.documentId === documentId) setCitationTarget(target)
    }
    window.addEventListener(CITATION_NAVIGATION_EVENT, receiveCitation)
    return () => window.removeEventListener(CITATION_NAVIGATION_EVENT, receiveCitation)
  }, [documentId])

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
  const conflictHeadQuery = useQuery({
    queryKey: ['document-conflict-head', documentId],
    queryFn: () => api.getDocument(documentId),
    enabled: saveState === 'conflict',
    retry: false,
  })
  const citedHistoryQuery = useQuery({
    queryKey: ['history', documentId],
    queryFn: () => api.history(documentId),
    enabled: Boolean(citationTarget?.revisionId),
  })
  const citedRevision = citedHistoryQuery.data?.find(
    (revision) => revision.revision_id === citationTarget?.revisionId,
  )
  const rebaseAndRetry = () => {
    const serverHead = conflictHeadQuery.data
    if (!serverHead) return
    updateCachedDocument(serverHead)
    sessions.updateSession(documentId, {
      content,
      baseRevisionId: serverHead.current_revision_id,
      saveState: 'dirty',
    })
  }
  const discardLocalDraft = () => {
    const serverHead = conflictHeadQuery.data
    if (serverHead) updateCachedDocument(serverHead, true)
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
    <section
      ref={workspaceRef}
      className={`document-workspace ${
        document.content_type === 'text/html' && mode !== 'edit' ? 'html-preview-workspace' : ''
      } ${document.content_type === 'application/pdf' ? 'pdf-document-workspace' : ''}`}
    >
      <header className="document-header">
        <div className="document-header-main">
          <p className="eyebrow">{document.path ?? 'Unmaterialized draft'}</p>
          <h1>{document.title}</h1>
        </div>
        <span className={`save-state ${saveState}`} role="status" aria-live="polite" aria-atomic="true">
          {document.content_type === 'application/pdf' ? 'Immutable source' : saveLabel(saveState)}
        </span>
      </header>
      {document.content_type === 'application/pdf' && <MobileInspectorToggle />}
      {document.content_type !== 'application/pdf' && (
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
      )}
      {document.content_type !== 'application/pdf' && saveState === 'conflict' && (
        <ConflictRecoveryNotice
          document={document}
          localContent={content}
          baseRevisionId={session.baseRevisionId}
          serverHead={conflictHeadQuery.data}
          loading={conflictHeadQuery.isLoading || conflictHeadQuery.isFetching}
          error={conflictHeadQuery.isError}
          retrying={false}
          onRefresh={() => void conflictHeadQuery.refetch()}
          onRebaseAndRetry={rebaseAndRetry}
          onDiscard={discardLocalDraft}
        />
      )}
      {document.content_type !== 'application/pdf' && saveState === 'failed' && (
        <div className="notice error-notice" role="alert">
          <span>Save failed. Sangam stopped retrying so it will not keep sending a failing request.</span>
          <button type="button" onClick={() => sessions.retrySave(documentId)}>
            Retry save
          </button>
        </div>
      )}
      {document.content_type !== 'application/pdf' && saveState === 'offline' && (
        <div className="notice offline-notice" role="status" aria-live="polite">
          {offlineRecoveryMessage(session.draftPersistenceState)}
        </div>
      )}
      {document.content_type !== 'application/pdf' && session.draftPersistenceState === 'failed' && (
        <DraftRecoveryNotice
          title={document.title}
          contentType={document.content_type}
          content={content}
          operation={session.draftPersistenceOperation}
          error={session.draftPersistenceError}
          retrying={false}
          onRetry={() => sessions.retryDraftPersistence(documentId)}
        />
      )}
      {document.content_type !== 'application/pdf' && !document.path && (
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
      {citationTarget?.revisionId && (
        <CitedRevisionEvidence
          document={document}
          target={citationTarget}
          revision={citedRevision}
          loading={citedHistoryQuery.isLoading}
          error={citedHistoryQuery.isError || (citedHistoryQuery.isSuccess && !citedRevision)}
          onClose={() => {
            const url = new URL(window.location.href)
            url.searchParams.delete('revision')
            window.history.replaceState(window.history.state, '', url)
            setCitationTarget(null)
          }}
        />
      )}
      {document.content_type !== 'application/pdf' && mode !== 'preview' && (
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
          <span className="desktop-shortcut">
            <kbd>⌘F</kbd>
            <small>find/replace</small>
          </span>
        </div>
      )}
      <div className={`editing-surface mode-${mode}`}>
        {document.content_type === 'application/pdf' && (
          <Suspense fallback={<div className="center-message">Preparing PDF reader…</div>}>
            <PdfResearchWorkspace document={document} />
          </Suspense>
        )}
        {document.content_type !== 'application/pdf' && mode !== 'preview' && (
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
            {htmlJavascript.data?.enabled && saveState === 'saved' ? (
              <TrustedHtmlPreview document={document} revisionId={document.current_revision_id} />
            ) : (
              <HtmlPreview content={content} />
            )}
          </Suspense>
        )}
      </div>
    </section>
  )
}

function CitedRevisionEvidence({
  document,
  target,
  revision,
  loading,
  error,
  onClose,
}: {
  document: Document
  target: CitationTarget
  revision?: Revision
  loading: boolean
  error: boolean
  onClose: () => void
}) {
  const current = target.revisionId === document.current_revision_id
  return (
    <section className="citation-evidence" aria-labelledby="citation-evidence-title">
      <header>
        <div>
          <p className="eyebrow">Pinned chat citation</p>
          <strong id="citation-evidence-title">
            {current ? 'Cited revision is the current head' : 'Source changed since this citation'}
          </strong>
          <small>
            Cited {shortRevision(target.revisionId)} · current {shortRevision(document.current_revision_id)}
          </small>
        </div>
        <button type="button" className="secondary-action" onClick={onClose}>
          Close cited revision
        </button>
      </header>
      {loading && <p className="small-muted">Loading the immutable cited revision…</p>}
      {error && (
        <p className="error-text">
          The cited revision is not available in this document’s history. The current head has not been
          substituted.
        </p>
      )}
      {!current && revision && (
        <details open>
          <summary>Exact cited content</summary>
          {document.content_type === 'text/markdown' ? (
            <Suspense fallback={<div className="markdown-preview muted">Preparing cited Markdown…</div>}>
              <MarkdownPreview content={revision.content} />
            </Suspense>
          ) : document.content_type === 'text/html' ? (
            <Suspense fallback={<div className="markdown-preview muted">Preparing cited HTML…</div>}>
              <HtmlPreview content={revision.content} />
            </Suspense>
          ) : null}
        </details>
      )}
    </section>
  )
}

function shortRevision(value?: string) {
  if (!value) return 'unknown revision'
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value
}

function MobileInspectorToggle() {
  const { updatePreferences } = useTheme()
  return (
    <button
      type="button"
      className="icon-button mobile-inspector-toggle pdf-mobile-inspector-toggle"
      aria-label="Open document inspector"
      title="Open document inspector"
      onClick={() => updatePreferences({ rightVisible: true, rightTab: 'research' })}
    >
      <PanelRightOpen size={16} />
    </button>
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
  const { updatePreferences } = useTheme()
  const busy =
    saveState !== 'saved' || rename.isPending || move.isPending || duplicate.isPending || remove.isPending
  const changeMode = (nextMode: EditorMode) => {
    onMode(nextMode)
    updatePreferences({ editorMode: nextMode })
  }
  return (
    <div className="document-toolbar">
      <div className="mode-switch" role="radiogroup" aria-label="Editor view">
        {(['edit', 'split', 'preview'] as const).map((candidate) => (
          <button
            key={candidate}
            role="radio"
            aria-checked={mode === candidate}
            className={`${mode === candidate ? 'active' : ''} ${
              candidate === 'split' ? 'mode-split-button' : ''
            }`.trim()}
            onClick={() => changeMode(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>
      <div className="document-toolbar-actions">
        <ActionDialog
          label="Document actions"
          icon={<MoreHorizontal size={16} />}
          className="document-actions-trigger"
        >
          {(close) => (
            <div className="document-actions-form">
              <div className="document-layout-actions">
                <button
                  type="button"
                  className="secondary-action"
                  disabled={!canSplitActiveGroup('horizontal')}
                  onClick={() => {
                    onSplit('horizontal')
                    close()
                  }}
                >
                  <Columns2 size={13} /> Split right
                </button>
                <button
                  type="button"
                  className="secondary-action"
                  disabled={!canSplitActiveGroup('vertical')}
                  onClick={() => {
                    onSplit('vertical')
                    close()
                  }}
                >
                  <Rows2 size={13} /> Split down
                </button>
                {canCloseGroup && (
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => {
                      onCloseGroup()
                      close()
                    }}
                  >
                    <PanelRightClose size={13} /> Close group
                  </button>
                )}
              </div>
              <hr />
              <label>
                Title
                <input value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
              <label>
                Workspace path
                <input value={path} onChange={(event) => setPath(event.target.value)} />
              </label>
              <button
                type="button"
                className="secondary-action"
                disabled={busy}
                onClick={() => {
                  rename.mutate()
                  if (path !== (document.path ?? '')) move.mutate()
                  close()
                }}
              >
                Save details
              </button>
              <button
                type="button"
                className="secondary-action"
                disabled={busy}
                onClick={() => {
                  duplicate.mutate()
                  close()
                }}
              >
                Duplicate
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => {
                  remove.mutate()
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
        </ActionDialog>
        <button
          type="button"
          className="icon-button mobile-inspector-toggle"
          aria-label="Open document inspector"
          title="Open document inspector"
          onClick={() => updatePreferences({ rightVisible: true })}
        >
          <PanelRightOpen size={16} />
        </button>
      </div>
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
