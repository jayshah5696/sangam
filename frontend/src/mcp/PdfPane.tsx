import { useCallback, useEffect, useRef, useState } from 'react'
import { getDocument, TextLayer, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
// The bundled PDF.js handler supports opaque App hosts without worker/network CSP grants.
import 'pdfjs-dist/build/pdf.worker.mjs'
import type { App } from '@modelcontextprotocol/ext-apps'
import { z } from 'zod'
import { StateMessage } from '../components/ui/StateMessage'
import { normalizePdfRect } from '../pdfGeometry'
import { errorSchema, type AppAction, type PdfLocation, type Workspace } from './contracts'

const chunkSchema = z.object({
  bytes: z.string(),
  offset: z.number().int(),
  total_bytes: z.number().int().max(100_000_000),
  next_offset: z.number().int().nullable(),
})
const pageSchema = z.object({ status: z.string(), text: z.string().nullable(), error: z.string().nullable() })
const notesSchema = z.object({
  items: z.array(
    z.object({
      annotation_id: z.string(),
      note: z.string().nullable(),
      selected_text: z.string().nullable(),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      geometry: z.array(
        z.object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          width: z.number().positive().max(1),
          height: z.number().positive().max(1),
        }),
      ),
    }),
  ),
})
const searchSchema = z.object({
  items: z.array(z.object({ page_number: z.number().int(), snippet: z.string() })),
  next_offset: z.number().int().nullable(),
})
type PdfAction = Extract<
  AppAction,
  { type: 'pdf_bytes' | 'pdf_page' | 'pdf_search' | 'pdf_annotations' | 'pdf_note' }
>

