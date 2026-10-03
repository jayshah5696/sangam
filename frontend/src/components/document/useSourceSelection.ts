import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { Document, Revision } from '../../api'
import { chatNavigationState } from '../../chatNavigation'
import { locateEvidencePassage } from '../../evidenceCitation'
import { useDocumentSessions } from '../../documentSessions'
import { workspaceEvidenceStore } from '../../workspaceEvidenceState'
import type { EditorSelectionAnchor } from '../MarkdownEditor'
import type { TextSelectionAnchor } from './TextSelectionToolbar'

/**
 * What the reader has selected in one document, and what they can do with it.
 *
 * A selection in the rendered preview comes from the DOM; one in the editor comes from
 * CodeMirror. Both end as the exact passage, the source text it came from, and the revision
 * that text belongs to, so "Keep as evidence" and "Ask about this" cannot disagree with
 * what was selected.
 */
export function useSourceSelection({
  documentId,
  document,
  content,
  workspaceRef,
}: {
  documentId: string
  document: Document
  content: string
  workspaceRef: RefObject<HTMLElement | null>
}) {
  const queryClient = useQueryClient()
  const sessions = useDocumentSessions()
  const navigate = useNavigate()
  const editorSnapshot = useRef<{
    content: string
    selectedText: string
    occurrence: number
    revisionId?: string
  } | null>(null)
  const [activeSelection, setActiveSelection] = useState<{
    selectedText: string
    anchor: TextSelectionAnchor
    sourceContent: string
    revisionId?: string
    occurrence: number
  } | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [editorSelection, setEditorSelection] = useState<EditorSelectionAnchor | null>(null)

  /** Remember what the editor had selected, with the text it was selected in. */
  const rememberEditorSelection = (viewState: { anchor: number; head: number }, snapshot: string) => {
    if (viewState.anchor !== viewState.head) {
      const selectedText = snapshot
        .slice(Math.min(viewState.anchor, viewState.head), Math.max(viewState.anchor, viewState.head))
        .trim()
      editorSnapshot.current = {
        content: snapshot,
        selectedText,
        revisionId:
          sessions.getSession(documentId).saveState === 'saved'
            ? sessions.getSession(documentId).baseRevisionId
            : undefined,
        occurrence: selectedText
          ? snapshot.slice(0, Math.min(viewState.anchor, viewState.head)).split(selectedText).length - 1
          : 0,
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
  }, [content, document.content, document.current_revision_id, documentId, queryClient, workspaceRef])

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

  return {
    activeSelection,
    dismissSelection: () => setActiveSelection(null),
    editorSelection,
    setEditorSelection,
    editorSnapshot,
    rememberEditorSelection,
    captureError,
    keepSelection,
    askAbout,
  }
}
