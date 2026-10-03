// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Document, type DocumentComment } from '../../api'
import { CITATION_NAVIGATION_EVENT } from '../../citationNavigation'
import { DocumentCommentsRail } from './DocumentCommentsRail'

const mockDocument: Document = {
  document_id: 'doc-1',
  title: 'Test Document',
  content_type: 'text/markdown',
  path: 'test.md',
  current_revision_id: 'rev-2',
  content: '# Test Document\n\nThis is the current text for testing anchored comments.',
  content_hash: 'hash123',
  size_bytes: 100,
  materialization_state: 'none',
  file_hash: null,
  deleted: false,
  created_by: 'user-1',
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
  updated_by: 'user-1',
  updated_by_name: 'User 1',
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

const mockComments: DocumentComment[] = [
  {
    comment_id: 'comm-1',
    document_id: 'doc-1',
    revision_id: 'rev-2',
    exact: 'current text',
    prefix: 'is the ',
    suffix: ' for testing',
    start: 25,
    end: 37,
    body: 'Please verify this phrasing.',
    resolved_at: null,
    created_by: 'reviewer',
    created_at: '2026-03-01T01:00:00Z',
    version: 1,
  },
  {
    comment_id: 'comm-2',
    document_id: 'doc-1',
    revision_id: 'rev-1',
    exact: 'obsolete old phrase',
    prefix: 'pre ',
    suffix: ' post',
    start: 10,
    end: 29,
    body: 'This comment was on an edited out section.',
    resolved_at: null,
    created_by: 'reviewer',
    created_at: '2026-03-01T01:05:00Z',
    version: 1,
  },
  {
    comment_id: 'comm-3',
    document_id: 'doc-1',
    revision_id: 'rev-2',
    exact: 'Test Document',
    prefix: '# ',
    suffix: '\n\n',
    start: 2,
    end: 15,
    body: 'Good title.',
    resolved_at: '2026-03-01T02:00:00Z',
    created_by: 'editor',
    created_at: '2026-03-01T01:10:00Z',
    version: 2,
  },
]

describe('DocumentCommentsRail', () => {
  let queryClient: QueryClient

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
    vi.spyOn(api, 'listComments').mockResolvedValue(mockComments)
    const firstComment = mockComments[0]!
    vi.spyOn(api, 'resolveComment').mockResolvedValue({
      ...firstComment,
      resolved_at: '2026-03-01T03:00:00Z',
      version: 2,
    })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const renderComponent = (doc = mockDocument, content = mockDocument.content) =>
    render(
      <QueryClientProvider client={queryClient}>
        <DocumentCommentsRail document={doc} content={content} />
      </QueryClientProvider>,
    )

  it('renders open comments with anchored vs detached badges', async () => {
    renderComponent()

    await waitFor(() => {
      expect(screen.getByText('Please verify this phrasing.')).toBeTruthy()
    })
    expect(screen.getByText('This comment was on an edited out section.')).toBeTruthy()

    // comm-1 matches current content -> Anchored
    expect(screen.getByText('Anchored')).toBeTruthy()
    // comm-2 does not match current content -> Detached
    expect(screen.getByText(/Detached/)).toBeTruthy()
  })

  it('switches between filter tabs and shows resolved comments', async () => {
    renderComponent()

    await waitFor(() => {
      expect(screen.getByText('Resolved (1)')).toBeTruthy()
    })

    // Click Resolved tab
    fireEvent.click(screen.getByText('Resolved (1)'))

    expect(screen.getByText('Good title.')).toBeTruthy()
    expect(screen.queryByText('Please verify this phrasing.')).toBeNull()
    expect(screen.getByText(/Reopen/)).toBeTruthy()
  })

  it('resolves an open comment', async () => {
    renderComponent()

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Resolve/i }).length).toBeGreaterThan(0)
    })

    const resolveBtns = screen.getAllByRole('button', { name: /Resolve/i })
    const resolveBtn = resolveBtns[0]
    if (!resolveBtn) throw new Error('Resolve button not found')
    fireEvent.click(resolveBtn)

    await waitFor(() => {
      expect(api.resolveComment).toHaveBeenCalledWith('doc-1', 'comm-1', true, 1)
    })
  })

  it('dispatches citation navigation when clicking an anchored quote', async () => {
    const navListener = vi.fn()
    window.addEventListener(CITATION_NAVIGATION_EVENT, navListener)

    renderComponent()

    await waitFor(() => {
      expect(screen.getByText('current text')).toBeTruthy()
    })

    fireEvent.click(screen.getByText('current text'))

    expect(navListener).toHaveBeenCalled()
    // SAFETY: event listener receives CustomEvent instance for citation navigation
    const call = navListener.mock.calls[0]
    if (!call) throw new Error('Call not found')
    // SAFETY: Window custom navigation event receives CustomEvent payload
    const event = call[0] as CustomEvent
    expect(event.detail.documentId).toBe('doc-1')
    expect(event.detail.textLocator.exact).toBe('current text')

    window.removeEventListener(CITATION_NAVIGATION_EVENT, navListener)
  })
})
