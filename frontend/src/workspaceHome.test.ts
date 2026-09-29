import { describe, expect, it } from 'vitest'
import type { Project, ProjectDocument } from './api'
import { categorizeProjectDocuments, getProjectResumeAction, selectHomeDocuments } from './workspaceHome'

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

  it('categorizes project documents into sources, notes, outputs, and drafts', () => {
    const docs: ProjectDocument[] = [
      {
        project_id: 'p1',
        document_id: 'd1',
        role: 'source',
        sort_order: 0,
        created_at: '2026-01-01',
        title: 'Source Paper',
        content_type: 'application/pdf',
        updated_at: '2026-01-01',
      },
      {
        project_id: 'p1',
        document_id: 'd2',
        role: 'note',
        sort_order: 1,
        created_at: '2026-01-01',
        title: 'Meeting Notes',
        content_type: 'text/markdown',
        updated_at: '2026-01-01',
      },
      {
        project_id: 'p1',
        document_id: 'd3',
        role: 'output',
        sort_order: 2,
        created_at: '2026-01-01',
        title: 'Summary Deck',
        content_type: 'text/markdown',
        updated_at: '2026-01-01',
      },
      {
        project_id: 'p1',
        document_id: 'd4',
        role: 'draft',
        sort_order: 3,
        created_at: '2026-01-01',
        title: 'Draft RFC',
        content_type: 'text/markdown',
        updated_at: '2026-01-01',
      },
    ]

    const result = categorizeProjectDocuments(docs)
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]?.title).toBe('Source Paper')
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]?.title).toBe('Meeting Notes')
    expect(result.outputs).toHaveLength(1)
    expect(result.outputs[0]?.title).toBe('Summary Deck')
    expect(result.drafts).toHaveLength(1)
    expect(result.drafts[0]?.title).toBe('Draft RFC')
  })

  it('determines project resume action prioritizing primary draft', () => {
    const project: Project = {
      project_id: 'p1',
      name: 'Alpha Launch',
      description: 'Prepare launch docs',
      primary_document_id: 'doc-prime',
      resume_hint: 'Finish Section 3',
      archived: false,
      metadata_version: 1,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      documents: [],
      primary_document: {
        project_id: 'p1',
        document_id: 'doc-prime',
        role: 'draft',
        sort_order: 0,
        created_at: '2026-01-01',
        title: 'Alpha Spec',
        content_type: 'text/markdown',
        updated_at: '2026-01-01',
        snippet: 'Specifications for alpha...',
      },
    }

    const action = getProjectResumeAction(project)
    expect(action).toEqual({
      documentId: 'doc-prime',
      title: 'Alpha Spec',
      actionLabel: 'Resume primary draft',
      hint: 'Finish Section 3',
      snippet: 'Specifications for alpha...',
    })
  })
})
