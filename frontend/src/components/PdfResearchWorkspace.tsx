import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Document } from '../api'
import {
  CITATION_NAVIGATION_EVENT,
  citationTargetFromLocation,
  type CitationTarget,
} from '../citationNavigation'
import { useDocumentSession, useDocumentSessions, type PdfViewState } from '../documentSessions'
import { useTheme } from '../theme'
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
  const { updatePreferences } = useTheme()
  const [initialTarget] = useState(() => citationTargetFromLocation(document.document_id))
  const requestedPage = initialTarget?.pageNumber
  const [initialState] = useState(() => ({
    ...(session.pdfState ?? defaultPdfState),
    pageNumber: requestedPage ?? session.pdfState?.pageNumber ?? 1,
    scrollTop: requestedPage ? 0 : (session.pdfState?.scrollTop ?? 0),
  }))
  const [citationApplied, setCitationApplied] = useState(!initialTarget)
  const pdfState = useMemo(() => session.pdfState ?? initialState, [initialState, session.pdfState])
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
    if (initialTarget) {
      sessions.updateSession(document.document_id, {
        pdfState: initialState,
        pdfSelectedAnnotationId: initialTarget.annotationId ?? null,
        pdfAnnotationQuery: '',
      })
    }
    const frame = requestAnimationFrame(() => setCitationApplied(true))
    const receiveCitation = (event: Event) => {
      // SAFETY: CITATION_NAVIGATION_EVENT dispatches CustomEvent with detail: CitationTarget
      const target = (event as CustomEvent<CitationTarget>).detail
      if (target.documentId !== document.document_id) return
      if (target.pageNumber) {
        updatePdfState({ pageNumber: target.pageNumber, scrollTop: 0 })
        scrollToPage(target.pageNumber)
      }
      if (target.annotationId) {
        sessions.updateSession(document.document_id, {
          pdfSelectedAnnotationId: target.annotationId,
          pdfAnnotationQuery: '',
        })
      }
    }
    window.addEventListener(CITATION_NAVIGATION_EVENT, receiveCitation)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener(CITATION_NAVIGATION_EVENT, receiveCitation)
    }
  }, [document.document_id, initialState, initialTarget, scrollToPage, sessions, updatePdfState])

  return (
    <div className="pdf-research-workspace">
      {citationApplied && (
        <PdfViewer
          document={document}
          pdfState={pdfState}
          setPageNumber={setPageNumber}
          updatePdfState={updatePdfState}
          annotations={annotations}
          onSelectAnnotation={(id) => {
            sessions.updateSession(document.document_id, { pdfSelectedAnnotationId: id })
            updatePreferences({ rightVisible: true, rightTab: 'research' })
          }}
          onOpenResearch={() => updatePreferences({ rightVisible: true, rightTab: 'research' })}
          setDraft={(updater) => {
            const currentDraft = sessions.getSession(document.document_id).pdfDraft ?? null
            const nextDraft = updater instanceof Function ? updater(currentDraft) : updater
            sessions.updateSession(document.document_id, { pdfDraft: nextDraft })
          }}
        />
      )}
    </div>
  )
}

function documentPage(documentId: string, pageNumber: number) {
  return globalThis.document.getElementById(`pdf-page-${documentId}-${pageNumber}`)
}
