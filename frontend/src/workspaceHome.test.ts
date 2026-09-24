import { describe, expect, it } from 'vitest'
import { selectHomeDocuments } from './workspaceHome'

describe('workspace home document sections', () => {
  it('keeps pinned tabs first and uses the saved open order for recent work', () => {
    const documents = [
      { document_id: 'doc-a', title: 'A', path: null },
      { document_id: 'doc-b', title: 'B', path: 'b.md' },
      { document_id: 'doc-c', title: 'C', path: 'c.md' },
    ]
    const layout = [
      { documentId: 'doc-a', title: 'A', pinned: false },
      { documentId: 'doc-c', title: 'C', pinned: true },
      { documentId: 'doc-b', title: 'B', pinned: false },
    ]

    expect(selectHomeDocuments(documents, layout)).toEqual({
      pinned: [documents[2]],
      recent: [documents[0], documents[1]],
    })
  })

  it('does not show stale tabs or duplicate documents', () => {
    const documents = [{ document_id: 'doc-a', title: 'A', path: null }]
    expect(
      selectHomeDocuments(documents, [
        { documentId: 'missing', title: 'Missing', pinned: true },
        { documentId: 'doc-a', title: 'A', pinned: false },
        { documentId: 'doc-a', title: 'A', pinned: false },
      ]),
    ).toEqual({ pinned: [], recent: [documents[0]] })
  })
})
