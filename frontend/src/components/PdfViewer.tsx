import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Copy,
  Map as MapIcon,
  Maximize2,
  MessageSquare,
  Quote,
  StickyNote,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { api, type Annotation, type Document, type PdfRect } from '../api'
import type { PdfViewState } from '../documentSessions'
import { normalizePdfRect } from '../pdfGeometry'
import { PdfAnnotationPreview } from './PdfAnnotationPreview'
import { PdfSelectionToolbar, type PdfTextSelection } from './PdfSelectionToolbar'
import { annotationTypeLabel, type AnnotationDraft } from './pdfResearchTypes'

GlobalWorkerOptions.workerSrc = workerSource

type Point = { x: number; y: number }
type PageSize = { width: number; height: number }

type PdfViewerProps = {
  document: Document
  pdfState: PdfViewState
  setPageNumber: (pageNumber: number) => void
  updatePdfState: (patch: Partial<PdfViewState>) => void
  annotations: Annotation[]
  onSelectAnnotation: (annotationId: string) => void
  onOpenResearch: () => void
  setDraft: Dispatch<SetStateAction<AnnotationDraft | null>>
}

export function PdfViewer({
  document,
  pdfState,
  setPageNumber,
  updatePdfState,
  annotations,
  onSelectAnnotation,
  onOpenResearch,
  setDraft,
}: PdfViewerProps) {
  const queryClient = useQueryClient()
  const pageNumber = pdfState.pageNumber
  const scrollRef = useRef<HTMLDivElement>(null)
  const initialStateRef = useRef(pdfState)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pageSize, setPageSize] = useState<PageSize>({ width: 612, height: 792 })
  const [availableWidth, setAvailableWidth] = useState(0)
  const [isSelectingArea, setIsSelectingArea] = useState(false)
  const [textSelection, setTextSelection] = useState<PdfTextSelection | null>(null)
  const createHighlight = useMutation({
    mutationFn: ({ selection, color }: { selection: PdfTextSelection; color: string }) =>
      api.createAnnotation(document.document_id, {
        page_number: selection.pageNumber,
        annotation_type: 'text_highlight',
        selected_text: selection.selectedText,
        geometry: selection.geometry,
        color,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['annotations', document.document_id] })
      setTextSelection(null)
      window.getSelection()?.removeAllRanges()
    },
  })
  const retryExtraction = useMutation({
    mutationFn: () => api.retryPdfExtraction(document.document_id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['document', document.document_id] })
    },
  })

  useEffect(() => {
    const task = getDocument({ url: api.pdfContentUrl(document.document_id) })
    let active = true
    void task.promise.then(async (loaded) => {
      if (!active) return
      const firstPage = await loaded.getPage(1)
      if (!active) return
      const viewport = firstPage.getViewport({ scale: 1 })
      setPageSize({ width: viewport.width, height: viewport.height })
      setPdf(loaded)
      const initialState = initialStateRef.current
      const boundedPage = Math.min(Math.max(initialState.pageNumber, 1), loaded.numPages)
      if (boundedPage !== initialState.pageNumber) setPageNumber(boundedPage)
      requestAnimationFrame(() => {
        const host = scrollRef.current
        if (!host) return
        if (initialState.scrollTop > 0) host.scrollTop = initialState.scrollTop
        else if (boundedPage > 1) pageElement(document.document_id, boundedPage)?.scrollIntoView()
      })
    })
    return () => {
      active = false
      void task.destroy()
    }
    // Loading owns the PDF.js worker and must only follow document identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [document.document_id])

  useEffect(() => {
    const host = scrollRef.current
    if (!host) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(entry.contentRect.width)
    })
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const fitScale = Math.max(0.4, Math.min(2.4, (availableWidth - 32) / pageSize.width))
  const effectiveScale = pdfState.zoomMode === 'fit-width' && availableWidth ? fitScale : pdfState.scale

  const scrollToPage = (next: number) => {
    const bounded = Math.min(Math.max(next, 1), pdf?.numPages ?? 1)
    const host = scrollRef.current
    const target = pageElement(document.document_id, bounded)
    if (host && target) {
      target.scrollIntoView({ block: 'start' })
      setPageNumber(bounded)
    } else {
      setPageNumber(bounded)
    }
  }
  const chooseScale = (nextScale: number) => {
    updatePdfState({ scale: nextScale, zoomMode: 'custom' })
  }
  const fitWidth = () => {
    updatePdfState({ scale: effectiveScale, zoomMode: 'fit-width' })
  }
  const dismissSelection = useCallback(() => {
    setTextSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  return (
    <section className="pdf-reader">
      <div className="pdf-toolbar">
        <div className="pdf-toolbar-group">
          <div className="pdf-page-controls">
            <button
              className="icon-button"
              aria-label="Previous PDF page"
              disabled={pageNumber <= 1}
              onClick={() => scrollToPage(pageNumber - 1)}
            >
              <ChevronLeft size="var(--icon-control)" />
            </button>
            <label>
              Page
              <input
                inputMode="numeric"
                aria-label="PDF page number"
                key={pageNumber}
                defaultValue={pageNumber}
                onBlur={(event) => {
                  const next = Number(event.currentTarget.value)
                  if (pdf && Number.isInteger(next) && next >= 1 && next <= pdf.numPages) scrollToPage(next)
                  else event.currentTarget.value = String(pageNumber)
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return
                  const next = Number(event.currentTarget.value)
                  if (pdf && Number.isInteger(next) && next >= 1 && next <= pdf.numPages) scrollToPage(next)
                }}
              />
              <span>of {pdf?.numPages ?? document.pdf_page_count ?? '…'}</span>
            </label>
            <button
              className="icon-button"
              aria-label="Next PDF page"
              disabled={!pdf || pageNumber >= pdf.numPages}
              onClick={() => scrollToPage(pageNumber + 1)}
            >
              <ChevronRight size="var(--icon-control)" />
            </button>
          </div>
          <div className="pdf-zoom-controls">
            <button
              className="icon-button"
              aria-label="Zoom out"
              disabled={effectiveScale <= 0.4}
              onClick={() => chooseScale(Math.max(0.4, Number((effectiveScale - 0.2).toFixed(1))))}
            >
              <ZoomOut size="var(--icon-control)" />
            </button>
            <output aria-label="PDF zoom">{Math.round(effectiveScale * 100)}%</output>
            <button
              className="icon-button"
              aria-label="Zoom in"
              disabled={effectiveScale >= 2.4}
              onClick={() => chooseScale(Math.min(2.4, Number((effectiveScale + 0.2).toFixed(1))))}
            >
              <ZoomIn size="var(--icon-control)" />
            </button>
            <button
              className={pdfState.zoomMode === 'fit-width' ? 'active' : ''}
              type="button"
              aria-label="Fit PDF to width"
              title="Fit to width"
              onClick={fitWidth}
            >
              <Maximize2 size="var(--icon-inline)" /> <span className="pdf-action-text">Fit width</span>
            </button>
          </div>
        </div>
        <div className="pdf-toolbar-actions">
          <button
            className={isSelectingArea ? 'active' : ''}
            type="button"
            aria-label={isSelectingArea ? 'Cancel area selection' : 'Area highlight'}
            onClick={() => setIsSelectingArea((current) => !current)}
          >
            <MapIcon size="var(--icon-inline)" />
            <span className="pdf-action-text">{isSelectingArea ? 'Cancel area' : 'Area highlight'}</span>
          </button>
          <button
            type="button"
            aria-label="Copy page link"
            onClick={() =>
              void navigator.clipboard.writeText(
                `[${document.title}, p. ${pageNumber}](sangam://document/${document.document_id}?page=${pageNumber})`,
              )
            }
          >
            <Copy size="var(--icon-inline)" /> <span className="pdf-action-text">Copy page link</span>
          </button>
        </div>
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
      <div
        className="pdf-page-scroll"
        ref={scrollRef}
        onScroll={(event) => {
          setTextSelection(null)
          const host = event.currentTarget
          const position = host.scrollTop + host.offsetTop + host.clientHeight * 0.35
          const visible = Array.from(host.querySelectorAll<HTMLElement>('[data-pdf-page]'))
            .filter((element) => element.offsetTop <= position)
            .at(-1)
          const nextPage = Number(visible?.dataset.pdfPage ?? 1)
          updatePdfState({ scrollTop: host.scrollTop, pageNumber: nextPage })
        }}
      >
        {pdf &&
          Array.from({ length: pdf.numPages }, (_, index) => {
            const number = index + 1
            return (
              <PdfPage
                key={`${number}:${effectiveScale}`}
                pdf={pdf}
                documentId={document.document_id}
                pageNumber={number}
                scale={effectiveScale}
                pageSize={pageSize}
                annotations={annotations.filter((annotation) => annotation.page_number === number)}
                active={Math.abs(number - pageNumber) <= 1}
                isSelectingArea={isSelectingArea && number === pageNumber}
                onSelectAnnotation={onSelectAnnotation}
                onTextSelection={setTextSelection}
                setDraft={setDraft}
                finishArea={() => setIsSelectingArea(false)}
              />
            )
          })}
      </div>
      {textSelection && (
        <PdfSelectionToolbar
          documentId={document.document_id}
          documentTitle={document.title}
          selection={textSelection}
          pending={createHighlight.isPending}
          onHighlight={(color) => createHighlight.mutate({ selection: textSelection, color })}
          onAddNote={() => {
            setDraft({
              annotationType: 'comment',
              selectedText: textSelection.selectedText,
              geometry: textSelection.geometry,
            })
            onOpenResearch()
            setTextSelection(null)
          }}
          onDismiss={dismissSelection}
        />
      )}
    </section>
  )
}

function PdfPage({
  pdf,
  documentId,
  pageNumber,
  scale,
  pageSize,
  annotations,
  active,
  isSelectingArea,
  onSelectAnnotation,
  onTextSelection,
  setDraft,
  finishArea,
}: {
  pdf: PDFDocumentProxy
  documentId: string
  pageNumber: number
  scale: number
  pageSize: PageSize
  annotations: Annotation[]
  active: boolean
  isSelectingArea: boolean
  onSelectAnnotation: (annotationId: string) => void
  onTextSelection: (selection: PdfTextSelection) => void
  setDraft: Dispatch<SetStateAction<AnnotationDraft | null>>
  finishArea: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [nearViewport, setNearViewport] = useState(active)
  const queryClient = useQueryClient()
  const [areaStart, setAreaStart] = useState<Point | null>(null)
  const [areaPreview, setAreaPreview] = useState<PdfRect | null>(null)
  const [preview, setPreview] = useState<{ annotation: Annotation; anchor: HTMLElement } | null>(null)
  const removeAnnotation = useMutation({
    mutationFn: (annotation: Annotation) => api.deleteAnnotation(annotation),
    onSuccess: async (annotation) => {
      setPreview(null)
      await queryClient.invalidateQueries({ queryKey: ['annotations', annotation.document_id] })
    },
  })
  const width = pageSize.width * scale
  const height = pageSize.height * scale

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const scrollHost = host.closest('.pdf-page-scroll')
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setNearViewport(true)
      },
      { root: scrollHost, rootMargin: '100% 0px' },
    )
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!nearViewport || !canvasRef.current || !textLayerRef.current) return
    let activeRender = true
    let page: PDFPageProxy | null = null
    let textLayer: TextLayer | null = null
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null
    void pdf.getPage(pageNumber).then(async (loadedPage) => {
      page = loadedPage
      if (!activeRender || !canvasRef.current || !textLayerRef.current) return
      const viewport = loadedPage.getViewport({ scale })
      const canvas = canvasRef.current
      const textHost = textLayerRef.current
      const outputScale = window.devicePixelRatio || 1
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.width = `${viewport.width}px`
      canvas.style.height = `${viewport.height}px`
      textHost.replaceChildren()
      textLayer = new TextLayer({
        textContentSource: await loadedPage.getTextContent(),
        container: textHost,
        viewport,
      })
      renderTask = loadedPage.render({
        canvas,
        viewport,
        transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      })
      try {
        await Promise.all([renderTask.promise, textLayer.render()])
      } catch (error) {
        if (activeRender) throw error
      }
    })
    return () => {
      activeRender = false
      renderTask?.cancel()
      textLayer?.cancel()
      page?.cleanup()
    }
  }, [nearViewport, pageNumber, pdf, scale])

  const selectText = () => {
    if (isSelectingArea || areaStart) return
    const host = hostRef.current
    const selection = window.getSelection()
    if (!host || !selection || selection.isCollapsed || !selection.toString().trim()) return
    const range = selection.getRangeAt(0)
    if (!host.contains(range.commonAncestorContainer)) return
    const hostBounds = host.getBoundingClientRect()
    const geometry = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => normalizePdfRect(rect, hostBounds))
    if (geometry.length === 0) return
    const bounds = range.getBoundingClientRect()
    onTextSelection({
      pageNumber,
      selectedText: selection.toString().trim(),
      geometry,
      anchor: {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
      },
    })
  }
  const beginArea = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isSelectingArea || !hostRef.current) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const start = pointInHost(event, hostRef.current)
    setAreaStart(start)
    setAreaPreview(rectFromPoints(start, start))
  }
  const updateArea = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!isSelectingArea || !areaStart || !hostRef.current) return
    setAreaPreview(rectFromPoints(areaStart, pointInHost(event, hostRef.current)))
  }
  const finishAreaSelection = () => {
    if (areaPreview && areaPreview.width > 0.005 && areaPreview.height > 0.005) {
      setDraft({ annotationType: 'area_highlight', selectedText: null, geometry: [areaPreview] })
    }
    setAreaStart(null)
    setAreaPreview(null)
    finishArea()
  }

  return (
    <article
      id={`pdf-page-${documentId}-${pageNumber}`}
      className={`pdf-page ${isSelectingArea ? 'is-selecting-area' : ''}`}
      data-pdf-page={pageNumber}
      ref={hostRef}
      style={{ width, height }}
      aria-label={`PDF page ${pageNumber}`}
      onMouseUp={selectText}
      onPointerDown={beginArea}
      onPointerMove={updateArea}
      onPointerUp={finishAreaSelection}
    >
      {nearViewport && <canvas ref={canvasRef} />}
      {nearViewport && <div className="textLayer" ref={textLayerRef} />}
      <div className="pdf-annotation-layer">
        {annotations.flatMap((annotation) =>
          annotation.geometry.map((rect, index) => (
            <button
              className={`pdf-annotation-mark ${annotation.annotation_type}`}
              key={`${annotation.annotation_id}:${index}`}
              aria-label={`Open ${annotationTypeLabel(annotation.annotation_type)} annotation`}
              style={
                {
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.width * 100}%`,
                  height: `${rect.height * 100}%`,
                  '--annotation-color': annotation.color,
                } as CSSProperties
              }
              onMouseEnter={(event) => setPreview({ annotation, anchor: event.currentTarget })}
              onFocus={(event) => setPreview({ annotation, anchor: event.currentTarget })}
              onClick={() => onSelectAnnotation(annotation.annotation_id)}
            >
              {annotation.annotation_type === 'area_highlight' && index === 0 && (
                <span className="pdf-area-highlight-chip" aria-hidden="true">
                  <MapIcon size="var(--icon-detail)" />
                </span>
              )}
            </button>
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
      <div className="pdf-annotation-gutter" aria-label={`Page ${pageNumber} annotation pins`}>
        {annotations
          .filter((annotation) => annotation.geometry.length === 0)
          .map((annotation) => (
            <button
              type="button"
              key={annotation.annotation_id}
              data-annotation-id={annotation.annotation_id}
              aria-label={`Open ${annotationTypeLabel(annotation.annotation_type)} annotation`}
              style={{ '--annotation-color': annotation.color } as CSSProperties}
              onMouseEnter={(event) => setPreview({ annotation, anchor: event.currentTarget })}
              onFocus={(event) => setPreview({ annotation, anchor: event.currentTarget })}
              onClick={() => onSelectAnnotation(annotation.annotation_id)}
            >
              <AnnotationPinIcon annotation={annotation} />
            </button>
          ))}
      </div>
      <span className="pdf-page-label">{pageNumber}</span>
      {preview && (
        <PdfAnnotationPreview
          annotation={preview.annotation}
          anchor={preview.anchor}
          deleting={removeAnnotation.isPending}
          onEdit={() => {
            onSelectAnnotation(preview.annotation.annotation_id)
            setPreview(null)
          }}
          onDelete={() => removeAnnotation.mutate(preview.annotation)}
          onDismiss={() => setPreview(null)}
        />
      )}
    </article>
  )
}

function AnnotationPinIcon({ annotation }: { annotation: Annotation }) {
  if (annotation.annotation_type === 'bookmark') return <Bookmark size="var(--icon-inline)" />
  if (annotation.annotation_type === 'citation_marker') return <Quote size="var(--icon-inline)" />
  if (annotation.annotation_type === 'comment') return <MessageSquare size="var(--icon-inline)" />
  return <StickyNote size="var(--icon-inline)" />
}

function pageElement(documentId: string, pageNumber: number) {
  return window.document.getElementById(`pdf-page-${documentId}-${pageNumber}`)
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
