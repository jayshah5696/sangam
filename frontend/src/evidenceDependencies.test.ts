import { describe, expect, it } from 'vitest'
import type { EvidenceItem } from './evidenceCitation'
import {
  analyzePassageRecheck,
  checkSourceChanged,
  extractDraftCitations,
  findSourceDependencies,
  shortRevision,
} from './evidenceDependencies'

describe('evidenceDependencies', () => {
  it('extracts Markdown citations and associated claims and quotes', () => {
    const markdown = `# Draft Document

Recent trials confirmed the solar output improvement.

> Recent trials showed that output improved by 14% across cycles.
> 
> Claim: Efficiency increases across high temperature cycles

[Source: Solar Benchmark](sangam://document/doc-solar?revision=rev-100)

Next section continues here.
`

    const citations = extractDraftCitations(markdown, 'draft-1')
    expect(citations).toHaveLength(1)
    expect(citations[0]!.sourceDocumentId).toBe('doc-solar')
    expect(citations[0]!.pinnedRevisionId).toBe('rev-100')
    expect(citations[0]!.sourceTitle).toBe('Solar Benchmark')
    expect(citations[0]!.claim).toBe('Efficiency increases across high temperature cycles')
    expect(citations[0]!.selectedText).toBe(
      'Recent trials showed that output improved by 14% across cycles.',
    )
  })

  it('formats short revision strings cleanly', () => {
    expect(shortRevision(undefined)).toBe('unknown')
    expect(shortRevision('rev-abcdef1234567890')).toBe('rev-abcd')
    expect(shortRevision('12345678')).toBe('12345678')
  })

  it('detects source revision updates and superseded PDFs', () => {
    // Markdown revision change
    const revCheck = checkSourceChanged(
      { current_revision_id: 'rev-200' },
      'rev-100',
    )
    expect(revCheck.changed).toBe(true)
    expect(revCheck.reason).toContain('updated from revision')

    // Same revision
    const sameCheck = checkSourceChanged(
      { current_revision_id: 'rev-100' },
      'rev-100',
    )
    expect(sameCheck.changed).toBe(false)

    // Superseded PDF
    const pdfCheck = checkSourceChanged(
      {
        content_type: 'application/pdf',
        superseded_by_document_id: 'pdf-new',
        superseded_by_title: 'Solar Benchmark v2',
      },
      null,
    )
    expect(pdfCheck.changed).toBe(true)
    expect(pdfCheck.reason).toContain('superseded by "Solar Benchmark v2"')
  })

  it('analyzes passage changes in the head revision', () => {
    const oldText = 'Output improved by 14%.'
    const headIdentical = '# Results\n\nOutput improved by 14%. Across all temperature tests.'
    const analysisIdentical = analyzePassageRecheck(oldText, headIdentical)
    expect(analysisIdentical.status).toBe('identical')
    expect(analysisIdentical.summary).toContain('verbatim')

    const headModified = '# Results\n\nOutput improved by 12% across temperature tests.'
    const analysisModified = analyzePassageRecheck('Output improved by 14% across temperature tests.', headModified)
    expect(analysisModified.status).toBe('modified')

    const headRemoved = '# Results\n\nCompletely rewritten conclusions with no mention.'
    const analysisRemoved = analyzePassageRecheck('Output improved by 14%.', headRemoved)
    expect(analysisRemoved.status).toBe('removed')
  })

  it('answers "which conclusions in this project depend on this paper"', () => {
    const evidenceItems: EvidenceItem[] = [
      {
        id: 'ev-1',
        sourceDocumentId: 'doc-solar',
        sourceTitle: 'Solar Study',
        sourceContentType: 'text/markdown',
        pinnedRevisionId: 'rev-1',
        selectedText: 'Efficiency grew by 14%.',
        claim: 'Photovoltaic cells exceed target efficiency',
        claimTarget: {
          documentId: 'draft-synthesis',
          anchor: 10,
          head: 50,
        },
        createdAt: '2026-10-04T00:00:00Z',
      },
    ]

    const drafts = [
      {
        document_id: 'draft-synthesis',
        title: 'Synthesis Draft',
        content: '# Synthesis\n\n> Output stable.\n> Claim: Heat tolerance maintained\n[Source: Solar Study](sangam://document/doc-solar?revision=rev-1)',
      },
    ]

    const deps = findSourceDependencies({
      sourceDocumentId: 'doc-solar',
      sourceTitle: 'Solar Study',
      sourceCurrentRevisionId: 'rev-2',
      evidenceItems,
      drafts,
    })

    expect(deps).toHaveLength(2)
    expect(deps[0]!.claim).toBe('Photovoltaic cells exceed target efficiency')
    expect(deps[0]!.needsRechecking).toBe(true)
    expect(deps[0]!.recheckReason).toContain('updated from revision')

    expect(deps[1]!.claim).toBe('Heat tolerance maintained')
    expect(deps[1]!.needsRechecking).toBe(true)
  })
})
