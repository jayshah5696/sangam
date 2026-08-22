import { createContext, useContext, type ReactNode } from 'react'
import type { Annotation } from './api'
import type { AnnotationDraft } from './components/pdfResearchTypes'

type PdfResearchState = {
  pageNumber: number
  setPageNumber: (pageNumber: number) => void
  scrollToPage: (pageNumber: number) => void
  annotations: Annotation[]
  annotationQuery: string
  setAnnotationQuery: (query: string) => void
  selectedAnnotationId: string | null
  setSelectedAnnotationId: (annotationId: string | null) => void
  draft: AnnotationDraft | null
  setDraft: (draft: AnnotationDraft | null) => void
}

const PdfResearchContext = createContext<PdfResearchState | null>(null)

export function PdfResearchProvider({ value, children }: { value: PdfResearchState; children: ReactNode }) {
  return <PdfResearchContext.Provider value={value}>{children}</PdfResearchContext.Provider>
}

export function usePdfResearch() {
  return useContext(PdfResearchContext)
}
