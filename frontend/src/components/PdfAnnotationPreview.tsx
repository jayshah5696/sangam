import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy, Pencil, Trash2 } from 'lucide-react'
import type { Annotation } from '../api'
import { annotationLink, floatingPosition } from '../pdfAnnotationUi'
import { annotationTypeLabel } from './pdfResearchTypes'

export function PdfAnnotationPreview({
  annotation,
  anchor,
  deleting,
  onEdit,
  onDelete,
  onDismiss,
}: {
  annotation: Annotation
  anchor: HTMLElement
  deleting: boolean
  onEdit: () => void
  onDelete: () => void
  onDismiss: () => void
}) {
  const cardRef = useRef<HTMLElement>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })

  useLayoutEffect(() => {
    const card = cardRef.current
    if (!card) return
    setPosition(
      floatingPosition(
        anchor.getBoundingClientRect(),
        { width: card.offsetWidth, height: card.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
        10,
      ),
    )
  }, [anchor, annotation])

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', dismiss)
    return () => window.removeEventListener('keydown', dismiss)
  }, [onDismiss])

  return createPortal(
    <aside
      ref={cardRef}
      className="pdf-annotation-preview"
      aria-label={`${annotationTypeLabel(annotation.annotation_type)} annotation preview`}
      style={
        {
          left: position.left,
          top: position.top,
          '--annotation-color': annotation.color,
        } as React.CSSProperties
      }
      onMouseLeave={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && event.currentTarget.contains(next)) return
        if (!event.currentTarget.contains(document.activeElement)) onDismiss()
      }}
      onBlur={(event) => {
        if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget)) onDismiss()
      }}
    >
      <header>
        <span className="pdf-annotation-preview-type">
          <i /> {annotationTypeLabel(annotation.annotation_type)}
        </span>
        <span>Page {annotation.page_number}</span>
      </header>
      {annotation.selected_text && <blockquote>{annotation.selected_text}</blockquote>}
      <strong>{annotation.note ?? 'No note'}</strong>
      {annotation.tags.length > 0 && (
        <ul aria-label="Annotation tags">
          {annotation.tags.map((tag) => (
            <li key={tag}>{tag}</li>
          ))}
        </ul>
      )}
      <footer>
        <span>
          {annotation.updated_by_name} · {new Date(annotation.updated_at).toLocaleString()}
        </span>
        <div>
          <button type="button" aria-label="Edit annotation" onClick={onEdit}>
            <Pencil size={13} /> Edit
          </button>
          <button
            type="button"
            aria-label="Copy annotation link"
            onClick={() => void navigator.clipboard.writeText(annotationLink(annotation))}
          >
            <Copy size={13} /> Copy link
          </button>
          <button type="button" className="danger" disabled={deleting} onClick={onDelete}>
            <Trash2 size={13} /> {deleting ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </footer>
    </aside>,
    document.body,
  )
}
