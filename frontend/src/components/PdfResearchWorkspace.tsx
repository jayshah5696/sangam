import { useCallback, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Document } from '../api'
import { CITATION_NAVIGATION_EVENT, type CitationTarget } from '../citationNavigation'
import { useDocumentSession, useDocumentSessions, type PdfViewState } from '../documentSessions'
import { PdfViewer } from './PdfViewer'

const defaultPdfState: PdfViewState = {
  pageNumber: 1,
  scale: 1,
  zoomMode: 'fit-width',
  scrollTop: 0,
}

export function PdfResearchWorkspace({ document }: { document: Document }) {
  const sessions = useDocumentSessions()
  const session = useDocumentSession(document.document_id)
  const initialSearch = useMemo(() => new URLSearchParams(window.location.search), [])
  const requestedPage = Number(initialSearch.get('page'))
  const pdfState = useMemo(
    () =>
      session.pdfState ?? {
        ...defaultPdfState,
        pageNumber:
          Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : defaultPdfState.pageNumber,
      },
    [requestedPage, session.pdfState],
  )
  const annotationQuery = session.pdfAnnotationQuery ?? ''
  const annotationsQuery = useQuery({
    queryKey: ['annotations', document.document_id, annotationQuery],
    queryFn: () => api.listAnnotations(document.document_id, annotationQuery),
  })
  const annotations = useMemo(() => annotationsQuery.data ?? [], [annotationsQuery.data])

  const updatePdfState = useCallback(
    (patch: Partial<PdfViewState>) => {
      const current = sessions.getSession(document.document_id).pdfState ?? defaultPdfState
      sessions.updateSession(document.document_id, { pdfState: { ...current, ...patch } })
    },
    [document.document_id, sessions],
  )
  const setPageNumber = useCallback((next: number) => updatePdfState({ pageNumber: next }), [updatePdfState])
  const scrollToPage = useCallback(
    (next: number) => {
      setPageNumber(next)
      documentPage(document.document_id, next)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    },
    [document.document_id, setPageNumber],
  )

  useEffect(() => {
    const receiveCitation = (event: Event) => {
      const target = (event as CustomEvent<CitationTarget>).detail
      if (target.documentId !== document.document_id) return
      if (target.pageNumber) scrollToPage(target.pageNumber)
      if (target.annotationId) {
        sessions.updateSession(document.document_id, { pdfSelectedAnnotationId: target.annotationId })
      }
    }
    window.addEventListener(CITATION_NAVIGATION_EVENT, receiveCitation)
    return () => window.removeEventListener(CITATION_NAVIGATION_EVENT, receiveCitation)
  }, [document.document_id, scrollToPage, sessions])

  return (
    <div className="pdf-research-workspace">
      <PdfViewer
        document={document}
        pdfState={pdfState}
        setPageNumber={setPageNumber}
        updatePdfState={updatePdfState}
        annotations={annotations}
        onSelectAnnotation={(id) =>
          sessions.updateSession(document.document_id, { pdfSelectedAnnotationId: id })
        }
        setDraft={(updater) => {
          const currentDraft = sessions.getSession(document.document_id).pdfDraft ?? null
          const nextDraft = typeof updater === 'function' ? updater(currentDraft) : updater
          sessions.updateSession(document.document_id, { pdfDraft: nextDraft })
        }}
      />
    </div>
  )
}

function documentPage(documentId: string, pageNumber: number) {
  return globalThis.document.getElementById(`pdf-page-${documentId}-${pageNumber}`)
}
