import { z } from 'zod'

/** An exact passage inside one immutable revision's text. */
export const textLocatorSchema = z
  .object({
    exact: z.string().min(1),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    prefix: z.string(),
    suffix: z.string(),
    representation: z.enum(['source', 'rendered']).optional(),
  })
  .refine((value) => value.end - value.start === value.exact.length, 'Invalid passage range')
export type TextLocator = z.infer<typeof textLocatorSchema>

export type CitationTarget = {
  documentId: string
  revisionId?: string
  pageNumber?: number
  annotationId?: string
  title?: string
  textLocator?: TextLocator
  quoteStart?: number
  quoteEnd?: number
  /** A search passage in the current revision: a 1-based line and the matched word. */
  passage?: { line: number; exact?: string }
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
  quote_start: z.number().int().nonnegative().optional(),
  quote_end: z.number().int().nonnegative().optional(),
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
    quoteStart: parsed.data.quote_start,
    quoteEnd: parsed.data.quote_end,
  }
}

export function citationTargetFromLocation(documentId: string): CitationTarget | null {
  if (!window.location.pathname.endsWith(`/documents/${documentId}`))
    return pendingTargets.get(documentId) ?? null
  const pending = pendingTargets.get(documentId)
  pendingTargets.delete(documentId)
  if (pending) return pending
  return citationTargetFromParams(documentId, new URLSearchParams(window.location.search))
}

/**
 * Every query parameter a citation link may carry. Encoding, decoding, and
 * clearing a citation all use this one list, so they cannot drift apart.
 */
export const CITATION_PARAM_KEYS = [
  'revision',
  'page',
  'annotation',
  'text',
  'start',
  'representation',
  'quoteStart',
  'quoteEnd',
  'line',
  'match',
] as const

/** Decode a citation from link parameters; null when they name no location. */
export function citationTargetFromParams(documentId: string, search: URLSearchParams): CitationTarget | null {
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
  if (target) {
    const offset = z.coerce.number().int().nonnegative()
    const start = search.has('quoteStart') ? offset.safeParse(search.get('quoteStart')) : null
    const end = search.has('quoteEnd') ? offset.safeParse(search.get('quoteEnd')) : null
    if (start?.success && end?.success && end.data > start.data) {
      target.quoteStart = start.data
      target.quoteEnd = end.data
    }
    const line = z.coerce.number().int().positive().safeParse(search.get('line'))
    if (search.has('line') && line.success) {
      target.passage = { line: line.data, exact: search.get('match')?.slice(0, 200) || undefined }
    }
  }
  return target &&
    (target.revisionId ||
      target.pageNumber ||
      target.annotationId ||
      target.textLocator ||
      target.passage ||
      target.quoteStart !== undefined)
    ? target
    : null
}

/** The in-app route that opens a citation. */
export function citationHref(target: CitationTarget): string {
  return `/documents/${encodeURIComponent(target.documentId)}${citationQuery(target)}`
}

/** The portable `sangam://` link stored in Markdown; it opens at the same target. */
export function citationLink(target: CitationTarget): string {
  return `sangam://document/${encodeURIComponent(target.documentId)}${citationQuery(target)}`
}

function citationQuery(target: CitationTarget): string {
  const search = new URLSearchParams()
  if (target.revisionId) search.set('revision', target.revisionId)
  if (target.pageNumber) search.set('page', String(target.pageNumber))
  if (target.annotationId) search.set('annotation', target.annotationId)
  if (target.textLocator) {
    search.set('text', target.textLocator.exact)
    search.set('start', String(target.textLocator.start))
    if (target.textLocator.representation) search.set('representation', target.textLocator.representation)
  }
  if (target.quoteStart !== undefined) search.set('quoteStart', String(target.quoteStart))
  if (target.quoteEnd !== undefined) search.set('quoteEnd', String(target.quoteEnd))
  if (target.passage) {
    search.set('line', String(target.passage.line))
    if (target.passage.exact) search.set('match', target.passage.exact)
  }
  return search.size ? `?${search.toString()}` : ''
}

const pendingTargets = new Map<string, CitationTarget>()
export function clearCitationNavigation(documentId: string) {
  pendingTargets.delete(documentId)
}
export function announceCitationNavigation(target: CitationTarget) {
  pendingTargets.set(target.documentId, target)
  window.dispatchEvent(new CustomEvent<CitationTarget>(CITATION_NAVIGATION_EVENT, { detail: target }))
}
