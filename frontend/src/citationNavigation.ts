export type CitationTarget = {
  documentId: string
  revisionId?: string
  pageNumber?: number
  annotationId?: string
  title?: string
}

export const CITATION_NAVIGATION_EVENT = 'sangam:citation-navigation'

function optionalString(value: unknown, maxLength = 200): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined
}

export function citationTargetFromData(data: Record<string, unknown> | undefined): CitationTarget | null {
  const documentId = optionalString(data?.document_id)
  if (!documentId) return null
  const rawPage = data?.page_number
  const pageNumber =
    typeof rawPage === 'number' && Number.isInteger(rawPage) && rawPage > 0
      ? rawPage
      : typeof rawPage === 'string' && /^\d+$/.test(rawPage) && Number(rawPage) > 0
        ? Number(rawPage)
        : undefined
  return {
    documentId,
    revisionId: optionalString(data?.revision_id),
    pageNumber,
    annotationId: optionalString(data?.annotation_id),
    title: optionalString(data?.title, 500),
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
