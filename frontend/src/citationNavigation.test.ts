// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import {
  announceCitationNavigation,
  CITATION_NAVIGATION_EVENT,
  citationHref,
  citationTargetFromData,
  citationTargetFromLocation,
} from './citationNavigation'

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
