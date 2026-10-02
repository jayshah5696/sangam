// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  announceCitationNavigation,
  CITATION_NAVIGATION_EVENT,
  CITATION_PARAM_KEYS,
  citationHref,
  citationLink,
  citationTargetFromData,
  citationTargetFromLocation,
  type CitationTarget,
} from './citationNavigation'
import { internalDocumentHref } from './internalLinks'

const documentId = '0d10bbdc-e3c8-4c2b-afdd-06e263ada380'
const everyField: CitationTarget = {
  documentId,
  revisionId: '8f2ac41d-9999-4a4b-8c8d-123456789abc',
  pageNumber: 3,
  annotationId: 'abc-123',
  textLocator: { exact: 'evidence', start: 12, end: 20, prefix: '', suffix: '', representation: 'source' },
  quoteStart: 4,
  quoteEnd: 9,
  passage: { line: 7, exact: 'claim' },
}

describe('citation link codec', () => {
  it('opens a pasted sangam:// link at the same target as an in-app citation link', () => {
    expect(internalDocumentHref(citationLink(everyField))).toBe(citationHref(everyField))
  })

  it('restores every encoded field when the citation URL is opened directly', () => {
    window.history.replaceState(null, '', citationHref(everyField))
    expect(citationTargetFromLocation(documentId)).toEqual(everyField)
  })

  it('names every parameter it writes, so closing a citation clears all of them', () => {
    const written = [...new URL(citationHref(everyField), 'https://sangam.test').searchParams.keys()]
    expect(new Set(written)).toEqual(new Set(CITATION_PARAM_KEYS))
  })
})

describe('citation navigation', () => {
  it('keeps the exact revision, PDF page, and annotation in the workspace URL', () => {
    const target = citationTargetFromData({
      document_id: 'doc-1',
      revision_id: 'rev-7',
      page_number: 4,
      annotation_id: 'annotation-9',
      title: 'Evidence',
    })
    expect(target).toEqual({
      documentId: 'doc-1',
      revisionId: 'rev-7',
      pageNumber: 4,
      annotationId: 'annotation-9',
      title: 'Evidence',
    })
    expect(citationHref(target!)).toBe('/documents/doc-1?revision=rev-7&page=4&annotation=annotation-9')
  })

  it('restores citation evidence from a directly opened URL and announces same-document updates', () => {
    window.history.replaceState({}, '', '/documents/doc-1?revision=rev-2&page=3')
    expect(citationTargetFromLocation('doc-1')).toMatchObject({
      documentId: 'doc-1',
      revisionId: 'rev-2',
      pageNumber: 3,
    })
    const listener = vi.fn()
    window.addEventListener(CITATION_NAVIGATION_EVENT, listener)
    announceCitationNavigation({ documentId: 'doc-1', revisionId: 'rev-2' })
    expect(listener).toHaveBeenCalledOnce()
    window.removeEventListener(CITATION_NAVIGATION_EVENT, listener)
  })

  it('rejects malformed page numbers and missing document identifiers', () => {
    expect(citationTargetFromData({ revision_id: 'rev-1' })).toBeNull()
    expect(citationTargetFromData({ document_id: 'doc-1', page_number: '-4' })?.pageNumber).toBeUndefined()
  })
})
