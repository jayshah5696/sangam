import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Bookmark,
  BookmarkCheck,
  Check,
  Copy,
  Highlighter,
  MessageSquare,
  Quote,
  Search,
  StickyNote,
  X,
} from 'lucide-react'
import { evidenceCitationMarkdown } from '../evidenceCitation'
import { useDocumentSessions } from '../documentSessions'
import { workspaceEvidenceStore } from '../workspaceEvidenceState'
import { api, writeFailureMessage, type Annotation, type Document } from '../api'
import { usePdfResearch } from '../pdfResearchState'
import { annotationLink } from '../pdfAnnotationUi'
import { useWorkbench } from '../workbench'
import { annotationTypeLabel, type AnnotationDraft } from './pdfResearchTypes'
import { StateMessage } from './ui/StateMessage'
import { useTheme } from '../theme'

export function citationMarkdown(
  annotation: Pick<Annotation, 'document_id' | 'annotation_id' | 'page_number' | 'selected_text' | 'note'>,
): string {
  return evidenceCitationMarkdown({
    documentId: annotation.document_id,
    pageNumber: annotation.page_number,
    annotationId: annotation.annotation_id,
    selectedText: annotation.selected_text ?? '',
    note: annotation.note ?? undefined,
  })
}

export function PdfResearchRail({ document }: { document: Document }) {
  const research = usePdfResearch()
  const navigate = useNavigate()
  const workbench = useWorkbench()
  const [query, setQuery] = useState('')
  const [draftId, setDraftId] = useState('')
  const search = useMutation({ mutationFn: (value: string) => api.searchPdf(document.document_id, value) })
  const documentsQuery = useQuery({ queryKey: ['documents', 'all'], queryFn: api.listDocuments })
  const selectedAnnotation = research
    ? research.annotations.find((annotation) => annotation.annotation_id === research.selectedAnnotationId)
    : undefined
  const sessions = useDocumentSessions()
  const { updatePreferences } = useTheme()
  const [error, setError] = useState<string | null>(null)
  const [inserted, setInserted] = useState(false)
  const [keptAnnotation, setKeptAnnotation] = useState<string | null>(null)
  const selectedAnnotationKey = selectedAnnotation
    ? `${selectedAnnotation.annotation_id}:${selectedAnnotation.version}`
    : null
  const kept = keptAnnotation !== null && keptAnnotation === selectedAnnotationKey

  const handleInsertCitation = async () => {
    if (!draftId || !selectedAnnotation) return
    const reference = {
      documentId: document.document_id,
      title: document.title,
      revisionId: document.current_revision_id,
      pageNumber: selectedAnnotation.page_number,
      annotationId: selectedAnnotation.annotation_id,
      selectedText: selectedAnnotation.selected_text ?? '',
      note: selectedAnnotation.note ?? undefined,
    }
    try {
      const [inserted] = await Promise.all([
        sessions.insertEvidence(draftId, reference),
        navigate({ to: '/documents/$documentId', params: { documentId: draftId } }),
      ])
      updatePreferences({ rightVisible: !matchMedia('(max-width: 900px)').matches })
      if (!inserted) throw new Error('The destination editor could not insert the passage.')
      setInserted(true)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleKeepEvidence = async () => {
    if (!selectedAnnotation) return
    try {
      await workspaceEvidenceStore.keepEvidence({
        sourceDocumentId: document.document_id,
        sourceTitle: document.title,
        sourceContentType: 'application/pdf',
        pinnedRevisionId: document.current_revision_id,
        geometry: selectedAnnotation.geometry,
        pageNumber: selectedAnnotation.page_number,
        annotationId: selectedAnnotation.annotation_id,
        selectedText: selectedAnnotation.selected_text ?? selectedAnnotation.note ?? '',
        note: selectedAnnotation.note ?? undefined,
      })
      setKeptAnnotation(`${selectedAnnotation.annotation_id}:${selectedAnnotation.version}`)
      setError(null)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    }
  }
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
      {error && <StateMessage compact kind="error" title="Evidence action failed" description={error} />}
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
          disabled={!draftId || !selectedAnnotation}
          onClick={() => void handleInsertCitation()}
        >
          {inserted ? (
            <>
              <Check size="var(--icon-inline)" /> Inserted at cursor
            </>
          ) : (
            'Insert selected evidence'
          )}
        </button>
        <button
          type="button"
          className="secondary-action"
          disabled={!selectedAnnotation}
          onClick={() => void handleKeepEvidence()}
        >
          {kept ? (
            <>
              <Check size="var(--icon-inline)" /> Kept as evidence
            </>
          ) : (
            <>
              <BookmarkCheck size="var(--icon-inline)" /> Keep as evidence
            </>
          )}
        </button>
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
          {search.data.length === 0 && <StateMessage compact kind="empty" title="No matching pages" />}
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
          <X size="var(--icon-control)" />
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
      {create.isError && (
        <StateMessage
          compact
          kind="error"
          title={writeFailureMessage(create.error, 'The annotation could not be saved.')}
        />
      )}
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
  const link = annotationLink(annotation)
  return (
    <section className="annotation-detail">
      <header>
        <div>
          <p className="eyebrow">Annotation</p>
          <strong>{annotationTypeLabel(annotation.annotation_type)}</strong>
        </div>
        <button className="icon-button" aria-label="Close annotation detail" onClick={onClose}>
          <X size="var(--icon-control)" />
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
      {(update.isError || remove.isError) && (
        <StateMessage
          compact
          kind="error"
          title={writeFailureMessage(
            update.error ?? remove.error,
            update.isError ? 'The annotation could not be saved.' : 'The annotation could not be removed.',
          )}
        />
      )}
      <div className="annotation-history">
        <p className="eyebrow">Version history</p>
        {history.isError && <StateMessage compact kind="error" title="Version history could not be loaded" />}
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
