import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronLeft, ChevronRight, Copy, Highlighter, Map, Search, ZoomIn, ZoomOut } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { api, type Annotation, type Document, type PdfRect } from '../api'
import { useWorkbench } from '../workbench'

GlobalWorkerOptions.workerSrc = workerSource

type AnnotationDraft = {
  annotationType: Annotation['annotation_type']
  selectedText: string | null
  geometry: PdfRect[]
}

type Point = { x: number; y: number }

export function PdfResearchWorkspace({ document }: { document: Document }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const workbench = useWorkbench()
  const pageHostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const initialSearch = useMemo(() => new URLSearchParams(window.location.search), [])
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(() => {
    const requested = Number(initialSearch.get('page'))
    return Number.isInteger(requested) && requested > 0 ? requested : 1
  })
  const [scale, setScale] = useState(1.2)
  const [query, setQuery] = useState('')
  const [annotationQuery, setAnnotationQuery] = useState('')
  const [draft, setDraft] = useState<AnnotationDraft | null>(null)
  const [areaStart, setAreaStart] = useState<Point | null>(null)
  const [areaPreview, setAreaPreview] = useState<PdfRect | null>(null)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState(initialSearch.get('annotation'))

  const annotationsQuery = useQuery({
    queryKey: ['annotations', document.document_id, annotationQuery],
    queryFn: () => api.listAnnotations(document.document_id, annotationQuery),
  })
  const search = useMutation({
    mutationFn: (value: string) => api.searchPdf(document.document_id, value),
  })
  const retryExtraction = useMutation({
    mutationFn: () => api.retryPdfExtraction(document.document_id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['document', document.document_id] })
    },
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

  useEffect(() => {
    const task = getDocument({ url: api.pdfContentUrl(document.document_id) })
    let active = true
    void task.promise.then((loaded) => {
      if (!active) return
      setPdf(loaded)
      setPageNumber((current) => Math.min(Math.max(current, 1), loaded.numPages))
    })
    return () => {
      active = false
      void task.destroy()
    }
  }, [document.document_id])

  useEffect(() => {
    if (!pdf || !canvasRef.current || !textLayerRef.current || !pageHostRef.current) return
    let active = true
    let textLayer: TextLayer | null = null
    void pdf.getPage(pageNumber).then(async (page) => {
      if (!active || !canvasRef.current || !textLayerRef.current || !pageHostRef.current) return
      const viewport = page.getViewport({ scale })
      const canvas = canvasRef.current
      const host = pageHostRef.current
      const textHost = textLayerRef.current
      const outputScale = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      host.style.width = `${viewport.width}px`
      host.style.height = `${viewport.height}px`
      textHost.replaceChildren()
      textLayer = new TextLayer({
        textContentSource: await page.getTextContent(),
        container: textHost,
        viewport,
      })
      await Promise.all([
        page.render({
          canvas,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        }).promise,
        textLayer.render(),
      ])
    })
    return () => {
      active = false
      textLayer?.cancel()
    }
  }, [pageNumber, pdf, scale])

  const pageAnnotations = (annotationsQuery.data ?? []).filter(
    (annotation) => annotation.page_number === pageNumber,
  )
  const selectedAnnotation = (annotationsQuery.data ?? []).find(
    (annotation) => annotation.annotation_id === selectedAnnotationId,
  )

  const selectText = () => {
    if (areaStart) return
    const host = pageHostRef.current
    const selection = window.getSelection()
    if (!host || !selection || selection.isCollapsed || !selection.toString().trim()) return
    const range = selection.getRangeAt(0)
    if (!host.contains(range.commonAncestorContainer)) return
    const hostBounds = host.getBoundingClientRect()
    const geometry = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => normalizeRect(rect, hostBounds))
    if (geometry.length === 0) return
    setDraft({
      annotationType: 'text_highlight',
      selectedText: selection.toString().trim(),
      geometry,
    })
  }

  const beginArea = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!areaStart || !pageHostRef.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    setAreaStart(pointInHost(event, pageHostRef.current))
  }

  const updateArea = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!areaStart || !pageHostRef.current) return
    setAreaPreview(rectFromPoints(areaStart, pointInHost(event, pageHostRef.current)))
  }

  const finishArea = () => {
    if (areaPreview && areaPreview.width > 0.005 && areaPreview.height > 0.005) {
      setDraft({ annotationType: 'area_highlight', selectedText: null, geometry: [areaPreview] })
    }
    setAreaStart(null)
    setAreaPreview(null)
  }

  const startAreaSelection = () => {
    setAreaStart({ x: 0, y: 0 })
    setDraft(null)
    window.getSelection()?.removeAllRanges()
  }

  return (
    <div className="pdf-research-workspace">
      <section className="pdf-reader">
        <div className="pdf-toolbar">
          <div className="pdf-page-controls">
            <button
              className="icon-button"
              aria-label="Previous PDF page"
              disabled={pageNumber <= 1}
              onClick={() => setPageNumber((page) => page - 1)}
            >
              <ChevronLeft size={15} />
            </button>
            <label>
              Page
              <input
                inputMode="numeric"
                value={pageNumber}
                onChange={(event) => {
                  const next = Number(event.target.value)
                  if (pdf && Number.isInteger(next) && next >= 1 && next <= pdf.numPages) setPageNumber(next)
                }}
              />
              <span>of {pdf?.numPages ?? document.pdf_page_count ?? '…'}</span>
            </label>
            <button
              className="icon-button"
              aria-label="Next PDF page"
              disabled={!pdf || pageNumber >= pdf.numPages}
              onClick={() => setPageNumber((page) => page + 1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="pdf-zoom-controls">
            <button
              className="icon-button"
              aria-label="Zoom out"
              disabled={scale <= 0.6}
              onClick={() => setScale((value) => Math.max(0.6, value - 0.2))}
            >
              <ZoomOut size={15} />
            </button>
            <span>{Math.round(scale * 100)}%</span>
            <button
              className="icon-button"
              aria-label="Zoom in"
              disabled={scale >= 2.4}
              onClick={() => setScale((value) => Math.min(2.4, value + 0.2))}
            >
              <ZoomIn size={15} />
            </button>
          </div>
          <button
            className={areaStart ? 'active' : ''}
            type="button"
            onClick={areaStart ? finishArea : startAreaSelection}
          >
            <Map size={14} /> {areaStart ? 'Cancel area' : 'Area highlight'}
          </button>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(
                `[${document.title}, p. ${pageNumber}](sangam://document/${document.document_id}?page=${pageNumber})`,
              )
            }
          >
            <Copy size={14} /> Copy page link
          </button>
        </div>
        {document.pdf_extraction_status !== 'ready' && (
          <div className={`pdf-extraction-state ${document.pdf_extraction_status ?? 'pending'}`}>
            <div>
              <strong>
                {document.pdf_extraction_status === 'failed'
                  ? 'Text extraction failed'
                  : 'Extracting searchable text…'}
              </strong>
              <small>
                {document.pdf_extraction_error ?? 'The PDF remains readable while extraction runs.'}
              </small>
            </div>
            {document.pdf_extraction_status === 'failed' && (
              <button disabled={retryExtraction.isPending} onClick={() => retryExtraction.mutate()}>
                Retry extraction
              </button>
            )}
          </div>
        )}
        <div className="pdf-page-scroll">
          <div
            className={`pdf-page ${areaStart ? 'is-selecting-area' : ''}`}
            ref={pageHostRef}
            onMouseUp={selectText}
            onPointerDown={beginArea}
            onPointerMove={updateArea}
            onPointerUp={finishArea}
          >
            <canvas ref={canvasRef} />
            <div className="textLayer" ref={textLayerRef} />
            <div className="pdf-annotation-layer">
              {pageAnnotations.flatMap((annotation) =>
                annotation.geometry.map((rect, index) => (
                  <button
                    className={`pdf-annotation-mark ${annotation.annotation_type}`}
                    key={`${annotation.annotation_id}:${index}`}
                    aria-label={`Open ${labelType(annotation.annotation_type)} annotation`}
                    style={
                      {
                        left: `${rect.x * 100}%`,
                        top: `${rect.y * 100}%`,
                        width: `${rect.width * 100}%`,
                        height: `${rect.height * 100}%`,
                        '--annotation-color': annotation.color,
                      } as CSSProperties
                    }
                    onClick={() => setSelectedAnnotationId(annotation.annotation_id)}
                  />
                )),
              )}
              {areaPreview && (
                <i
                  className="pdf-area-preview"
                  style={{
                    left: `${areaPreview.x * 100}%`,
                    top: `${areaPreview.y * 100}%`,
                    width: `${areaPreview.width * 100}%`,
                    height: `${areaPreview.height * 100}%`,
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </section>
      <aside className="pdf-research-rail ui-rail ui-rail--surface">
        <div className="ui-rail-header">
          <div>
            <p className="eyebrow">Research</p>
            <strong>Page {pageNumber}</strong>
          </div>
          <span className="scope-badge">{annotationsQuery.data?.length ?? 0} notes</span>
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
          <button onClick={() => setDraft({ annotationType: 'page_note', selectedText: null, geometry: [] })}>
            Add page note
          </button>
          <button onClick={() => setDraft({ annotationType: 'bookmark', selectedText: null, geometry: [] })}>
            Bookmark
          </button>
          <button
            onClick={() => setDraft({ annotationType: 'citation_marker', selectedText: null, geometry: [] })}
          >
            Citation
          </button>
          <button onClick={() => setDraft({ annotationType: 'comment', selectedText: null, geometry: [] })}>
            Comment
          </button>
        </div>
        <label className="pdf-replacement-control">
          <span>{importReplacement.isPending ? 'Importing replacement…' : 'Import replacement PDF'}</span>
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
          {(annotationsQuery.data ?? []).map((annotation) => (
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
                {labelType(annotation.annotation_type)} · p. {annotation.page_number}
              </span>
              <strong>{annotation.note ?? annotation.selected_text ?? 'No note'}</strong>
              <small>{annotation.updated_by_name}</small>
            </button>
          ))}
        </div>
        {selectedAnnotation && (
          <AnnotationDetail annotation={selectedAnnotation} onClose={() => setSelectedAnnotationId(null)} />
        )}
      </aside>
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
          <strong>{labelType(draft.annotationType)}</strong>
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
          <strong>{labelType(annotation.annotation_type)}</strong>
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

function pointInHost(event: ReactPointerEvent<HTMLElement>, host: HTMLElement): Point {
  const bounds = host.getBoundingClientRect()
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
  }
}

function rectFromPoints(start: Point, end: Point): PdfRect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}

function normalizeRect(rect: DOMRect, host: DOMRect): PdfRect {
  return {
    x: Math.max(0, (rect.left - host.left) / host.width),
    y: Math.max(0, (rect.top - host.top) / host.height),
    width: Math.min(1, rect.width / host.width),
    height: Math.min(1, rect.height / host.height),
  }
}

function splitTags(value: string) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

function labelType(type: Annotation['annotation_type']) {
  return type.replaceAll('_', ' ')
}