export function PdfPane({
  app,
  workspace,
  location,
  onLocation,
  readOnly = false,
  onUnsavedChange,
  disabled = false,
  onSelectionChange,
}: {
  app: App
  workspace: Workspace
  location: PdfLocation
  onLocation: (location: PdfLocation) => void
  readOnly?: boolean
  onUnsavedChange?: (value: boolean) => void
  disabled?: boolean
  onSelectionChange?: (text: string, page: number) => void
}) {
  const document = workspace.document
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(location.page_number)
  const [zoom, setZoom] = useState(location.zoom)
  const [error, setError] = useState('')
  const [renderError, setRenderError] = useState('')
  const [rendered, setRendered] = useState(false)
  const [renderedPage, setRenderedPage] = useState(0)
  const [text, setText] = useState('')
  const [notes, setNotes] = useState<z.infer<typeof notesSchema>['items']>([])
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [notePending, setNotePending] = useState(false)
  const [moreNotes, setMoreNotes] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<z.infer<typeof searchSchema> | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchedQuery, setSearchedQuery] = useState('')
  const [showText, setShowText] = useState(false)
  const [width, setWidth] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textLayer = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const pendingNote = useRef<Extract<PdfAction, { type: 'pdf_note' }> | null>(null)
  const selectedPassage = useRef<string | null>(null)
  const selectedRects = useRef<ReturnType<typeof normalizePdfRect>[]>([])
  const [hasSelection, setHasSelection] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const restoredScroll = useRef(false)

  const call = useCallback(
    async (action: PdfAction) => {
      const reply = await app.callServerTool({ name: 'mcp_app', arguments: { action } })
      if (reply.isError) {
        const parsed = errorSchema.safeParse(reply.structuredContent)
        throw new Error(parsed.success ? parsed.data.error.message : 'The PDF operation failed.')
      }
      return reply.structuredContent
    },
    [app],
  )

  useEffect(() => {
    let cancelled = false
    let loading: ReturnType<typeof getDocument> | null = null
    void (async () => {
      let offset = 0
      let bytes: Uint8Array | null = null
      do {
        const chunk = chunkSchema.parse(
          await call({
            type: 'pdf_bytes',
            document_id: document.document_id,
            expected_revision_id: document.current_revision_id,
            offset,
            length: 64_000,
          }),
        )
        if (cancelled) return
        if (chunk.offset !== offset || (bytes && bytes.length !== chunk.total_bytes))
          throw new Error('PDF chunk sequence changed. Reopen the document.')
        bytes ??= new Uint8Array(chunk.total_bytes)
        const decoded = Uint8Array.from(atob(chunk.bytes), (character) => character.charCodeAt(0))
        bytes.set(decoded, offset)
        if (
          decoded.length > 64_000 ||
          offset + decoded.length > chunk.total_bytes ||
          (chunk.next_offset === null && offset + decoded.length !== chunk.total_bytes)
        )
          throw new Error('PDF chunk length changed. Reopen the document.')
        if (chunk.next_offset === null) break
        if (chunk.next_offset <= offset || chunk.next_offset !== offset + decoded.length)
          throw new Error('Invalid PDF chunk continuation.')
        offset = chunk.next_offset
      } while (!cancelled)
      if (!bytes || cancelled) return
      loading = getDocument({
        data: bytes,
        useWorkerFetch: false,
        useSystemFonts: true,
      })
      const loaded = await loading.promise
      if (!cancelled) setPdf(loaded)
    })().catch((failure) => {
      if (!cancelled) setRenderError(failure instanceof Error ? failure.message : 'PDF rendering failed.')
    })
    return () => {
      cancelled = true
      void loading?.destroy()
    }
    // The byte source is immutable for this revision. Page changes do not reload it.
  }, [document.document_id, document.current_revision_id, call])

  useEffect(() => {
    const element = surface.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      call({ type: 'pdf_page', document_id: document.document_id, page_number: pageNumber }),
      call({ type: 'pdf_annotations', document_id: document.document_id, page_number: pageNumber }),
    ])
      .then(([page, annotations]) => {
        if (cancelled) return
        const current = pageSchema.parse(page)
        setText(
          current.text ??
            (current.status === 'failed'
              ? (current.error ?? 'Extraction failed.')
              : 'PDF text extraction is pending. Refresh to check again.'),
        )
        setNotes(notesSchema.parse(annotations).items)
        setMoreNotes(z.object({ next_offset: z.number().int().nullable() }).parse(annotations).next_offset)
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : 'PDF page read failed.')
      })
    return () => {
      cancelled = true
    }
  }, [document.document_id, document.pdf_extraction_status, document.annotation_version, pageNumber, call])

  useEffect(() => {
    if (!pdf || !canvas.current || !textLayer.current || !width || showText) return
    let cancelled = false
    let render: RenderTask | null = null
    let layer: TextLayer | null = null
    setRendered(false)
    void pdf
      .getPage(pageNumber)
      .then(async (page) => {
        if (cancelled || !canvas.current || !textLayer.current) return
        const base = page.getViewport({ scale: 1 })
        const viewport = page.getViewport({ scale: (width / base.width) * zoom })
        if (viewport.width * viewport.height > 16_000_000 || viewport.height > 16_000)
          throw new Error('Page exceeds App rendering limits. Use page text.')
        const target = canvas.current
        target.width = Math.ceil(viewport.width)
        target.height = Math.ceil(viewport.height)
        textLayer.current.replaceChildren()
        textLayer.current.style.setProperty('--total-scale-factor', String(viewport.scale))
        const content = await page.getTextContent()
        if (content.items.length > 20_000)
          throw new Error('Page text layer exceeds App rendering limits. Use page text.')
        layer = new TextLayer({
          textContentSource: content,
          container: textLayer.current,
          viewport,
        })
        if (cancelled) return
        render = page.render({ canvas: target, viewport })
        await Promise.all([render.promise, layer.render()])
        if (!cancelled) {
          setRendered(true)
          setRenderedPage(pageNumber)
        }
      })
      .catch((failure) => {
        if (!cancelled)
          setRenderError(failure instanceof Error ? failure.message : 'PDF page rendering failed.')
      })
    return () => {
      cancelled = true
      render?.cancel()
      layer?.cancel()
    }
  }, [pdf, pageNumber, width, zoom, showText])

  useEffect(() => {
    if (rendered && !restoredScroll.current && surface.current) {
      restoredScroll.current = true
      surface.current.scrollTop = location.scroll_top
    }
  }, [rendered, location.scroll_top])

  async function searchPages(offset = 0) {
    setSearching(true)
    const value = offset === 0 ? query : searchedQuery
    try {
      const response = searchSchema.parse(
        await call({
          type: 'pdf_search',
          document_id: document.document_id,
          query: value,
          offset,
          limit: 25,
        }),
      )
      setHits((previous) => ({
        items: offset ? [...(previous?.items ?? []), ...response.items] : response.items,
        next_offset: response.next_offset,
      }))
      setSearchedQuery(value)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'PDF search failed.')
    } finally {
      setSearching(false)
    }
  }

  function navigate(page: number, scale = zoom) {
    if (pendingNote.current || note.trim()) {
      setError('Retry the pending note before changing pages.')
      return
    }
    setPageNumber(page)
    setZoom(scale)
    selectedPassage.current = null
    onSelectionChange?.('', page)
    selectedRects.current = []
    setHasSelection(false)
    if (surface.current) surface.current.scrollTop = 0
    onLocation({ kind: 'pdf', page_number: page, zoom: scale, scroll_top: 0 })
  }

  async function saveNote(annotationType: 'page_note' | 'text_highlight' = 'page_note') {
    pendingNote.current ??= {
      type: 'pdf_note',
      document_id: document.document_id,
      page_number: pageNumber,
      note,
      selected_text: selectedPassage.current,
      operation_key: crypto.randomUUID(),
      annotation_type: annotationType,
      geometry: annotationType === 'text_highlight' ? selectedRects.current : [],
    }
    setNotePending(true)
    onUnsavedChange?.(true)
    setSaving(true)
    try {
      await call(pendingNote.current)
      pendingNote.current = null
      setNotePending(false)
      setNote('')
      selectedPassage.current = null
      onSelectionChange?.('', pageNumber)
      selectedRects.current = []
      setHasSelection(false)
      onUnsavedChange?.(false)
      setNotes(
        notesSchema.parse(
          await call({ type: 'pdf_annotations', document_id: document.document_id, page_number: pageNumber }),
        ).items,
      )
      setError('')
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The note could not be saved. Retry uses its original key.',
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mcp-pdf" aria-label="PDF reader" inert={disabled}>
      <div className="mcp-pdf-toolbar">
        {!readOnly && workspace.can_annotate && (
          <button
            className="secondary-action"
            aria-label="Highlight selected passage"
            disabled={!hasSelection || saving || notePending}
            onClick={() => {
              void saveNote('text_highlight')
            }}
          >
            Highlight
          </button>
        )}
        <button
          className="secondary-action"
          aria-label="Previous PDF page"
          disabled={pageNumber <= 1}
          onClick={() => navigate(pageNumber - 1)}
        >
          Previous
        </button>
        <span>
          Page {pageNumber} of {pdf?.numPages ?? document.pdf_page_count ?? '…'}
        </span>
        <button
          className="secondary-action"
          aria-label="Next PDF page"
          disabled={!pdf || pageNumber >= pdf.numPages}
          onClick={() => navigate(pageNumber + 1)}
        >
          Next
        </button>
        <button
          className="secondary-action"
          aria-label="Zoom out"
          disabled={zoom <= 0.5}
          onClick={() => navigate(pageNumber, zoom - 0.25)}
        >
          −
        </button>
        <button
          className="secondary-action"
          aria-label="Zoom in"
          disabled={zoom >= 2}
          onClick={() => navigate(pageNumber, zoom + 0.25)}
        >
          +
        </button>
        <button className="secondary-action" onClick={() => setShowText((value) => !value)}>
          {showText ? 'Show PDF' : 'Read page text'}
        </button>
      </div>
      {error && <StateMessage compact kind="error" title="PDF action needs attention" description={error} />}
      {renderError && (
        <StateMessage
          compact
          kind="error"
          title="PDF rendering unavailable"
          description={`${renderError} Use Read page text for the extracted page.`}
        />
      )}
      <div
        className="mcp-pdf-scroll"
        ref={surface}
        onScroll={(event) => {
          if (restoredScroll.current)
            onLocation({
              kind: 'pdf',
              page_number: pageNumber,
              zoom,
              scroll_top: event.currentTarget.scrollTop,
            })
        }}
      >
        {showText ? (
          <pre>{text}</pre>
        ) : (
          <div className="mcp-pdf-page">
            {!pdf && !renderError && (
              <StateMessage compact kind="loading" title="Loading authorized PDF bytes" />
            )}
            <canvas
              ref={canvas}
              role="img"
              aria-label={`PDF page ${pageNumber}`}
              data-rendered={rendered && renderedPage === pageNumber}
            />
            <div
              className="textLayer"
              ref={textLayer}
              onMouseUp={() => {
                const selection = window.getSelection()
                if (
                  selection?.anchorNode &&
                  selection.focusNode &&
                  textLayer.current?.contains(selection.anchorNode) &&
                  textLayer.current.contains(selection.focusNode) &&
                  selection.rangeCount
                ) {
                  selectedPassage.current = selection.toString().slice(0, 20_000) || null
                  onSelectionChange?.(selection.toString(), pageNumber)
                  const bounds = textLayer.current.getBoundingClientRect()
                  selectedRects.current = Array.from(selection.getRangeAt(0).getClientRects())
                    .filter((rect) => rect.width > 0 && rect.height > 0)
                    .slice(0, 100)
                    .map((rect) => normalizePdfRect(rect, bounds))
                  setHasSelection(Boolean(selectedPassage.current && selectedRects.current.length))
                }
              }}
            />
            <div className="mcp-pdf-marks" aria-hidden="true">
              {notes.flatMap((item) =>
                item.geometry.map((rect, index) => (
                  <span
                    className="mcp-pdf-mark"
                    key={`${item.annotation_id}-${index}`}
                    style={{
                      left: `${rect.x * 100}%`,
                      top: `${rect.y * 100}%`,
                      width: `${rect.width * 100}%`,
                      height: `${rect.height * 100}%`,
                      backgroundColor: item.color,
                    }}
                  />
                )),
              )}
            </div>
          </div>
        )}
        <details>
          <summary>Search this PDF</summary>
          <label className="mcp-pdf-field">
            PDF search
            <input value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button
            className="secondary-action"
            disabled={!query.trim() || searching}
            onClick={() => {
              void searchPages()
            }}
          >
            Search PDF pages
          </button>
          {hits?.items.map((hit) => (
            <button
              className="secondary-action"
              key={hit.page_number}
              onClick={() => navigate(hit.page_number)}
            >
              Page {hit.page_number}: {hit.snippet}
            </button>
          ))}
          {hits?.next_offset !== null && hits?.next_offset !== undefined && (
            <button
              className="secondary-action"
              disabled={searching}
              onClick={() => {
                if (hits.next_offset !== null) void searchPages(hits.next_offset)
              }}
            >
              More PDF matches
            </button>
          )}
        </details>
        <section aria-label="Page notes">
          {notes.map((item) => (
            <div key={item.annotation_id}>
              {item.selected_text && <blockquote>{item.selected_text}</blockquote>}
              {item.note && <p>{item.note}</p>}
            </div>
          ))}
          {moreNotes !== null && (
            <button
              className="secondary-action"
              onClick={() => {
                void call({
                  type: 'pdf_annotations',
                  document_id: document.document_id,
                  page_number: pageNumber,
                  offset: moreNotes,
                })
                  .then((reply) => {
                    setNotes((previous) => [...previous, ...notesSchema.parse(reply).items])
                    setMoreNotes(
                      z.object({ next_offset: z.number().int().nullable() }).parse(reply).next_offset,
                    )
                  })
                  .catch((failure) =>
                    setError(failure instanceof Error ? failure.message : 'Page notes could not be read.'),
                  )
              }}
            >
              More page notes
            </button>
          )}
          {!readOnly && workspace.can_annotate && (
            <>
              <label className="mcp-pdf-field">
                Page note
                <textarea
                  aria-label="Page note"
                  value={note}
                  disabled={saving || notePending}
                  onChange={(event) => {
                    setNote(event.target.value)
                    onUnsavedChange?.(Boolean(event.target.value.trim()))
                  }}
                  maxLength={20_000}
                />
              </label>
              <button
                className="primary-button"
                disabled={saving || (!note.trim() && !notePending)}
                onClick={() => {
                  void saveNote()
                }}
              >
                {notePending ? 'Retry page note' : 'Save page note'}
              </button>
              {(note.trim() || notePending) && (
                <button className="secondary-action" disabled={saving} onClick={() => setDiscarding(true)}>
                  Discard local note
                </button>
              )}
              {discarding && (
                <div>
                  <p>Discard this local text? Any saved note will remain.</p>
                  <button className="secondary-action" onClick={() => setDiscarding(false)}>
                    Keep note
                  </button>
                  <button
                    className="secondary-action"
                    onClick={() => {
                      pendingNote.current = null
                      setNotePending(false)
                      setNote('')
                      setDiscarding(false)
                      onUnsavedChange?.(false)
                    }}
                  >
                    Discard note text
                  </button>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </section>
  )
}
