import { describe, expect, it } from 'vitest'
import { evidenceCitationMarkdown, itemToEvidenceReference, type EvidenceItem } from './evidenceCitation'

describe('evidenceCitationMarkdown', () => {
  it('formats markdown quote and link with pinned revision', () => {
    const citation = evidenceCitationMarkdown({
      documentId: 'doc-123',
      title: 'Context Scaling Analysis',
      revisionId: 'rev-456',
      selectedText: 'Rotary embeddings scale cleanly up to 32k tokens.',
    })

    expect(citation).toBe(
      '\n\n> Rotary embeddings scale cleanly up to 32k tokens.\n\n[Source: Context Scaling Analysis](sangam://document/doc-123?revision=rev-456)\n',
    )
  })

  it('formats citation with PDF page and annotation target', () => {
    const citation = evidenceCitationMarkdown({
      documentId: 'doc-pdf-1',
      title: 'Attention Is All You Need',
      pageNumber: 4,
      annotationId: 'annot-999',
      selectedText: 'Multi-head attention allows the model to jointly attend to information.',
      note: 'Key architecture definition.',
    })

    expect(citation).toBe(
      '\n\n> Multi-head attention allows the model to jointly attend to information.\n> \n> Key architecture definition.\n\n[Source: Attention Is All You Need p. 4](sangam://document/doc-pdf-1?page=4&annotation=annot-999)\n',
    )
  })

  it('formats citation with an attached claim', () => {
    const item: EvidenceItem = {
      id: 'ev-1',
      sourceDocumentId: 'doc-markdown-2',
      sourceTitle: 'System Benchmarks',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-789',
      selectedText: 'Throughput improved by 42% after batching pipeline stages.',
      claim: 'Pipelining improves throughput without increasing tail latency.',
      claimClassification: 'Supports',
      createdAt: '2026-03-30T10:00:00.000Z',
    }

    const citation = evidenceCitationMarkdown(itemToEvidenceReference(item))
    expect(citation).toBe(
      '\n\n> Throughput improved by 42% after batching pipeline stages.\n> \n> Claim [Supports]: Pipelining improves throughput without increasing tail latency.\n\n[Source: System Benchmarks](sangam://document/doc-markdown-2?revision=rev-789)\n',
    )
  })
})
