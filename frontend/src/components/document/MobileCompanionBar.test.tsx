// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileCompanionBar } from './DocumentWorkspace'
import type { Document } from '../../api'
import type { LayoutNode } from '../../workbench'

const mockNavigate = vi.fn()
const mockSetActiveGroup = vi.fn()
const mockActivateTab = vi.fn()

interface TestWorkbenchState {
  root: LayoutNode
}

const workbenchState: TestWorkbenchState = {
  root: {
    kind: 'split',
    id: 'split-1',
    direction: 'horizontal',
    ratio: 50,
    first: {
      kind: 'group',
      id: 'group-1',
      activeTabId: 'doc-draft',
      tabs: [{ documentId: 'doc-draft', title: 'Draft Doc', pinned: false }],
    },
    second: {
      kind: 'group',
      id: 'group-2',
      activeTabId: 'doc-source',
      tabs: [{ documentId: 'doc-source', title: 'Source Paper', pinned: false }],
    },
  },
}

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  useSearch: () => ({ project: 'proj-1' }),
}))

vi.mock('../../workbench', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workbench')>()
  return {
    ...actual,
    useWorkbench: () => ({
      root: workbenchState.root,
      activeGroupId: 'group-1',
      setActiveGroup: mockSetActiveGroup,
      activateTab: mockActivateTab,
    }),
  }
})

vi.mock('../../api', () => ({
  api: {
    getDocument: vi.fn(async (id: string) => ({
      document_id: id,
      title: id === 'doc-source' ? 'Source Paper' : 'Draft Doc',
      content_type: id === 'doc-source' ? 'application/pdf' : 'text/markdown',
      path: id === 'doc-source' ? 'sources/paper.pdf' : 'drafts/memo.md',
    })),
    getProject: vi.fn(async () => ({
      project_id: 'proj-1',
      name: 'Test Project',
      documents: [],
    })),
  },
}))

const draftDoc: Document = {
  document_id: 'doc-draft',
  title: 'Draft Doc',
  content_type: 'text/markdown',
  path: 'drafts/memo.md',
  current_revision_id: 'rev-1',
  content: '# Draft content',
  content_hash: 'hash-1',
  size_bytes: 15,
  materialization_state: 'clean',
  file_hash: null,
  deleted: false,
  created_by: 'user-1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  updated_by: 'user-1',
  updated_by_name: 'User One',
  revision_summary: null,
  category: null,
  metadata_version: 1,
  trust_level: 'untrusted',
  trust_version: 1,
  tags: [],
  pdf_page_count: null,
  pdf_extraction_status: null,
  pdf_extraction_error: null,
  supersedes_document_id: null,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('MobileCompanionBar (Issue 312)', () => {
  it('renders switch to source companion when viewing a draft with connected source in workbench', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    render(
      <QueryClientProvider client={queryClient}>
        <MobileCompanionBar currentDocument={draftDoc} />
      </QueryClientProvider>,
    )

    const companionButton = await screen.findByRole('button', {
      name: /switch to connected source/i,
    })
    expect(companionButton).toBeDefined()
    expect(screen.getByText('Switch to source:')).toBeDefined()
    expect(screen.getByText('Source Paper')).toBeDefined()

    fireEvent.click(companionButton)
    expect(mockSetActiveGroup).toHaveBeenCalledWith('group-2')
    expect(mockNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to: '/documents/$documentId',
        params: { documentId: 'doc-source' },
      }),
    )
  })

  it('renders nothing when no companion is open or connected', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

    const singleGroupRoot: LayoutNode = {
      kind: 'group',
      id: 'group-1',
      activeTabId: 'doc-draft',
      tabs: [{ documentId: 'doc-draft', title: 'Draft Doc', pinned: false }],
    }

    const previousRoot = workbenchState.root
    workbenchState.root = singleGroupRoot

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <MobileCompanionBar currentDocument={draftDoc} />
      </QueryClientProvider>,
    )

    expect(container.querySelector('.mobile-companion-bar')).toBeNull()
    workbenchState.root = previousRoot
  })
})
