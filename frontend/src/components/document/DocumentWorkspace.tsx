import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  BookmarkCheck,
  Columns2,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Rows2,
} from 'lucide-react'
import { workspaceEvidenceStore } from '../../workspaceEvidenceState'
import {
  evidenceTextForLocator,
  locateEvidencePassage,
  locatePassage,
  type TextLocator,
} from '../../evidenceCitation'
import { StateMessage } from '../ui/StateMessage'
import { SelectableHtmlText } from '../SelectableHtmlText'
import { TextSelectionToolbar, type TextSelectionAnchor } from './TextSelectionToolbar'
import { api, type Document, type Revision } from '../../api'
import {
  CITATION_NAVIGATION_EVENT,
  citationTargetFromLocation,
  clearCitationNavigation,
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
import { initialDocumentMode, materializePath, saveLabel } from '../../documentWorkspaceState'
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
  const { updatePreferences } = useTheme()
  const { updateDocumentTitle } = useWorkbenchActions()
  const sessions = useDocumentSessions()
  const session = useDocumentSession(documentId)
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const editorSelectionSnapshot = useRef<{
    content: string
    selectedText: string
    occurrence: number
    revisionId?: string
  } | null>(null)
  const document = queryClient.getQueryData<Document>(['document', documentId]) ?? initialDocument
  const content = session.content ?? document.content
  const saveState = session.saveState
  const mode = session.mode
  const selection = session.selection
  // Keep the complete document index in its own cache entry. The paged explorer
  // and search queries use different shapes and must never share this key.
  const documentsQuery = useQuery({ queryKey: ['documents', 'all'], queryFn: api.listDocuments })
  const foldersQuery = useQuery({ queryKey: ['folders'], queryFn: api.listFolders, enabled: !document.path })
  const htmlJavascript = useQuery({
    queryKey: ['html-javascript-settings'],
    queryFn: api.getHtmlJavascriptSettings,
    enabled: document.content_type === 'text/html',
  })
  const [materializeFolder, setMaterializeFolder] = useState('')
  const [materializeFilename, setMaterializeFilename] = useState(
    document.content_type === 'text/html' ? 'interactive.html' : 'first-document.md',
  )
  const [linkTarget, setLinkTarget] = useState('')
  const [activeSelection, setActiveSelection] = useState<{
    selectedText: string
    anchor: TextSelectionAnchor
    sourceContent: string
    revisionId?: string
    occurrence: number
  } | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)

  const keepSelection = async (
    selectedText: string,
    sourceContent: string,
    revisionId?: string,
    occurrence = 0,
  ) => {
    try {
      const pinned =
        revisionId ?? (await sessions.flushSnapshot(documentId, sourceContent)).current_revision_id
      const textLocator = locateEvidencePassage(
        sourceContent,
        document.content_type,
        selectedText,
        occurrence,
      )
      if (!textLocator) throw new Error('The selected passage does not match the source. Select it again.')
      await workspaceEvidenceStore.keepEvidence({
        sourceDocumentId: documentId,
        sourceTitle: document.title,
        sourcePath: document.path,
        sourceContentType: document.content_type,
        pinnedRevisionId: pinned,
        selectedText,
        textLocator,
      })
      setCaptureError(null)
    } catch (error) {
      setCaptureError(error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  const checkTextSelection = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !workspaceRef.current) {
      return
    }
    const text = sel.toString().trim()
    if (!text || text.length < 2) return
    const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null
    if (!range) return
    const container =
      range.commonAncestorContainer instanceof Element
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement
    if (
      !workspaceRef.current.contains(range.commonAncestorContainer) &&
      container?.closest<HTMLElement>('[data-evidence-source]')?.dataset.evidenceSource !== documentId
    )
      return
    if (!container?.closest('.markdown-preview, .html-source-text')) return
    const surface = container.closest('.markdown-preview, .html-source-text article')
    const preceding = range.cloneRange()
    if (surface) {
      preceding.selectNodeContents(surface)
      preceding.setEnd(range.startContainer, range.startOffset)
    }
    const occurrence = surface ? preceding.toString().split(text).length - 1 : 0
    const revisionId = container.closest<HTMLElement>('[data-source-revision]')?.dataset.sourceRevision
    const historical = revisionId
      ? queryClient
          .getQueryData<Revision[]>(['history', documentId])
          ?.find((revision) => revision.revision_id === revisionId)
      : undefined
    const rect = range.getBoundingClientRect()
    if (revisionId && !historical) return
    if (rect.width === 0 && rect.height === 0) return
    setActiveSelection({
      selectedText: text,
      occurrence,
      sourceContent: historical?.content ?? content,
      revisionId:
        historical?.revision_id ?? (content === document.content ? document.current_revision_id : undefined),
      anchor: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
      },
    })
  }, [content, document.content, document.current_revision_id, documentId, queryClient])

  useEffect(() => {
    const handleMouseUp = () => {
      requestAnimationFrame(checkTextSelection)
    }
    const element = window
    element?.addEventListener('pointerup', handleMouseUp)
    element?.addEventListener('keyup', handleMouseUp)
    return () => {
      element?.removeEventListener('pointerup', handleMouseUp)
      element?.removeEventListener('keyup', handleMouseUp)
    }
  }, [checkTextSelection])
  const [citationTarget, setCitationTarget] = useState<CitationTarget | null>(() =>
    citationTargetFromLocation(documentId),
  )
  const revealedCitation = useRef<CitationTarget | null>(null)
  useEffect(() => {
    if (revealedCitation.current === citationTarget) return
    revealedCitation.current = citationTarget
    // Reveal each new source navigation, while allowing Research to reopen afterward.
    if (citationTarget && matchMedia('(max-width: 900px)').matches) updatePreferences({ rightVisible: false })
  }, [citationTarget, updatePreferences])
  const [draftTitle, setDraftTitle] = useState(document.title)
  const selectedMaterializePath = materializePath(materializeFolder, materializeFilename)

  useEffect(() => {
    if (materializeFolder || !foldersQuery.data?.some((folder) => folder.path === 'projects')) return
    const frame = requestAnimationFrame(() => setMaterializeFolder('projects'))
    return () => cancelAnimationFrame(frame)
  }, [foldersQuery.data, materializeFolder])

  useEffect(() => {
    void sessions.initializeDocument(initialDocument)
    if (initialDocument.path === null && initialDocument.content.trim().length === 0) {
      const preferredMode = sessions.getSession(documentId).mode
      sessions.updateSession(documentId, { mode: initialDocumentMode(initialDocument, preferredMode) })
    }
  }, [documentId, initialDocument, sessions])
  useEffect(() => {
    if (initialDocument.path !== null || initialDocument.content.trim().length > 0 || mode !== 'edit') return
    const focusFrame = requestAnimationFrame(() => sessions.focusEditor(documentId))
    return () => cancelAnimationFrame(focusFrame)
  }, [documentId, initialDocument.content, initialDocument.path, mode, sessions])
  useEffect(
    () => updateDocumentTitle(documentId, document.title),
    [document.title, documentId, updateDocumentTitle],
  )
  const workspaceRef = useRef<HTMLElement>(null)
  const registerReadyEditor = useCallback(
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
        (text, expectedContent) => editorRef.current?.insertText(text, expectedContent) ?? false,
      ),
    [documentId, sessions],
  )
  useEffect(() => {
    const receiveCitation = (event: Event) => {
      // SAFETY: CITATION_NAVIGATION_EVENT dispatches CustomEvent with detail: CitationTarget
      const target = (event as CustomEvent<CitationTarget>).detail
      if (target?.documentId === documentId) {
        setCitationTarget(target)
        clearCitationNavigation(documentId)
      }
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
  const titleMutation = useMutation({
    mutationFn: (title: string) => api.updateDocument(document, content, title),
    onSuccess: (nextDocument) => updateCachedDocument(nextDocument),
  })
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
          <p className="eyebrow">{document.path ?? 'Saved draft'}</p>
          <h1 aria-label={draftTitle || 'Untitled document'}>
            <span className="document-title-accessible" aria-hidden="true">
              {draftTitle}
            </span>
            <input
              className="document-title-input"
              aria-label="Document title"
              value={draftTitle}
              disabled={titleMutation.isPending}
              onChange={(event) => setDraftTitle(event.target.value)}
              onBlur={(event) => {
                const title = event.currentTarget.value.trim()
                if (title && title !== document.title) titleMutation.mutate(title)
                else if (!title) setDraftTitle(document.title)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
                if (event.key === 'Escape') {
                  setDraftTitle(document.title)
                  event.currentTarget.blur()
                }
              }}
            />
          </h1>
          {titleMutation.isError && <small className="error-text">Title could not be saved.</small>}
        </div>
        <span className={`save-state ${saveState}`} role="status" aria-live="polite" aria-atomic="true">
          {document.content_type === 'application/pdf'
            ? 'Immutable source'
            : saveLabel(saveState, Boolean(document.path))}
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
      {captureError && (
        <StateMessage compact kind="error" title="Evidence could not be kept" description={captureError} />
      )}
      {document.content_type !== 'application/pdf' && !document.path && (
        <form
          className="materialize-bar"
          onSubmit={(event) => {
            event.preventDefault()
            materialize.mutate({ base: document, path: selectedMaterializePath })
          }}
        >
          <p className="materialize-copy">
            This document is a saved draft. Choose a workspace path when you want it to become a file.
          </p>
          <select
            aria-label="Workspace folder"
            value={materializeFolder}
            onChange={(event) => setMaterializeFolder(event.target.value)}
          >
            <option value="">Workspace root</option>
            {(foldersQuery.data ?? []).map((folder) => (
              <option key={folder.folder_id} value={folder.path}>
                {folder.path}
              </option>
            ))}
          </select>
          <input
            aria-label="Workspace filename"
            value={materializeFilename}
            onChange={(event) => setMaterializeFilename(event.target.value)}
          />
          <button disabled={materialize.isPending || saveState !== 'saved' || !materializeFilename.trim()}>
            {materialize.isPending ? 'Moving…' : 'Move to folder'}
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
            for (const key of [
              'revision',
              'page',
              'annotation',
              'text',
              'start',
              'representation',
              'quoteStart',
              'quoteEnd',
            ])
              url.searchParams.delete(key)
            clearCitationNavigation(documentId)
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
          {Boolean(selection.selectedCharacters && selection.selectedCharacters > 0) && (
            <button
              type="button"
              className="secondary-action"
              onClick={() => {
                const captured = editorSelectionSnapshot.current
                const snapshot = captured?.content ?? ''
                const sel = captured?.selectedText ?? ''
                if (!sel) return
                void keepSelection(sel, snapshot, captured?.revisionId, captured?.occurrence ?? 0).catch(
                  () => {
                    /* The capture error is displayed above. */
                  },
                )
              }}
              title="Keep selected text as evidence"
            >
              <BookmarkCheck size="var(--icon-inline)" /> Keep evidence
            </button>
          )}
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
              onViewStateChange={(viewState) => {
                const snapshot = sessions.getSession(documentId).content ?? document.content
                if (viewState.anchor !== viewState.head) {
                  const selectedText = snapshot
                    .slice(
                      Math.min(viewState.anchor, viewState.head),
                      Math.max(viewState.anchor, viewState.head),
                    )
                    .trim()
                  editorSelectionSnapshot.current = {
                    content: snapshot,
                    selectedText,
                    revisionId:
                      sessions.getSession(documentId).saveState === 'saved'
                        ? sessions.getSession(documentId).baseRevisionId
                        : undefined,
                    occurrence: selectedText
                      ? snapshot.slice(0, Math.min(viewState.anchor, viewState.head)).split(selectedText)
                          .length - 1
                      : 0,
                  }
                }
                sessions.updateSession(documentId, { viewState })
              }}
              focusOnOpen={session.focusOnOpen}
              onFocused={() => sessions.updateSession(documentId, { focusOnOpen: false })}
              onReady={registerReadyEditor}
            />
          </Suspense>
        )}
        {mode !== 'edit' && document.content_type === 'text/markdown' && (
          <Suspense fallback={<div className="markdown-preview muted">Preparing preview…</div>}>
            <MarkdownPreview content={content} readable />
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
        {mode !== 'edit' && document.content_type === 'text/html' && <SelectableHtmlText content={content} />}
      </div>
      {activeSelection && (
        <TextSelectionToolbar
          key={`${documentId}:${activeSelection.revisionId ?? 'draft'}:${activeSelection.occurrence}:${activeSelection.selectedText}`}
          documentId={document.document_id}
          documentTitle={document.title}
          documentPath={document.path}
          contentType={document.content_type}
          pinnedRevisionId={activeSelection.revisionId}
          selectedText={activeSelection.selectedText}
          anchor={activeSelection.anchor}
          onDismiss={() => setActiveSelection(null)}
          onKeep={() =>
            keepSelection(
              activeSelection.selectedText,
              activeSelection.sourceContent,
              activeSelection.revisionId,
              activeSelection.occurrence,
            )
          }
        />
      )}
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
  const ref = useRef<HTMLElement>(null)
  const quoteRef = useRef<HTMLElement>(null)
  const hasQuote = !target.textLocator && target.quoteStart !== undefined && target.quoteEnd !== undefined
  // Editorial offsets address raw UTF-16 source; evidence locators may address rendered text.
  const quoteLocator = useMemo<TextLocator | undefined>(
    () =>
      !target.textLocator &&
      revision &&
      target.quoteStart !== undefined &&
      target.quoteEnd !== undefined &&
      Number.isInteger(target.quoteStart) &&
      Number.isInteger(target.quoteEnd) &&
      target.quoteStart >= 0 &&
      target.quoteEnd > target.quoteStart &&
      target.quoteEnd <= revision.content.length
        ? {
            exact: revision.content.slice(target.quoteStart, target.quoteEnd),
            start: target.quoteStart,
            end: target.quoteEnd,
            prefix: '',
            suffix: '',
            representation: 'source',
          }
        : undefined,
    [revision, target],
  )
  const locator = target.textLocator ?? quoteLocator
  const sourceText = revision ? evidenceTextForLocator(revision.content, document.content_type, locator) : ''
  const passage =
    locator && sourceText.slice(locator.start, locator.end) === locator.exact
      ? locator
      : locator
        ? locatePassage(sourceText, locator.exact)
        : undefined
  useEffect(() => {
    if (!revision || !locator) return
    // The citation owns destination focus after the inspector sheet has closed.
    const frame = requestAnimationFrame(() => {
      if (hasQuote && quoteLocator) {
        quoteRef.current?.scrollIntoView({ block: 'nearest' })
        quoteRef.current?.focus({ preventScroll: true })
        return
      }
      ref.current?.focus({ preventScroll: true })
      ref.current?.querySelector('mark')?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [revision, target, locator, hasQuote, quoteLocator])
  return (
    <section ref={ref} tabIndex={-1} className="citation-evidence" aria-labelledby="citation-evidence-title">
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
      {quoteLocator && document.content_type !== 'application/pdf' && (
        <section
          ref={quoteRef}
          tabIndex={-1}
          className="citation-quote"
          aria-label="Exact cited passage"
          data-source-revision={revision?.revision_id}
        >
          <p className="eyebrow">Exact cited passage</p>
          <blockquote>{quoteLocator.exact}</blockquote>
        </section>
      )}
      {revision && hasQuote && !quoteLocator && (
        <StateMessage
          compact
          kind="error"
          title="The passage locator is outside this revision"
          description="The current head has not been substituted."
        />
      )}
      {revision && (
        <details open data-source-revision={revision.revision_id}>
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
          {document.content_type === 'text/html' && <SelectableHtmlText content={revision.content} />}
          {passage && (
            <pre className="cited-source-text" aria-label="Exact cited passage">
              {sourceText.slice(0, passage.start)}
              <mark>{sourceText.slice(passage.start, passage.end)}</mark>
              {sourceText.slice(passage.end)}
            </pre>
          )}
          {locator && !passage && (
            <StateMessage
              compact
              kind="error"
              title="The cited passage is absent from this revision"
              description="The pin has been preserved. The current head has not been substituted."
            />
          )}
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
  const { preferences, updatePreferences } = useTheme()
  if (preferences.rightVisible) return null
  return (
    <button
      type="button"
      className="icon-button mobile-inspector-toggle pdf-mobile-inspector-toggle"
      aria-label="Open document inspector"
      title="Open document inspector"
      onClick={() => updatePreferences({ rightVisible: true, rightTab: 'research' })}
    >
      <PanelRightOpen size="var(--icon-control)" />
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
  const openChat = () => {
    void navigate({
      to: '/chat',
      search: {
        document: document.document_id,
        revision: document.current_revision_id,
        returnTo: `/documents/${document.document_id}`,
      },
    })
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
        <div className="mobile-document-actions" aria-label="Document actions">
          <button type="button" className="secondary-action" onClick={openChat}>
            <MessageSquare size="var(--icon-inline)" /> Ask
          </button>
        </div>
        <ActionDialog
          label="Document actions"
          icon={<MoreHorizontal size="var(--icon-control)" />}
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
                  <Columns2 size="var(--icon-inline)" /> Split right
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
                  <Rows2 size="var(--icon-inline)" /> Split down
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
                    <PanelRightClose size="var(--icon-inline)" /> Close group
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
          title="More document tools"
          onClick={() => updatePreferences({ rightVisible: true })}
        >
          <PanelRightOpen size="var(--icon-control)" />
        </button>
      </div>
    </div>
  )
}
