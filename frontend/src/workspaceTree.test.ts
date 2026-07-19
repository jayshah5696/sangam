import { describe, expect, it } from 'vitest'
import type { DocumentSummary, Folder } from './api'
import {
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
