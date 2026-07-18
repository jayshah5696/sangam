// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocumentSummary, Folder } from '../api'
import { FileExplorerPanel } from './FileExplorer'

const state = vi.hoisted(() => {
  const item = {
    deselect: vi.fn(),
    focus: vi.fn(),
    isSelected: vi.fn(() => false),
    select: vi.fn(),
  }
  return {
    documents: [] as DocumentSummary[],
    folders: [] as Folder[],
    mutationOptions: [] as Array<{ onSuccess?: (value: DocumentSummary) => Promise<void> }>,
    decorations: [] as Array<{ text: string; title?: string } | null>,
    item,
    model: {
      getFocusedPath: vi.fn(() => null),
      getItem: vi.fn(() => item),
      getSelectedPaths: vi.fn((): string[] => []),
      resetPaths: vi.fn(),
      scrollToPath: vi.fn(),
      startRenaming: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    },
  }
})

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: { onSuccess?: (value: DocumentSummary) => Promise<void> }) => {
    state.mutationOptions.push(options)
    return { isPending: false, mutate: vi.fn() }
  },
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === 'documents' ? state.documents : state.folders,
    isError: false,
    isLoading: false,
  }),
  useQueryClient: () => ({
    cancelQueries: vi.fn(),
    getQueryData: vi.fn(),
    invalidateQueries: vi.fn(async () => undefined),
    setQueryData: vi.fn(),
  }),
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(async () => undefined) }))

vi.mock('@pierre/trees/react', () => ({
  FileTree: () => <div data-testid="pierre-tree" />,
  useFileTree: (options: {
    renderRowDecoration: (context: {
      item: { kind: 'directory'; name: string; path: string }
      row: Record<string, never>
    }) => { text: string; title?: string } | null
  }) => {
    state.decorations.push(
      options.renderRowDecoration({
        item: { kind: 'directory', name: 'projects', path: 'projects' },
        row: {},
      }),
    )
    return { model: state.model }
  },
}))

vi.mock('../workbench', () => ({
  findGroup: () => ({ activeTabId: 'draft-1' }),
  useWorkbench: () => ({
    activeGroupId: 'group-1',
    ensureDocumentOpen: vi.fn(),
    root: {},
    splitGroup: vi.fn(),
  }),
}))

vi.mock('../splitPolicy', () => ({ preferredSplitDirection: () => 'horizontal' }))

vi.mock('../api', () => ({
  api: {
    createDocument: vi.fn(),
    createFolder: vi.fn(),
    deleteDocument: vi.fn(),
    duplicateDocument: vi.fn(),
    getDocument: vi.fn(),
    listDocuments: vi.fn(),
    listFolders: vi.fn(),
    moveDocument: vi.fn(),
    updateDocument: vi.fn(),
  },
}))

const document: DocumentSummary = {
  document_id: 'draft-1',
  title: 'Old title',
  content_type: 'text/markdown',
  path: null,
  current_revision_id: 'rev-1',
  content_hash: 'hash-1',
  size_bytes: 4,
  materialization_state: 'none',
  file_hash: null,
  deleted: false,
  created_by: 'human:jay',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  updated_by: 'human:jay',
  updated_by_name: 'Jay',
  revision_summary: null,
  category: null,
  metadata_version: 1,
  tags: [],
}

const folder: Folder = {
  folder_id: 'folder-1',
  path: 'projects',
  name: 'projects',
  category: null,
  tags: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  document_count: 3,
  metadata_version: 1,
}

beforeEach(() => {
  state.documents = []
  state.folders = []
  state.mutationOptions = []
  state.decorations = []
  vi.clearAllMocks()
})

afterEach(cleanup)

describe('FileExplorerPanel', () => {
  it('provides row decorations during the first Pierre render', () => {
    state.folders = [folder]

    render(<FileExplorerPanel onSearch={vi.fn()} />)

    expect(state.decorations[0]).toEqual({ text: '3', title: '3 documents' })
  })

  it('restores selection and keyboard focus by document ID after a draft rename', async () => {
    state.documents = [document]
    const view = render(<FileExplorerPanel onSearch={vi.fn()} />)
    const rename = state.mutationOptions[1]

    await act(async () => {
      await rename?.onSuccess?.({ ...document, title: 'New title' })
    })
    state.documents = [{ ...document, title: 'New title' }]
    vi.clearAllMocks()

    view.rerender(<FileExplorerPanel onSearch={vi.fn()} />)

    expect(state.model.getItem).toHaveBeenCalledWith('Drafts/New title')
    expect(state.item.select).toHaveBeenCalled()
    expect(state.item.focus).toHaveBeenCalled()
    expect(state.model.scrollToPath).toHaveBeenCalledWith('Drafts/New title', {
      focus: false,
      offset: 'nearest',
    })
  })
})
