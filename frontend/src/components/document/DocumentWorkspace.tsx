import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  BookmarkCheck,
  Columns2,
  ImagePlus,
  MessageSquare,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Rows2,
} from 'lucide-react'
import { workspaceEvidenceStore } from '../../workspaceEvidenceState'
import { evidenceTextForLocator, locateEvidencePassage, locatePassage } from '../../evidenceCitation'
import { StateMessage } from '../ui/StateMessage'
import { SelectableHtmlText } from '../SelectableHtmlText'
import { TextSelectionToolbar, type TextSelectionAnchor } from './TextSelectionToolbar'
import { api, SUPPORTED_IMAGE_TYPES, writeFailureMessage, type Document, type Revision } from '../../api'
import { chatNavigationState } from '../../chatNavigation'
import {
  CITATION_NAVIGATION_EVENT,
  CITATION_PARAM_KEYS,
  citationTargetFromLocation,
  clearCitationNavigation,
  type CitationTarget,
  type TextLocator,
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
import { initialDocumentMode, saveLabel } from '../../documentWorkspaceState'
import { DocumentLocationControl } from './DocumentLocationControl'
import { ActionDialog } from '../ActionMenu'
import type { EditorSelectionAnchor, MarkdownEditorHandle } from '../MarkdownEditor'
import { PublicationStatusBadge } from './PublicationStatusBadge'
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
  const htmlJavascript = useQuery({
    queryKey: ['html-javascript-settings'],
    queryFn: api.getHtmlJavascriptSettings,
    enabled: document.content_type === 'text/html',
  })
  const [linkTarget, setLinkTarget] = useState('')
  const [activeSelection, setActiveSelection] = useState<{
    selectedText: string
    anchor: TextSelectionAnchor
    sourceContent: string
    revisionId?: string
    occurrence: number
  } | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [editorSelection, setEditorSelection] = useState<EditorSelectionAnchor | null>(null)
  const [imageUpload, setImageUpload] = useState<{ pending: number; error: string | null }>({
    pending: 0,
    error: null,
  })
  const imageInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const resolveAsset = useCallback(
    async (reference: string) => api.documentAssetUrl(documentId, reference),
    [documentId],
  )

  // Images go to the shared attachments folder and are inserted as root-relative Markdown,
  // so moving this document never breaks them.
  const uploadImages = async (files: File[]) => {
    const images = files.filter((file) => SUPPORTED_IMAGE_TYPES.includes(file.type))
    if (!images.length) {
      setImageUpload((state) => ({ ...state, error: 'Images must be PNG, JPEG, GIF, or WebP.' }))
      return
    }
    setImageUpload((state) => ({ pending: state.pending + images.length, error: null }))
    for (const file of images) {
      try {
        const extension = file.type.split('/')[1] ?? 'png'
        const asset = await api.attachDocumentAsset(
          documentId,
          file,
          file.name || `pasted-image.${extension}`,
        )
        editorRef.current?.insertText(`${asset.markdown}\n`)
      } catch (error) {
        setImageUpload((state) => ({
          ...state,
          error: error instanceof Error ? error.message : 'The image could not be added.',
        }))
      } finally {
        setImageUpload((state) => ({ ...state, pending: Math.max(0, state.pending - 1) }))
      }
    }
  }

  // Asking saves the draft first so chat reads exactly the passage the user selected.
  const askAbout = async (selectedText: string) => {
    const current = sessions.getSession(documentId).content ?? document.content
    const saved = current === document.content ? document : await sessions.flushSnapshot(documentId, current)
    await navigate({
      to: '/chat',
      search: {
        document: documentId,
        revision: saved.current_revision_id,
        returnTo: `/documents/${documentId}`,
      },
      state: chatNavigationState(selectedText),
    })
  }

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
      ? queryClient.getQueryData<Revision>(['revision', documentId, revisionId])
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
  // Search results open the current revision at a line; reveal it once the surface exists.
  const revealedPassage = useRef<CitationTarget | null>(null)
  useEffect(() => {
    const target = citationTarget
    const passage = target?.passage
    if (!target || !passage || target.revisionId || revealedPassage.current === target) return
    let frames = 0
    let handle = 0
    const reveal = () => {
      // On narrow screens the sidebar drawer and inspector sheet close after navigation
      // and hand focus back to their triggers. Reveal only once they are gone so the
      // selection and focus land in the editor.
      const overlayOpen = window.document.querySelector('[role="dialog"][aria-modal="true"]')
      if (overlayOpen && frames < 60) {
        frames += 1
        handle = requestAnimationFrame(reveal)
        return
      }
      if (mode !== 'preview' && editorRef.current) {
        revealedPassage.current = target
        editorRef.current.revealPassage(passage.line, passage.exact)
        return
      }
      if (mode === 'preview') {
        const blocks = [
          ...(workspaceRef.current?.querySelectorAll<HTMLElement>('.markdown-preview [data-line]') ?? []),
        ]
        const nearest = blocks.filter((block) => Number(block.dataset.line) <= passage.line).at(-1)
        if (nearest) {
          revealedPassage.current = target
          for (const previous of workspaceRef.current?.querySelectorAll('[data-search-target]') ?? [])
            previous.removeAttribute('data-search-target')
          nearest.setAttribute('data-search-target', '')
          nearest.scrollIntoView({ block: 'center' })
          return
        }
      }
      frames += 1
      if (frames < 120) handle = requestAnimationFrame(reveal)
    }
    handle = requestAnimationFrame(reveal)
    return () => cancelAnimationFrame(handle)
  }, [citationTarget, mode])

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
    sessions.acceptServerDocument(nextDocument, replaceContent)
    updateDocumentTitle(documentId, nextDocument.title)
  }
  const titleMutation = useMutation({
    mutationFn: (title: string) => sessions.rename(documentId, title),
    onSuccess: (nextDocument) => updateDocumentTitle(documentId, nextDocument.title),
  })
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (content !== document.content) event.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [content, document.content])

  const conflictHeadQuery = useQuery({
    queryKey: ['document-conflict-head', documentId],
    queryFn: () => api.getDocument(documentId),
    enabled: saveState === 'conflict',
    retry: false,
  })
  const citedHistoryQuery = useQuery({
    queryKey: ['revision', documentId, citationTarget?.revisionId],
    queryFn: () => api.revision(documentId, citationTarget?.revisionId ?? ''),
    enabled: Boolean(citationTarget?.revisionId),
  })
  const citedRevision = citedHistoryQuery.data
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
          <div className="document-header-meta">
            {document.content_type !== 'application/pdf' ? (
              <DocumentLocationControl
                document={document}
                saveState={saveState}
                onUpdated={(updated) => updateCachedDocument(updated)}
              />
            ) : (
              <p className="eyebrow">{document.path ?? 'Saved draft'}</p>
            )}
            <div className="document-header-status">
              {document.content_type !== 'application/pdf' && <PublicationStatusBadge document={document} />}
              <span className={`save-state ${saveState}`} role="status" aria-live="polite" aria-atomic="true">
                {document.content_type === 'application/pdf'
                  ? 'Immutable source'
                  : saveLabel(saveState, Boolean(document.path))}
              </span>
            </div>
          </div>

          <div className="document-header-row">
            <div className="document-header-title-wrap">
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
              {titleMutation.isError && (
                <small className="error-text" role="alert">
                  {writeFailureMessage(titleMutation.error, 'Title could not be saved.')}
                </small>
              )}
            </div>

            {document.content_type !== 'application/pdf' && (
              <div className="document-header-toolbar">
                <DocumentToolbar
                  document={document}
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
              </div>
            )}
          </div>
        </div>
      </header>
      {document.content_type === 'application/pdf' && <MobileInspectorToggle />}
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
      {imageUpload.error && (
        <StateMessage
          compact
          kind="error"
          title="Image not added"
          description={imageUpload.error}
          action={
            <button type="button" onClick={() => setImageUpload((state) => ({ ...state, error: null }))}>
              Dismiss
            </button>
          }
        />
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
            for (const key of CITATION_PARAM_KEYS) url.searchParams.delete(key)
            clearCitationNavigation(documentId)
            window.history.replaceState(window.history.state, '', url)
            setCitationTarget(null)
          }}
        />
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
              availableDocuments={documentsQuery.data}
              currentDocumentId={documentId}
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
              onImageFiles={(files) => void uploadImages(files)}
              onSelectionSettled={setEditorSelection}
            />
          </Suspense>
        )}
        {mode !== 'edit' && document.content_type === 'text/markdown' && (
          <Suspense fallback={<div className="markdown-preview muted">Preparing preview…</div>}>
            <MarkdownPreview content={content} readable resolveAsset={resolveAsset} />
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
      {document.content_type !== 'application/pdf' && mode !== 'preview' && (
        <div className="editor-tools">
          <label>
            Internal link
            <select
              aria-label="Internal link"
              value={linkTarget}
              onChange={(event) => setLinkTarget(event.target.value)}
            >
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
          {document.content_type === 'text/markdown' && (
            <>
              <button
                type="button"
                className="secondary-action"
                disabled={imageUpload.pending > 0}
                title="Add an image to the workspace attachments folder"
                onClick={() => imageInputRef.current?.click()}
              >
                <ImagePlus size="var(--icon-inline)" /> {imageUpload.pending ? 'Adding image…' : 'Image'}
              </button>
              <input
                ref={imageInputRef}
                type="file"
                hidden
                multiple
                accept={SUPPORTED_IMAGE_TYPES.join(',')}
                aria-label="Add image"
                onChange={(event) => {
                  const files = [...(event.currentTarget.files ?? [])]
                  event.currentTarget.value = ''
                  if (files.length) void uploadImages(files)
                }}
              />
            </>
          )}
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
          onAsk={() => void askAbout(activeSelection.selectedText)}
        />
      )}
      {editorSelection &&
        !activeSelection &&
        mode !== 'preview' &&
        document.content_type !== 'application/pdf' && (
          <TextSelectionToolbar
            key={`editor:${editorSelection.rect.left}:${editorSelection.rect.top}:${editorSelection.text.length}`}
            documentId={document.document_id}
            documentTitle={document.title}
            documentPath={document.path}
            contentType={document.content_type}
            selectedText={editorSelection.text}
            anchor={editorSelection.rect}
            onDismiss={() => setEditorSelection(null)}
            onFormat={
              document.content_type === 'text/markdown'
                ? (format) => editorRef.current?.applyFormat(format)
                : undefined
            }
            onKeep={() => {
              const captured = editorSelectionSnapshot.current
              if (!captured?.selectedText) return Promise.reject(new Error('Select the passage again.'))
              return keepSelection(
                captured.selectedText,
                captured.content,
                captured.revisionId,
                captured.occurrence,
              )
            }}
            onAsk={() => void askAbout(editorSelection.text)}
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
      {loading && <StateMessage compact kind="loading" title="Loading the immutable cited revision…" />}
      {error && (
        <StateMessage
          compact
          kind="error"
          title="The cited revision is not available in this document’s history"
          description="The current head has not been substituted."
        />
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
  const sessions = useDocumentSessions()
  const [title, setTitle] = useState(document.title)
  const [path, setPath] = useState(document.path ?? '')
  // Each step builds on the revision the previous one wrote, so a title and path change
  // together cannot conflict with themselves.
  const saveDetails = useMutation({
    mutationFn: async () => {
      let current = document
      if (title !== document.title) current = await sessions.rename(document.document_id, title)
      if (path !== (document.path ?? '')) {
        current = document.path
          ? await api.moveDocument(current, path)
          : await api.materializeDocument(current, path)
      }
      return current
    },
    onSuccess: onUpdated,
  })
  const duplicate = useMutation({
    mutationFn: () => api.duplicateDocument(document),
    onSuccess: async (created) =>
      navigate({ to: '/documents/$documentId', params: { documentId: created.document_id } }),
  })
  const remove = useMutation({ mutationFn: () => api.deleteDocument(document), onSuccess: onDeleted })
  const { updatePreferences } = useTheme()
  const busy = saveState !== 'saved' || saveDetails.isPending || duplicate.isPending || remove.isPending
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
                onClick={() => saveDetails.mutate(undefined, { onSuccess: close })}
              >
                Save details
              </button>
              <button
                type="button"
                className="secondary-action"
                disabled={busy}
                onClick={() => duplicate.mutate(undefined, { onSuccess: close })}
              >
                Duplicate
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => remove.mutate(undefined, { onSuccess: close })}
              >
                Move to trash
              </button>
              {(saveDetails.isError || duplicate.isError || remove.isError) && (
                <StateMessage
                  compact
                  kind="error"
                  title={writeFailureMessage(
                    saveDetails.error ?? duplicate.error ?? remove.error,
                    'The document action could not be completed.',
                  )}
                />
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
