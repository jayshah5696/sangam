import { useState, type Dispatch, type SetStateAction } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Copy, Highlighter, Search, Upload } from 'lucide-react'
import { api, type Annotation, type Document } from '../api'
import { useWorkbench } from '../workbench'
import { annotationTypeLabel, type AnnotationDraft } from './pdfResearchTypes'

type PdfResearchRailProps = {
  document: Document
  pageNumber: number
  setPageNumber: Dispatch<SetStateAction<number>>
  annotations: Annotation[]
  annotationQuery: string
  setAnnotationQuery: Dispatch<SetStateAction<string>>
  selectedAnnotationId: string | null
  setSelectedAnnotationId: Dispatch<SetStateAction<string | null>>
  draft: AnnotationDraft | null
  setDraft: Dispatch<SetStateAction<AnnotationDraft | null>>
}

export function PdfResearchRail({
  document,
  pageNumber,
  setPageNumber,
  annotations,
  annotationQuery,
  setAnnotationQuery,
  selectedAnnotationId,
  setSelectedAnnotationId,
  draft,
  setDraft,
}: PdfResearchRailProps) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const workbench = useWorkbench()
  const [query, setQuery] = useState('')
  const search = useMutation({
    mutationFn: (value: string) => api.searchPdf(document.document_id, value),
  })
  const importReplacement = useMutation({
    mutationFn: (file: File) => {
      const parent = document.path?.includes('/')
        ? document.path.slice(0, document.path.lastIndexOf('/') + 1)
        : ''
      const filename = file.name.toLowerCase().endsWith('.pdf') ? file.name : `${file.name}.pdf`
      return api.importPdf(
        file,
        file.name.replace(/\.pdf$/i, '') || `${document.title} replacement`,
        `${parent}${filename}`,
        document.document_id,
      )
    },
    onSuccess: async (replacement) => {
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      workbench.ensureDocumentOpen(replacement.document_id, replacement.title)
      await navigate({
        to: '/documents/$documentId',
        params: { documentId: replacement.document_id },
      })
    },
  })
  const selectedAnnotation = annotations.find(
    (annotation) => annotation.annotation_id === selectedAnnotationId,
  )

  return (
    <aside className="pdf-research-rail ui-rail ui-rail--surface">
      <div className="ui-rail-header">
        <div>
          <p className="eyebrow">Research</p>
          <strong>Page {pageNumber}</strong>
        </div>
        <span className="scope-badge">{annotations.length} notes</span>
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
            <button key={result.page_number} onClick={() => setPageNumber(result.page_number)}>
              <strong>Page {result.page_number}</strong>
              <span>{result.snippet}</span>
            </button>
          ))}
          {search.data.length === 0 && <p className="small-muted">No matching pages.</p>}
        </div>
      )}
      <div className="pdf-annotation-actions">
        <button onClick={() => setDraft(emptyDraft('page_note'))}>Add page note</button>
        <button onClick={() => setDraft(emptyDraft('bookmark'))}>Bookmark</button>
        <button onClick={() => setDraft(emptyDraft('citation_marker'))}>Citation</button>
        <button onClick={() => setDraft(emptyDraft('comment'))}>Comment</button>
      </div>
      <div className="pdf-replacement-control">
        <div className="pdf-replacement-copy">
          <strong>Replacement PDF</strong>
          <small>Imports a new immutable document.</small>
        </div>
        <label className="pdf-replacement-button" aria-disabled={importReplacement.isPending || undefined}>
          <Upload size={14} />
          <span>{importReplacement.isPending ? 'Importing…' : 'Choose PDF'}</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            disabled={importReplacement.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) importReplacement.mutate(file)
            }}
          />
        </label>
      </div>
      {draft && (
        <AnnotationComposer
          documentId={document.document_id}
          pageNumber={pageNumber}
          draft={draft}
          onClose={() => setDraft(null)}
        />
      )}
      <label className="annotation-filter">
        <span>Filter annotations</span>
        <input
          value={annotationQuery}
          placeholder="Notes, selected text, tags"
          onChange={(event) => setAnnotationQuery(event.target.value)}
        />
      </label>
      <div className="pdf-annotation-list">
        {annotations.map((annotation) => (
          <button
            className={selectedAnnotationId === annotation.annotation_id ? 'active' : ''}
            key={annotation.annotation_id}
            onClick={() => {
              setPageNumber(annotation.page_number)
              setSelectedAnnotationId(annotation.annotation_id)
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
          onClose={() => setSelectedAnnotationId(null)}
        />
      )}
    </aside>
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
      {draft.selectedText && <blockquote>{draft.selectedText}</blockquote>}
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
      {annotation.selected_text && <blockquote>{annotation.selected_text}</blockquote>}
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
