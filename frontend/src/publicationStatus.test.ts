import { describe, expect, it } from 'vitest'
import type { Publication } from './api'
import { publicationStatus } from './publicationStatus'

const publication: Publication = {
  publication_id: 'pub-1',
  document_id: 'doc-1',
  document_title: 'Notes',
  document_path: 'notes.md',
  slug: 'notes',
  access_policy: 'public',
  version: 2,
  active: true,
  has_active_token: false,
  created_by: 'human:jay',
  updated_by: 'human:jay',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  url: 'https://example.test/p/notes',
  revision_id: 'rev-1',
  document_revision_id: 'rev-1',
}

describe('publicationStatus', () => {
  it('is private when nothing was ever published', () => {
    expect(publicationStatus(null, 'rev-1')).toEqual({ kind: 'private' })
  })

  it('is private again after unpublishing', () => {
    expect(publicationStatus({ ...publication, active: false }, 'rev-1')).toEqual({ kind: 'private' })
  })

  it('is current when readers see the saved draft', () => {
    expect(publicationStatus(publication, 'rev-1')).toEqual({ kind: 'current', publication })
  })

  it('reports unpublished changes against the saved head, not the server snapshot', () => {
    expect(publicationStatus(publication, 'rev-3')).toEqual({
      kind: 'behind',
      publication,
      publishedRevisionId: 'rev-1',
      draftRevisionId: 'rev-3',
    })
  })
})
