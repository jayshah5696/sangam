import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Copy, Highlighter, MessageSquare, Quote, Search, StickyNote } from 'lucide-react'
import { api, type Annotation, type Document } from '../api'
import { usePdfResearch } from '../pdfResearchState'
import { annotationTypeLabel, type AnnotationDraft } from './pdfResearchTypes'

export function PdfResearchRail({ document }: { document: Document }) {
  const research = usePdfResearch()
  const [query, setQuery] = useState('')
  const search = useMutation({ mutationFn: (value: string) => api.searchPdf(document.document_id, value) })
  if (!research) return null
  const selectedAnnotation = research.annotations.find(
    (annotation) => annotation.annotation_id === research.selectedAnnotationId,
  )
  const actions: Array<{
    type: Annotation['annotation_type']
    label: string
    icon: typeof StickyNote
  }> = [
    { type: 'page_note', label: 'Page note', icon: StickyNote },
    { type: 'bookmark', label: 'Bookmark', icon: Bookmark },
    { type: 'citation_marker', label: 'Citation', icon: Quote },
    { type: 'comment', label: 'Comment', icon: MessageSquare },
  ]

  return (
    <section className="pdf-research-rail" aria-label="PDF research">
      <div className="pdf-research-summary">
        <div>
          <p className="eyebrow">Research</p>
          <strong>Page {research.pageNumber}</strong>
        </div>
        <span className="scope-badge">{research.annotations.length} notes</span>
      </div>
      <form
        className="pdf-search"
        onSubmit={(event) => {
          event.preventDefault()
          if (query.trim()) search.mutate(query.trim())
        }}
      >
        <label>
          <Search size={14} />
          <input
            aria-label="Search PDF text"
            placeholder="Search PDF text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit" disabled={!query.trim() || search.isPending}>
          Search
        </button>
      </form>
      {search.data && (
        <div className="pdf-search-results">
          {search.data.map((result) => (
            <button key={result.page_number} onClick={() => research.scrollToPage(result.page_number)}>
              <strong>Page {result.page_number}</strong>
              <span>{result.snippet}</span>
            </button>
          ))}
          {search.data.length === 0 && <p className="small-muted">No matching pages.</p>}
        </div>
      )}
      <div className="pdf-annotation-actions" role="toolbar" aria-label="Add PDF annotation">
        {actions.map(({ type, label, icon: Icon }) => (
          <button
            className="icon-button"
            key={type}
            aria-label={label}
            title={label}
            onClick={() => research.setDraft(emptyDraft(type))}
          >
            <Icon size={15} />
          </button>
        ))}
      </div>
      {research.draft && (
        <AnnotationComposer
          documentId={document.document_id}
          pageNumber={research.pageNumber}
          draft={research.draft}
          onClose={() => research.setDraft(null)}
        />
      )}
      <label className="annotation-filter">
        <span>Filter annotations</span>
        <input
          value={research.annotationQuery}
          placeholder="Notes, selected text, tags"
          onChange={(event) => research.setAnnotationQuery(event.target.value)}
        />
      </label>
      <div className="pdf-annotation-list">
        {research.annotations.map((annotation) => (
          <button
            className={research.selectedAnnotationId === annotation.annotation_id ? 'active' : ''}
            key={annotation.annotation_id}
            onClick={() => {
              research.scrollToPage(annotation.page_number)
              research.setSelectedAnnotationId(annotation.annotation_id)
            }}
          >
            <span>
              <i style={{ background: annotation.color }} />
              {annotationTypeLabel(annotation.annotation_type)} · p. {annotation.page_number}
            </span>
            <strong>{annotation.note ?? annotation.selected_text ?? 'No note'}</strong>
            <small>{annotation.updated_by_name}</small>
          </button>
        ))}
      </div>
      {selectedAnnotation && (
        <AnnotationDetail
          key={selectedAnnotation.annotation_id}
          annotation={selectedAnnotation}
          onClose={() => research.setSelectedAnnotationId(null)}
        />
      )}
    </section>
  )
}

function ExpandableQuote({ children }: { children: string }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`annotation-quote ${expanded ? 'expanded' : ''}`}>
      <blockquote>{children}</blockquote>
      <button type="button" className="annotation-quote-toggle" onClick={() => setExpanded((open) => !open)}>
        {expanded ? 'Show less' : 'Show more'}
      </button>
    </div>
  )
}

