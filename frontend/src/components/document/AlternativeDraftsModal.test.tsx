// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type Document } from '../../api'
import { alternativeDraftsStore } from '../../alternativeDrafts'
import { AlternativeDraftsModal } from './AlternativeDraftsModal'

vi.mock('../RevisionMergeView', () => ({
  RevisionMergeView: () => <div data-testid="mock-revision-merge-view">Diff View</div>,
}))

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  invalidateQueries: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => state.navigate,
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: state.invalidateQueries,
  }),
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    if (options.queryKey[0] === 'document' && options.enabled !== false) {
      return {
        data: {
          document_id: options.queryKey[1],
          title: 'Candidate Doc',
          current_revision_id: 'rev-candidate-head',
          content: '# Candidate content\n\nAlternative findings.',
        },
        isLoading: false,
      }
    }
    return { data: null, isLoading: false }
  },
}))

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  clear() {
    this.data.clear()
  }
}

describe('AlternativeDraftsModal', () => {
  const mockParentDoc: Document = {
    document_id: 'doc-parent',
    title: 'Original Argument',
    content_type: 'text/markdown',
    path: 'original.md',
    current_revision_id: 'rev-parent-head',
    content: '# Original argument\n\nCurrent conclusions.',
    content_hash: 'hash-parent',
    size_bytes: 50,
    materialization_state: 'clean',
    created_at: '2026-10-06T10:00:00Z',
    updated_at: '2026-10-06T10:00:00Z',
    file_hash: null,
    deleted: false,
    created_by: 'user-1',
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
  }

  beforeEach(async () => {
    Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name: string, callback: () => void) => callback() },
    })
    await alternativeDraftsStore.clear()
    state.navigate.mockReset()
    state.invalidateQueries.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders lead copy and empty candidates message', () => {
    render(<AlternativeDraftsModal document={mockParentDoc} open={true} onClose={vi.fn()} />)

    expect(screen.getByText('Explore Alternative Conclusions')).toBeTruthy()
    expect(screen.getByText(/Branch into a separate candidate draft/i)).toBeTruthy()
    expect(screen.getByText('No alternative candidates created yet.')).toBeTruthy()
  })

  it('creates an alternative candidate and registers it', async () => {
    const createDocSpy = vi.spyOn(api, 'createDocument').mockResolvedValue({
      ...mockParentDoc,
      document_id: 'doc-candidate-new',
      title: 'Original Argument (Exploring quant models)',
    })

    render(<AlternativeDraftsModal document={mockParentDoc} open={true} onClose={vi.fn()} />)

    const input = screen.getByPlaceholderText(/Hypothesis or focus/i)
    fireEvent.change(input, { target: { value: 'Exploring quant models' } })

    const createBtn = screen.getByRole('button', { name: 'Create candidate draft' })
    fireEvent.click(createBtn)

    await waitFor(() => {
      expect(createDocSpy).toHaveBeenCalledWith(
        'Original Argument (Exploring quant models)',
        undefined,
        'text/markdown',
        mockParentDoc.content,
      )
    })

    expect(screen.getByText('Original Argument (Exploring quant models)')).toBeTruthy()
    expect(screen.getByText('Exploring quant models')).toBeTruthy()
  })

  it('toggles diff comparison and applies candidate changes back to original draft', async () => {
    await alternativeDraftsStore.registerCandidate({
      parentDocumentId: mockParentDoc.document_id,
      candidateDocumentId: 'doc-candidate-existing',
      baseRevisionId: mockParentDoc.current_revision_id,
      title: 'Original Argument (Alternative)',
      conclusionNote: 'Test note',
    })

    const updateDocSpy = vi.spyOn(api, 'updateDocument').mockResolvedValue({
      ...mockParentDoc,
      current_revision_id: 'rev-updated-parent',
      content: '# Candidate content\n\nAlternative findings.',
    })

    const onDocumentUpdated = vi.fn()

    render(
      <AlternativeDraftsModal
        document={mockParentDoc}
        open={true}
        onClose={vi.fn()}
        onDocumentUpdated={onDocumentUpdated}
      />,
    )

    expect(screen.getByText('Original Argument (Alternative)')).toBeTruthy()

    // Toggle comparison
    const compareBtn = screen.getByRole('button', { name: 'Compare assumptions and arguments' })
    fireEvent.click(compareBtn)

    await waitFor(() => {
      expect(screen.getByTestId('mock-revision-merge-view')).toBeTruthy()
    })

    // Bring changes to original
    const applyBtn = screen.getByRole('button', { name: 'Bring selected changes back to original' })
    fireEvent.click(applyBtn)

    await waitFor(() => {
      expect(updateDocSpy).toHaveBeenCalledWith(mockParentDoc, '# Candidate content\n\nAlternative findings.')
      expect(onDocumentUpdated).toHaveBeenCalled()
    })
  })
})
