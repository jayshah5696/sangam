import { describe, expect, it } from 'vitest'
import { internalDocumentHref, internalDocumentMarkdown } from './internalLinks'

describe('stable document links', () => {
  it('maps Sangam document links to file-based document routes', () => {
    expect(internalDocumentHref('sangam://document/123e4567-e89b-12d3-a456-426614174000'))
      .toBe('/documents/123e4567-e89b-12d3-a456-426614174000')
    expect(internalDocumentHref('javascript:alert(1)')).toBeNull()
  })

  it('uses the path as the human-readable label without making it the identity', () => {
    expect(internalDocumentMarkdown({
      document_id: 'stable-id',
      title: 'A note',
      path: 'projects/a-note.md',
    })).toBe('[projects/a-note.md](sangam://document/stable-id)')
  })
})
