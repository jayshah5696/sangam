import { describe, expect, it } from 'vitest'
import type { DocumentSummary, Folder } from './api'
import type { FileTreeSortEntry } from '@pierre/trees'
import {
  buildModifiedSortComparator,
  buildWorkspaceTreeAdapter,
  ensureMarkdownExtension,
  joinWorkspacePath,
  parentWorkspacePath,
} from './workspaceTree'

const materializedDocument: DocumentSummary = {
  document_id: 'doc-1',
  title: 'Plan',
  content_type: 'text/markdown',
  path: 'projects/plan.md',
  current_revision_id: 'rev-1',
  content_hash: 'hash-1',
  size_bytes: 4,
  materialization_state: 'clean',
  file_hash: 'hash-1',
  deleted: false,
  created_by: 'human:jay',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  updated_by: 'human:jay',
  updated_by_name: 'Jay',
  revision_summary: null,
  category: null,
  metadata_version: 1,
  trust_level: 'untrusted',
  trust_version: 0,
  tags: [],
  pdf_page_count: null,
  pdf_extraction_status: null,
  pdf_extraction_error: null,
  supersedes_document_id: null,
}

const folder: Folder = {
  folder_id: 'folder-1',
  path: 'projects',
  name: 'projects',
  category: null,
  tags: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  document_count: 1,
  metadata_version: 1,
}

describe('Pierre workspace tree adapter', () => {
  it('keeps Pierre paths separate from stable Sangam document identity', () => {
    const adapter = buildWorkspaceTreeAdapter([materializedDocument], [folder])

    expect(adapter.paths).toEqual(['projects/', 'projects/plan.md'])
    expect(adapter.documentByTreePath.get('projects/plan.md')?.document_id).toBe('doc-1')
    expect(adapter.treePathByDocumentId.get('doc-1')).toBe('projects/plan.md')
    expect(adapter.folderByTreePath.get('projects')?.folder_id).toBe('folder-1')
  })

  it('places unmaterialized documents under a collision-safe virtual Drafts path', () => {
    const draft = { ...materializedDocument, document_id: 'draft-1', path: null, title: 'Notes/Ideas' }
    const duplicate = { ...draft, document_id: 'draft-2' }
    const realDraftsFolder = { ...folder, folder_id: 'folder-2', path: 'Drafts', name: 'Drafts' }
    const adapter = buildWorkspaceTreeAdapter([draft, duplicate], [realDraftsFolder])

    expect(adapter.draftsRootPath).toBe('Drafts (Sangam 2)')
    expect(adapter.treePathByDocumentId.get('draft-1')).toBe('Drafts (Sangam 2)/Notes／Ideas')
    expect(adapter.treePathByDocumentId.get('draft-2')).toBe('Drafts (Sangam 2)/Notes／Ideas (2)')
  })

  it('retains workspace path helpers at the API boundary', () => {
    expect(joinWorkspacePath('/projects/', '/notes.md')).toBe('projects/notes.md')
    expect(parentWorkspacePath('projects/research/notes.md')).toBe('projects/research')
    expect(ensureMarkdownExtension('notes')).toBe('notes.md')
    expect(ensureMarkdownExtension('notes.MD')).toBe('notes.MD')
  })
})

describe('buildModifiedSortComparator', () => {
  const entry = (overrides: Partial<FileTreeSortEntry>): FileTreeSortEntry => ({
    basename: overrides.basename ?? overrides.path?.split('/').pop() ?? '',
    depth: overrides.depth ?? 0,
    isDirectory: overrides.isDirectory ?? false,
    path: overrides.path ?? '',
    segments: overrides.segments ?? overrides.path?.split('/') ?? [],
  })

  it('sorts documents newest first', () => {
    const timestamps = new Map([
      ['alpha.md', '2026-01-01T00:00:00Z'],
      ['zebra.md', '2026-06-15T00:00:00Z'],
    ])
    const compare = buildModifiedSortComparator(timestamps)
    const a = entry({ path: 'alpha.md', basename: 'alpha.md' })
    const b = entry({ path: 'zebra.md', basename: 'zebra.md' })
    expect(compare(a, b)).toBeGreaterThan(0)
    expect(compare(b, a)).toBeLessThan(0)
  })

  it('places directories before documents', () => {
    const timestamps = new Map([['docs/note.md', '2026-01-01T00:00:00Z']])
    const compare = buildModifiedSortComparator(timestamps)
    const dir = entry({ path: 'docs', basename: 'docs', isDirectory: true })
    const file = entry({ path: 'readme.md', basename: 'readme.md' })
    expect(compare(dir, file)).toBeLessThan(0)
    expect(compare(file, dir)).toBeGreaterThan(0)
  })

  it('sorts directories by their newest descendant', () => {
    const timestamps = new Map([
      ['old-project/doc.md', '2026-01-01T00:00:00Z'],
      ['new-project/doc.md', '2026-08-01T00:00:00Z'],
    ])
    const compare = buildModifiedSortComparator(timestamps)
    const oldDir = entry({ path: 'old-project', basename: 'old-project', isDirectory: true })
    const newDir = entry({ path: 'new-project', basename: 'new-project', isDirectory: true })
    expect(compare(oldDir, newDir)).toBeGreaterThan(0)
    expect(compare(newDir, oldDir)).toBeLessThan(0)
  })

  it('uses name as tie-breaker when timestamps are equal', () => {
    const ts = '2026-06-01T00:00:00Z'
    const timestamps = new Map([
      ['alpha.md', ts],
      ['beta.md', ts],
    ])
    const compare = buildModifiedSortComparator(timestamps)
    const a = entry({ path: 'alpha.md', basename: 'alpha.md' })
    const b = entry({ path: 'beta.md', basename: 'beta.md' })
    expect(compare(a, b)).toBeLessThan(0)
    expect(compare(b, a)).toBeGreaterThan(0)
  })

  it('handles documents with no timestamp gracefully', () => {
    const timestamps = new Map([['known.md', '2026-06-01T00:00:00Z']])
    const compare = buildModifiedSortComparator(timestamps)
    const known = entry({ path: 'known.md', basename: 'known.md' })
    const unknown = entry({ path: 'unknown.md', basename: 'unknown.md' })
    expect(compare(unknown, known)).toBeGreaterThan(0)
  })
})
