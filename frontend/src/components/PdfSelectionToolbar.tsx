import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, FileText, StickyNote } from 'lucide-react'
import type { PdfRect } from '../api'
import { floatingPosition, markdownSelectionCitation } from '../pdfAnnotationUi'

export const PDF_HIGHLIGHT_COLORS = ['#f0c75e', '#78c6a3', '#78a9ff', '#d7aefb', '#ff9b85'] as const

export type PdfTextSelection = {
  pageNumber: number
  selectedText: string
  geometry: PdfRect[]
  anchor: { left: number; right: number; top: number; bottom: number; width: number }
}

export function PdfSelectionToolbar({
  documentId,
  documentTitle,
  selection,
  pending,
  onHighlight,
  onAddNote,
  onDismiss,
}: {
  documentId: string
  documentTitle: string
  selection: PdfTextSelection
  pending: boolean
  onHighlight: (color: string) => void
  onAddNote: () => void
  onDismiss: () => void
}) {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: selection.anchor.left, top: selection.anchor.top })
  const [copied, setCopied] = useState<'text' | 'citation' | null>(null)

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) return
    const bounds = toolbar.getBoundingClientRect()
    setPosition(
      floatingPosition(
        selection.anchor,
        { width: bounds.width, height: bounds.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    )
  }, [selection])

  useEffect(() => {
    const dismissFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    const dismissFromPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !toolbarRef.current?.contains(event.target)) onDismiss()
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
        ? selection.selectedText
        : markdownSelectionCitation(documentTitle, documentId, selection.pageNumber, selection.selectedText)
    await navigator.clipboard.writeText(value)
    setCopied(kind)
  }

  return createPortal(
    <div
      ref={toolbarRef}
      className="pdf-selection-toolbar"
      role="toolbar"
      aria-label="Selected PDF text actions"
      style={{ left: position.left, top: position.top }}
    >
      <div className="pdf-highlight-colors" aria-label="Highlight colors">
        {PDF_HIGHLIGHT_COLORS.map((color, index) => (
          <button
            key={color}
            type="button"
            aria-label={`Highlight color ${index + 1}`}
            title={`Highlight color ${index + 1}`}
            disabled={pending}
            // SAFETY: CSS custom variable in inline style object
            style={{ '--annotation-color': color } as React.CSSProperties}
            onClick={() => onHighlight(color)}
          />
        ))}
      </div>
      <span className="pdf-selection-divider" />
      <button type="button" disabled={pending} onClick={onAddNote}>
        <StickyNote size="var(--icon-inline)" /> Add note
      </button>
      <button type="button" aria-label="Copy selected text" onClick={() => void copy('text')}>
        {copied === 'text' ? <Check size="var(--icon-inline)" /> : <Copy size="var(--icon-inline)" />}
      </button>
      <button type="button" aria-label="Copy Markdown citation" onClick={() => void copy('citation')}>
        {copied === 'citation' ? <Check size="var(--icon-inline)" /> : <FileText size="var(--icon-inline)" />}
      </button>
    </div>,
    document.body,
  )
}
