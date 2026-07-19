import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api, type Document } from '../api'
import { PdfResearchRail } from './PdfResearchRail'
import { PdfViewer } from './PdfViewer'
import type { AnnotationDraft } from './pdfResearchTypes'

export function PdfResearchWorkspace({ document }: { document: Document }) {
  const initialSearch = useMemo(() => new URLSearchParams(window.location.search), [])
  const [pageNumber, setPageNumber] = useState(() => {
    const requested = Number(initialSearch.get('page'))
    return Number.isInteger(requested) && requested > 0 ? requested : 1
  })
  const [annotationQuery, setAnnotationQuery] = useState('')
  const [draft, setDraft] = useState<AnnotationDraft | null>(null)
  const [selectedAnnotationId, setSelectedAnnotationId] = useState(initialSearch.get('annotation'))
  const annotationsQuery = useQuery({
    queryKey: ['annotations', document.document_id, annotationQuery],
    queryFn: () => api.listAnnotations(document.document_id, annotationQuery),
  })
  const annotations = annotationsQuery.data ?? []

  return (
    <div className="pdf-research-workspace">
      <PdfViewer
        document={document}
        pageNumber={pageNumber}
        setPageNumber={setPageNumber}
        annotations={annotations.filter((annotation) => annotation.page_number === pageNumber)}
        onSelectAnnotation={setSelectedAnnotationId}
        setDraft={setDraft}
      />
      <PdfResearchRail
        document={document}
        pageNumber={pageNumber}
        setPageNumber={setPageNumber}
        annotations={annotations}
        annotationQuery={annotationQuery}
        setAnnotationQuery={setAnnotationQuery}
        selectedAnnotationId={selectedAnnotationId}
        setSelectedAnnotationId={setSelectedAnnotationId}
        draft={draft}
        setDraft={setDraft}
      />
    </div>
  )
}
