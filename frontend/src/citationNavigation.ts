import { z } from 'zod'
import { textLocatorSchema, type TextLocator } from './evidenceCitation'

export type CitationTarget = {
  documentId: string
  revisionId?: string
  pageNumber?: number
  annotationId?: string
  title?: string
  textLocator?: TextLocator
}

export const CITATION_NAVIGATION_EVENT = 'sangam:citation-navigation'

const citationDataSchema = z.object({
  text_locator: textLocatorSchema.optional(),
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
    textLocator: parsed.data.text_locator,
  }
}

export function citationTargetFromLocation(documentId: string): CitationTarget | null {
  if (!window.location.pathname.endsWith(`/documents/${documentId}`))
    return pendingTargets.get(documentId) ?? null
  const search = new URLSearchParams(window.location.search)
  pendingTargets.delete(documentId)
  const exact = search.get('text')
  const start = Number(search.get('start') ?? 0)
  const target = citationTargetFromData({
    document_id: documentId,
    revision_id: search.get('revision') ?? undefined,
    page_number: search.get('page') ?? undefined,
    annotation_id: search.get('annotation') ?? undefined,
    text_locator:
      exact && Number.isInteger(start) && start >= 0
        ? {
            exact,
            start,
            end: start + exact.length,
            prefix: '',
            suffix: '',
            representation: search.get('representation') === 'rendered' ? 'rendered' : 'source',
          }
        : undefined,
  })
  return target && (target.revisionId || target.pageNumber || target.annotationId || target.textLocator)
    ? target
    : null
}

export function citationHref(target: CitationTarget): string {
  const search = new URLSearchParams()
  if (target.revisionId) search.set('revision', target.revisionId)
  if (target.pageNumber) search.set('page', String(target.pageNumber))
  if (target.annotationId) search.set('annotation', target.annotationId)
  if (target.textLocator) {
    search.set('text', target.textLocator.exact)
    search.set('start', String(target.textLocator.start))
    if (target.textLocator.representation) search.set('representation', target.textLocator.representation)
  }
  const suffix = search.size ? `?${search.toString()}` : ''
  return `/documents/${encodeURIComponent(target.documentId)}${suffix}`
}

const pendingTargets = new Map<string, CitationTarget>()
export function clearCitationNavigation(documentId: string) {
  pendingTargets.delete(documentId)
}
export function announceCitationNavigation(target: CitationTarget) {
  pendingTargets.set(target.documentId, target)
  window.dispatchEvent(new CustomEvent<CitationTarget>(CITATION_NAVIGATION_EVENT, { detail: target }))
}
