import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Bookmark, Copy, Highlighter, MessageSquare, Quote, Search, StickyNote } from 'lucide-react'
import { api, type Annotation, type Document } from '../api'
import { usePdfResearch } from '../pdfResearchState'
import { useWorkbench } from '../workbench'
import { annotationTypeLabel, type AnnotationDraft } from './pdfResearchTypes'

export function citationMarkdown(
  annotation: Pick<Annotation, 'document_id' | 'annotation_id' | 'page_number' | 'selected_text' | 'note'>,
): string {
  const selectedText = annotation.selected_text?.trim()
  const noteText = annotation.note?.trim()
  const evidence = selectedText || noteText || 'Evidence from source.'
  const quote = evidence
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  const note = selectedText && noteText ? `\n> \n> ${noteText}` : ''
  const link = `sangam://document/${annotation.document_id}?page=${annotation.page_number}&annotation=${annotation.annotation_id}`
  return `\n\n${quote}${note}\n\n[Source: PDF p. ${annotation.page_number}](${link})\n`
}

export function PdfResearchRail({ document }: { document: Document }) {
  const research = usePdfResearch()
  const navigate = useNavigate()
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [draftId, setDraftId] = useState('')
  const search = useMutation({ mutationFn: (value: string) => api.searchPdf(document.document_id, value) })
  const documentsQuery = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments })
  const selectedAnnotation = research
    ? research.annotations.find((annotation) => annotation.annotation_id === research.selectedAnnotationId)
    : undefined
  const draftQuery = useQuery({
    queryKey: ['document', draftId, 'research-handoff'],
    queryFn: () => api.getDocument(draftId),
    enabled: Boolean(draftId),
  })
  const insertCitation = useMutation({
    mutationFn: async () => {
      if (!draftQuery.data || !selectedAnnotation) throw new Error('Choose a draft and an annotation first')
      return api.updateDocument(
        draftQuery.data,
        `${draftQuery.data.content.trimEnd()}${citationMarkdown(selectedAnnotation)}`,
      )
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['document', draftId] })
      await queryClient.invalidateQueries({ queryKey: ['history', draftId] })
    },
  })
  if (!research) return null
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
      <section className="research-handoff" aria-labelledby="research-handoff-title">
        <p className="eyebrow" id="research-handoff-title">
          Source and draft
        </p>
        <p className="small-muted">Keep this source beside a writing document while you work.</p>
        <label>
          <span>Writing document</span>
          <select value={draftId} onChange={(event) => setDraftId(event.target.value)}>
            <option value="">Choose a draft…</option>
            {(documentsQuery.data ?? [])
              .filter(
                (candidate) =>
                  candidate.document_id !== document.document_id &&
                  candidate.content_type !== 'application/pdf',
              )
              .map((candidate) => (
                <option key={candidate.document_id} value={candidate.document_id}>
                  {candidate.path ?? candidate.title}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          className="panel-button"
          disabled={!draftId}
          onClick={() => {
            const draft = documentsQuery.data?.find((candidate) => candidate.document_id === draftId)
            if (!draft) return
            const newGroupId = workbench.splitGroup(
              workbench.activeGroupId,
              'horizontal',
              document.document_id,
            )
            workbench.ensureDocumentOpen(draft.document_id, draft.title, newGroupId)
            void navigate({ to: '/documents/$documentId', params: { documentId: draft.document_id } })
          }}
        >
          Open draft beside source
        </button>
        <button
          type="button"
          className="secondary-action"
          disabled={!draftId || !selectedAnnotation || draftQuery.isLoading || insertCitation.isPending}
          onClick={() => insertCitation.mutate()}
        >
          {insertCitation.isPending ? 'Adding citation…' : 'Insert selected evidence'}
        </button>
        {insertCitation.isError && (
          <p className="error-text">The evidence could not be added to the draft.</p>
        )}
      </section>
      <form
        className="pdf-search"
        onSubmit={(event) => {
          event.preventDefault()
          if (query.trim()) search.mutate(query.trim())
        }}
      >
        <label>
          <Search size="var(--icon-control)" />
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
            <Icon size="var(--icon-control)" />
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
        <Highlighter size="var(--icon-inline)" /> {create.isPending ? 'Saving…' : 'Save annotation'}
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
          <Copy size="var(--icon-inline)" /> Copy Markdown link
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
