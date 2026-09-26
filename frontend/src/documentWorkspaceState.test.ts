import { describe, expect, it } from 'vitest'
import type { Document } from './api'
import { initialDocumentMode, materializePath, saveLabel } from './documentWorkspaceState'

const documentFixture = (overrides: Partial<Document> = {}): Document => ({
  document_id: 'document-1',
  title: 'Untitled document',
  content_type: 'text/markdown',
  path: null,
  current_revision_id: 'revision-1',
  content: '',
  content_hash: 'hash',
  size_bytes: 0,
  materialization_state: 'none',
  file_hash: null,
  deleted: false,
  created_by: 'user-1',
  created_at: '2026-09-21T12:00:00Z',
  updated_at: '2026-09-21T12:00:00Z',
  updated_by: 'user-1',
  updated_by_name: 'User One',
  revision_summary: null,
  tags: [],
  category: null,
  metadata_version: 1,
  trust_level: 'untrusted',
  trust_version: 1,
  pdf_page_count: null,
  pdf_extraction_status: null,
  pdf_extraction_error: null,
  supersedes_document_id: null,
  ...overrides,
})

describe('document workspace state', () => {
  it('opens an unmaterialized empty document in edit mode', () => {
    expect(initialDocumentMode(documentFixture(), 'preview')).toBe('edit')
  })

  it('keeps the remembered mode for existing documents', () => {
    expect(
      initialDocumentMode(documentFixture({ path: 'notes/brief.md', content: '# Existing' }), 'preview'),
    ).toBe('preview')
  })

  it('describes a draft as saved without implying it is a filesystem file', () => {
    expect(saveLabel('saved', false)).toBe('Saved draft')
    expect(saveLabel('saved', true)).toBe('Saved')
    expect(saveLabel('offline', false)).toBe('Offline · draft saved locally')
  })

  it('joins a selected folder and filename into a workspace path', () => {
    expect(materializePath('research', 'paper.md')).toBe('research/paper.md')
    expect(materializePath('', 'paper.md')).toBe('paper.md')
  })
})
