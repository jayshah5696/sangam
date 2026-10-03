import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bold,
  BookmarkCheck,
  Check,
  Code,
  Copy,
  FileText,
  Italic,
  Link2,
  MessageSquare,
  MessageSquarePlus,
} from 'lucide-react'
import type { MarkdownFormat } from '../MarkdownEditor'
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
  onFormat,
  onAsk,
  onComment,
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
  /** Present for editable Markdown selections. */
  onFormat?: (format: MarkdownFormat) => void
  /** Ask workspace chat about the selection. */
  onAsk?: () => void
  /** Create passage comment on selection. */
  onComment?: (body: string) => Promise<void>
}) {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.top })
  const [copied, setCopied] = useState<'text' | 'citation' | null>(null)
  const [kept, setKept] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isCommenting, setIsCommenting] = useState(false)
  const [commentBody, setCommentBody] = useState('')
  const [isSubmittingComment, setIsSubmittingComment] = useState(false)

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
  }, [anchor, isCommenting])

  // Dismiss on clicking outside
  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const toolbar = toolbarRef.current
      // SAFETY: pointer events on document originate from DOM Node elements
      if (toolbar && !toolbar.contains(event.target as Node)) {
        onDismiss()
      }
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
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

  const handleSaveComment = async () => {
    if (!commentBody.trim() || !onComment) return
    try {
      setIsSubmittingComment(true)
      await onComment(commentBody.trim())
      setCommentBody('')
      setIsCommenting(false)
      onDismiss()
    } catch (err) {
      setError(`Comment failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIsSubmittingComment(false)
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
      {isCommenting ? (
        <div className="toolbar-comment-inline">
          <input
            autoFocus
            type="text"
            placeholder="Add comment..."
            value={commentBody}
            onChange={(e) => setCommentBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && commentBody.trim() && !isSubmittingComment) {
                e.preventDefault()
                void handleSaveComment()
              } else if (e.key === 'Escape') {
                setIsCommenting(false)
              }
            }}
          />
          <button
            type="button"
            disabled={!commentBody.trim() || isSubmittingComment}
            onClick={() => void handleSaveComment()}
          >
            Save
          </button>
          <button type="button" disabled={isSubmittingComment} onClick={() => setIsCommenting(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          {onFormat && (
            <>
              {(
                [
                  ['bold', 'Bold', Bold],
                  ['italic', 'Italic', Italic],
                  ['code', 'Inline code', Code],
                  ['link', 'Link', Link2],
                ] as const
              ).map(([format, label, Icon]) => (
                <button
                  key={format}
                  type="button"
                  aria-label={label}
                  title={label}
                  // Keep the editor's selection: a pressed button must not take focus first.
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => {
                    onFormat(format)
                    onDismiss()
                  }}
                >
                  <Icon size="var(--icon-inline)" />
                </button>
              ))}
              <span className="pdf-selection-divider" />
            </>
          )}
          <button
            type="button"
            aria-label="Keep as evidence"
            title="Keep as evidence"
            onClick={() => void handleKeep()}
          >
            {kept ? <Check size="var(--icon-inline)" /> : <BookmarkCheck size="var(--icon-inline)" />}
            {kept ? 'Kept' : 'Keep as evidence'}
          </button>
          {onComment && (
            <button
              type="button"
              aria-label="Add comment"
              title="Add comment"
              onClick={() => setIsCommenting(true)}
            >
              <MessageSquarePlus size="var(--icon-inline)" /> Comment
            </button>
          )}
          {onAsk && (
            <button type="button" aria-label="Ask about selection" title="Ask workspace chat" onClick={onAsk}>
              <MessageSquare size="var(--icon-inline)" /> Ask
            </button>
          )}
          {error && <StateMessage compact kind="error" title="Action failed" description={error} />}
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
            {copied === 'citation' ? (
              <Check size="var(--icon-inline)" />
            ) : (
              <FileText size="var(--icon-inline)" />
            )}
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
