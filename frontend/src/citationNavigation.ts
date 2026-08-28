import { z } from 'zod'

export type CitationTarget = {
  documentId: string
  revisionId?: string
  pageNumber?: number
  annotationId?: string
  title?: string
}

export const CITATION_NAVIGATION_EVENT = 'sangam:citation-navigation'

const citationDataSchema = z.object({
  document_id: z.string().trim().min(1).max(200).optional(),
  revision_id: z.string().trim().min(1).max(200).optional(),
  page_number: z
    .union([
      z.number().int().positive(),
      z
        .string()
        .regex(/^\d+$/)
        .transform((val) => Number.parseInt(val, 10)),
    ])
    .optional(),
  annotation_id: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(500).optional(),
})

export type CitationDataPayload = z.input<typeof citationDataSchema>

export function citationTargetFromData(data: CitationDataPayload | undefined): CitationTarget | null {
  if (!data) return null
  const parsed = citationDataSchema.safeParse(data)
  if (!parsed.success || !parsed.data.document_id) return null
  return {
    documentId: parsed.data.document_id,
    revisionId: parsed.data.revision_id,
    pageNumber: parsed.data.page_number,
    annotationId: parsed.data.annotation_id,
    title: parsed.data.title,
  }
}

export function citationTargetFromLocation(documentId: string): CitationTarget | null {
  const search = new URLSearchParams(window.location.search)
  const target = citationTargetFromData({
    document_id: documentId,
    revision_id: search.get('revision') ?? undefined,
    page_number: search.get('page') ?? undefined,
    annotation_id: search.get('annotation') ?? undefined,
  })
  return target && (target.revisionId || target.pageNumber || target.annotationId) ? target : null
}

export function citationHref(target: CitationTarget): string {
  const search = new URLSearchParams()
  if (target.revisionId) search.set('revision', target.revisionId)
  if (target.pageNumber) search.set('page', String(target.pageNumber))
  if (target.annotationId) search.set('annotation', target.annotationId)
  const suffix = search.size ? `?${search.toString()}` : ''
  return `/documents/${encodeURIComponent(target.documentId)}${suffix}`
}

export function announceCitationNavigation(target: CitationTarget) {
  window.dispatchEvent(new CustomEvent<CitationTarget>(CITATION_NAVIGATION_EVENT, { detail: target }))
}
