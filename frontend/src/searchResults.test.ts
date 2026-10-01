import { describe, expect, it } from 'vitest'
import type { SearchMatch } from './api'
import { matchLocationLabel, matchSourceLabel, matchTarget, snippetParts } from './searchResults'

const base: SearchMatch = {
  source: 'content',
  snippet: '',
  exact: null,
  line: null,
  heading: null,
  page_number: null,
  annotation_id: null,
}

describe('snippetParts', () => {
  it('splits highlight markers into marked and plain parts', () => {
    expect(snippetParts('… peak [[memory]] reached [[6]] GB')).toEqual([
      { text: '… peak ', match: false },
      { text: 'memory', match: true },
      { text: ' reached ', match: false },
      { text: '6', match: true },
      { text: ' GB', match: false },
    ])
  })

  it('treats an unclosed marker as plain text', () => {
    expect(snippetParts('a [[b')).toEqual([{ text: 'a [[b', match: false }])
  })
})

describe('match labels', () => {
  it('names the heading and line for document text', () => {
    const match = { ...base, heading: 'Hardware requirements', line: 7 }
    expect(matchLocationLabel(match)).toBe('Hardware requirements · line 7')
    expect(matchSourceLabel(match)).toBe('Matched in document text')
  })

  it('names the page for PDF text and annotations', () => {
    expect(matchLocationLabel({ ...base, source: 'pdf_page', page_number: 8 })).toBe('Page 8')
    expect(matchSourceLabel({ ...base, source: 'pdf_page', page_number: 8 })).toBe('Matched in PDF text')
    expect(matchLocationLabel({ ...base, source: 'annotation', page_number: 3 })).toBe('Note on page 3')
  })

  it('explains title and metadata matches without a location', () => {
    expect(matchLocationLabel({ ...base, source: 'title' })).toBeNull()
    expect(matchSourceLabel({ ...base, source: 'title' })).toBe('Matched in title')
    expect(matchSourceLabel({ ...base, source: 'metadata' })).toBe('Matched in tags or details')
  })
})

describe('matchTarget', () => {
  it('opens document text at the matched line and word', () => {
    expect(matchTarget('doc-1', { ...base, line: 7, exact: 'memory' })).toEqual({
      documentId: 'doc-1',
      passage: { line: 7, exact: 'memory' },
    })
  })

  it('opens a PDF at the page, and an annotation at its note', () => {
    expect(matchTarget('doc-2', { ...base, source: 'pdf_page', page_number: 8 })).toEqual({
      documentId: 'doc-2',
      pageNumber: 8,
    })
    expect(
      matchTarget('doc-2', { ...base, source: 'annotation', page_number: 3, annotation_id: 'ann-1' }),
    ).toEqual({ documentId: 'doc-2', pageNumber: 3, annotationId: 'ann-1' })
  })

  it('opens the document itself for title matches', () => {
    expect(matchTarget('doc-3', { ...base, source: 'title' })).toEqual({ documentId: 'doc-3' })
  })
})
