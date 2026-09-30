import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { BookmarkCheck, Check, Copy, FileText } from 'lucide-react'
import { evidenceCitationMarkdown } from '../../evidenceCitation'
import { floatingPosition } from '../../pdfAnnotationUi'
import { workspaceEvidenceStore } from '../../workspaceEvidenceState'
import { StateMessage } from '../ui/StateMessage'

export type TextSelectionAnchor = {
  left: number
  right: number
  top: number
  bottom: number
  width: number
}

export function TextSelectionToolbar({
  documentId,
  documentTitle,
  documentPath,
  contentType,
  pinnedRevisionId,
  selectedText,
  anchor,
  onDismiss,
  onKeep,
}: {
  documentId: string
  documentTitle: string
  documentPath?: string | null
  contentType: 'text/markdown' | 'text/html' | 'application/pdf'
  pinnedRevisionId?: string
  selectedText: string
  anchor: TextSelectionAnchor
  onDismiss: () => void
  onKeep?: () => Promise<void>
}) {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.top })
  const [copied, setCopied] = useState<'text' | 'citation' | null>(null)
  const [kept, setKept] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) return
    const bounds = toolbar.getBoundingClientRect()
    setPosition(
      floatingPosition(
        anchor,
        { width: bounds.width, height: bounds.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    )
  }, [anchor])

  useEffect(() => {
    const dismiss = () => {
      // Escape does not collapse a native selection in every browser. Clear it
      // so the workspace's keyup/pointerup capture cannot reopen this toolbar.
      window.getSelection()?.removeAllRanges()
      onDismiss()
    }
    const dismissFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    const dismissFromPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolbarRef.current?.contains(event.target)) {
        dismiss()
      }
    }
    window.addEventListener('keydown', dismissFromKeyboard)
    window.addEventListener('pointerdown', dismissFromPointer, true)
    return () => {
      window.removeEventListener('keydown', dismissFromKeyboard)
      window.removeEventListener('pointerdown', dismissFromPointer, true)
    }
  }, [onDismiss])

  const copy = async (kind: 'text' | 'citation') => {
    const value =
      kind === 'text'
        ? selectedText
        : evidenceCitationMarkdown({
            documentId,
            title: documentTitle,
            revisionId: pinnedRevisionId,
            selectedText,
          }).trim()
    await navigator.clipboard.writeText(value)
    setCopied(kind)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleKeep = async () => {
    try {
      if (onKeep) await onKeep()
      else
        await workspaceEvidenceStore.keepEvidence({
          sourceDocumentId: documentId,
          sourceTitle: documentTitle,
          sourcePath: documentPath,
          sourceContentType: contentType,
          pinnedRevisionId,
          selectedText,
        })
      setKept(true)
      setError(null)
    } catch (error) {
      setError(`Evidence storage: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return createPortal(
    <div
      ref={toolbarRef}
      className="pdf-selection-toolbar text-selection-toolbar"
      role="toolbar"
      aria-label="Selected text actions"
      style={{ left: position.left, top: position.top }}
    >
      <button
        type="button"
        aria-label="Keep as evidence"
        title="Keep as evidence"
        onClick={() => void handleKeep()}
      >
        {kept ? <Check size="var(--icon-inline)" /> : <BookmarkCheck size="var(--icon-inline)" />}
        {kept ? 'Kept' : 'Keep as evidence'}
      </button>
      {error && <StateMessage compact kind="error" title="Evidence storage failed" description={error} />}
      <span className="pdf-selection-divider" />
      <button
        type="button"
        aria-label="Copy selected text"
        title="Copy selected text"
        onClick={() => void copy('text')}
      >
        {copied === 'text' ? <Check size="var(--icon-inline)" /> : <Copy size="var(--icon-inline)" />}
      </button>
      <button
        type="button"
        aria-label="Copy Markdown citation"
        title="Copy Markdown citation"
        onClick={() => void copy('citation')}
      >
        {copied === 'citation' ? <Check size="var(--icon-inline)" /> : <FileText size="var(--icon-inline)" />}
      </button>
    </div>,
    document.body,
  )
}
