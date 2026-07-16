import { describe, expect, it } from 'vitest'
import type { Document, Folder } from './api'
import {
  adjacentVisibleNodeId,
  buildWorkspaceTree,
  ensureMarkdownExtension,
  flattenVisibleNodes,
  joinWorkspacePath,
  parentWorkspacePath,
  parentNodeId,
  typeaheadNodeId,
  workspaceBasename,
} from './workspaceTree'

const folder: Folder = {
  folder_id: 'folder-1',
  path: 'projects',
  name: 'projects',
  category: null,
  metadata_version: 1,
  tags: [],
  document_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const document = {
  document_id: 'doc-1',
  title: 'Alpha',
  path: 'projects/alpha.md',
} as Document

describe('workspace tree model', () => {
  it('builds and flattens the logical tree independently of the DOM', () => {
    const tree = buildWorkspaceTree([document], [folder])
    expect(tree[0]).toMatchObject({ type: 'folder', path: 'projects' })
    const visible = flattenVisibleNodes(tree, new Set(['projects']))
    expect(visible.map((node) => node.id)).toEqual(['folder:folder-1', 'document:doc-1'])
    expect(parentNodeId(tree, 'document:doc-1')).toBe('folder:folder-1')
    expect(adjacentVisibleNodeId(visible, 'folder:folder-1', 1)).toBe('document:doc-1')
    expect(typeaheadNodeId(visible, 'folder:folder-1', 'a')).toBe('document:doc-1')
  })

  it('normalizes workspace paths', () => {
    expect(joinWorkspacePath('/projects/', '/new.md')).toBe('projects/new.md')
    expect(parentWorkspacePath('/projects/nested/file.md/')).toBe('projects/nested')
    expect(parentWorkspacePath('file.md')).toBe('')
    expect(workspaceBasename('/projects/nested/file.md/')).toBe('file.md')
    expect(ensureMarkdownExtension(' release notes ')).toBe('release notes.md')
    expect(ensureMarkdownExtension('README.MD')).toBe('README.MD')
  })
})
