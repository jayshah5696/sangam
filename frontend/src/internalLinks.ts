import { citationHref, citationTargetFromParams } from './citationNavigation'

const internalDocumentPattern = /^sangam:\/\/document\/([0-9a-f-]+)(\?[^#\s]*)?$/i

/** Map a stored `sangam://document/...` link to the route that opens its exact target. */
export function internalDocumentHref(href: string): string | null {
  const match = internalDocumentPattern.exec(href)
  const documentId = match?.[1]
  if (!match || !documentId) return null
  const target = citationTargetFromParams(documentId, new URLSearchParams(match[2]?.slice(1)))
  return target ? citationHref(target) : `/documents/${documentId}`
}

export function internalDocumentMarkdown(document: {
  document_id: string
  title: string
  path: string | null
}) {
  const label = document.path ?? document.title
  return `[${label}](sangam://document/${document.document_id})`
}
