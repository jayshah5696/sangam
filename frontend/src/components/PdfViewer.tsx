import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type SetStateAction,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ChevronRight, Copy, Map, ZoomIn, ZoomOut } from 'lucide-react'
import { getDocument, GlobalWorkerOptions, TextLayer, type PDFDocumentProxy } from 'pdfjs-dist'
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { api, type Annotation, type Document, type PdfRect } from '../api'
import { annotationTypeLabel, type AnnotationDraft } from './pdfResearchTypes'

GlobalWorkerOptions.workerSrc = workerSource

type Point = { x: number; y: number }

type PdfViewerProps = {
  document: Document
  pageNumber: number
  setPageNumber: Dispatch<SetStateAction<number>>
  annotations: Annotation[]
  onSelectAnnotation: (annotationId: string) => void
  setDraft: Dispatch<SetStateAction<AnnotationDraft | null>>
}

export function PdfViewer({
  document,
  pageNumber,
  setPageNumber,
  annotations,
  onSelectAnnotation,
  setDraft,
}: PdfViewerProps) {
  const queryClient = useQueryClient()
  const pageHostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [scale, setScale] = useState(1.2)
  const [areaStart, setAreaStart] = useState<Point | null>(null)
  const [areaPreview, setAreaPreview] = useState<PdfRect | null>(null)
  const retryExtraction = useMutation({
    mutationFn: () => api.retryPdfExtraction(document.document_id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['document', document.document_id] })
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
  }, [document.document_id, setPageNumber])

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
    <section className="pdf-reader">
      <div className="pdf-toolbar">
        <div className="pdf-toolbar-group">
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
                  if (pdf && Number.isInteger(next) && next >= 1 && next <= pdf.numPages) {
                    setPageNumber(next)
                  }
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
        </div>
        <div className="pdf-toolbar-actions">
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
                  onClick={() => onSelectAnnotation(annotation.annotation_id)}
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