function AnnotationComposer({
  documentId,
  pageNumber,
  draft,
  onClose,
}: {
  documentId: string
  pageNumber: number
  draft: AnnotationDraft
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')
  const [tags, setTags] = useState('')
  const [color, setColor] = useState('#f0c75e')
  const create = useMutation({
    mutationFn: () =>
      api.createAnnotation(documentId, {
        page_number: pageNumber,
        annotation_type: draft.annotationType,
        selected_text: draft.selectedText,
        note: note || null,
        geometry: draft.geometry,
        tags: splitTags(tags),
        color,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['annotations', documentId] })
      onClose()
    },
  })
  return (
    <form
      className="annotation-composer"
      onSubmit={(event) => {
        event.preventDefault()
        create.mutate()
      }}
    >
      <header>
        <div>
          <p className="eyebrow">New annotation</p>
          <strong>{annotationTypeLabel(draft.annotationType)}</strong>
        </div>
        <button type="button" className="icon-button" aria-label="Close annotation form" onClick={onClose}>
          ×
        </button>
      </header>
      {draft.selectedText && <ExpandableQuote>{draft.selectedText}</ExpandableQuote>}
      <label>
        <span>Note</span>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <label>
        <span>Tags</span>
        <input
          value={tags}
          placeholder="evidence, follow-up"
          onChange={(event) => setTags(event.target.value)}
        />
      </label>
      <label>
        <span>Color</span>
        <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
      </label>
      <button className="panel-button" disabled={create.isPending}>
        <Highlighter size={14} /> {create.isPending ? 'Saving…' : 'Save annotation'}
      </button>
      {create.isError && <p className="error-text">The annotation could not be saved.</p>}
    </form>
  )
}

function AnnotationDetail({ annotation, onClose }: { annotation: Annotation; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [note, setNote] = useState(annotation.note ?? '')
  const [tags, setTags] = useState(annotation.tags.join(', '))
  const [color, setColor] = useState(annotation.color)
  const history = useQuery({
    queryKey: ['annotation-history', annotation.annotation_id],
    queryFn: () => api.annotationHistory(annotation.annotation_id),
  })
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['annotations', annotation.document_id] })
    await queryClient.invalidateQueries({ queryKey: ['annotation-history', annotation.annotation_id] })
  }
  const update = useMutation({
    mutationFn: () =>
      api.updateAnnotation(annotation, {
        selected_text: annotation.selected_text,
        note: note || null,
        geometry: annotation.geometry,
        tags: splitTags(tags),
        color,
      }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: () => api.deleteAnnotation(annotation),
    onSuccess: async () => {
      await refresh()
      onClose()
    },
  })
  const link = `sangam://document/${annotation.document_id}?page=${annotation.page_number}&annotation=${annotation.annotation_id}`
  return (
    <section className="annotation-detail">
      <header>
        <div>
          <p className="eyebrow">Annotation</p>
          <strong>{annotationTypeLabel(annotation.annotation_type)}</strong>
        </div>
        <button className="icon-button" aria-label="Close annotation detail" onClick={onClose}>
          ×
        </button>
      </header>
      {annotation.selected_text && <ExpandableQuote>{annotation.selected_text}</ExpandableQuote>}
      <label>
        <span>Note</span>
        <textarea value={note} onChange={(event) => setNote(event.target.value)} />
      </label>
      <label>
        <span>Tags</span>
        <input value={tags} onChange={(event) => setTags(event.target.value)} />
      </label>
      <label>
        <span>Color</span>
        <input type="color" value={color} onChange={(event) => setColor(event.target.value)} />
      </label>
      <div className="annotation-detail-actions">
        <button disabled={update.isPending} onClick={() => update.mutate()}>
          Save note
        </button>
        <button
          onClick={() => void navigator.clipboard.writeText(`[PDF p. ${annotation.page_number}](${link})`)}
        >
          <Copy size={14} /> Copy Markdown link
        </button>
        <button className="danger-button" disabled={remove.isPending} onClick={() => remove.mutate()}>
          Remove
        </button>
      </div>
      <div className="annotation-history">
        <p className="eyebrow">Version history</p>
        {(history.data ?? []).map((event) => (
          <article key={event.event_id}>
            <strong>
              v{event.version} · {event.operation}
            </strong>
            <span>{event.actor_display_name}</span>
            <time>{new Date(event.created_at).toLocaleString()}</time>
          </article>
        ))}
      </div>
    </section>
  )
}

function emptyDraft(annotationType: Annotation['annotation_type']): AnnotationDraft {
  return { annotationType, selectedText: null, geometry: [] }
}

function splitTags(value: string) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}
