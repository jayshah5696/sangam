import type { SearchMatch } from './api'
import type { CitationTarget } from './citationNavigation'

export type SnippetPart = { text: string; match: boolean }

/** Split a server snippet that marks matched words with `[[` and `]]`. */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let rest = snippet
  while (rest) {
    const open = rest.indexOf('[[')
    const close = open >= 0 ? rest.indexOf(']]', open + 2) : -1
    if (open < 0 || close < 0) {
      parts.push({ text: rest, match: false })
      break
    }
    if (open > 0) parts.push({ text: rest.slice(0, open), match: false })
    parts.push({ text: rest.slice(open + 2, close), match: true })
    rest = rest.slice(close + 2)
  }
  return parts
}

/** Where the passage is, for example "Hardware requirements · line 7" or "Page 8". */
export function matchLocationLabel(match: SearchMatch): string | null {
  switch (match.source) {
    case 'content':
      if (match.heading && match.line) return `${match.heading} · line ${match.line}`
      return match.line ? `Line ${match.line}` : null
    case 'pdf_page':
      return match.page_number ? `Page ${match.page_number}` : null
    case 'annotation':
      return match.page_number ? `Note on page ${match.page_number}` : 'Note'
    default:
      return null
  }
}

/** Why the document matched. */
export function matchSourceLabel(match: SearchMatch): string {
  switch (match.source) {
    case 'content':
      return 'Matched in document text'
    case 'pdf_page':
      return 'Matched in PDF text'
    case 'annotation':
      return 'Matched in an annotation'
    case 'title':
      return 'Matched in title'
    case 'path':
      return 'Matched in path'
    case 'metadata':
      return 'Matched in tags or details'
  }
}

/** The navigation target that opens the document at the passage. */
export function matchTarget(documentId: string, match: SearchMatch): CitationTarget {
  if (match.source === 'content' && match.line) {
    return { documentId, passage: { line: match.line, exact: match.exact ?? undefined } }
  }
  if (match.source === 'annotation' && match.page_number && match.annotation_id) {
    return { documentId, pageNumber: match.page_number, annotationId: match.annotation_id }
  }
  if ((match.source === 'pdf_page' || match.source === 'annotation') && match.page_number) {
    return { documentId, pageNumber: match.page_number }
  }
  return { documentId }
}
