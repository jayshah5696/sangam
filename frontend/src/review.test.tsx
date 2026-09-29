// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ChatProposal } from './api'
import { refreshReviewQueries, ReviewInbox, reviewableProposals } from './review'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
  useNavigate: () => mockNavigate,
}))

const mockInvalidateQueries = vi.fn(async () => undefined)
const stubProposal: ChatProposal = {
  proposal_id: 'stub',
  document_id: 'doc-1',
  thread_id: 'thread-1',
  expected_revision_id: 'rev-1',
  applied_revision_id: null,
  content: '',
  summary: '',
  rationale: null,
  judgment_needed: null,
  citations: [],
  sources_retrieved: [],
  status: 'applied',
  evidence_status: 'not_recorded',
  evidence: null,
  created_at: '',
  applied_at: null,
}
const mockApplyChatProposal = vi.fn().mockResolvedValue(stubProposal)
const mockDismissChatProposal = vi.fn().mockResolvedValue(stubProposal)

let testProposals: ChatProposal[] = []
const testDocument = {
  document_id: 'doc-1',
  current_revision_id: 'rev-1',
  title: 'Architecture Overview',
  content: 'Original document content',
  content_type: 'text/markdown',
}

vi.mock('@tanstack/react-query', () => ({
  useQuery: ({ queryKey }: { queryKey: readonly unknown[] }) => {
    if (queryKey[0] === 'chat-proposals') {
      return { data: testProposals, isLoading: false, isError: false }
    }
    if (queryKey[0] === 'documents') {
      return { data: [testDocument], isLoading: false, isError: false }
    }
    if (queryKey[0] === 'document' && queryKey[2] === 'review') {
      return { data: testDocument, isLoading: false, isError: false }
    }
    if (queryKey[0] === 'document' && queryKey[2] === 'history') {
      return {
        data: [{ revision_id: 'rev-1', content: 'Original document content' }],
        isLoading: false,
        isError: false,
      }
    }
    return { data: null, isLoading: false, isError: false }
  },
  useMutation: ({
    mutationFn,
    onSuccess,
  }: {
    mutationFn: (...args: string[]) => Promise<ChatProposal>
    onSuccess?: () => void
  }) => ({
    mutate: async (...args: string[]) => {
      await mutationFn(...args)
      onSuccess?.()
    },
    mutateAsync: async (...args: string[]) => {
      const res = await mutationFn(...args)
      onSuccess?.()
      return res
    },
    isPending: false,
    isError: false,
  }),
  useQueryClient: () => ({
    invalidateQueries: mockInvalidateQueries,
  }),
}))

vi.mock('./workbench', () => ({
  useWorkbench: () => ({
    ensureDocumentOpen: vi.fn(),
  }),
}))

vi.mock('./components/RevisionMergeView', () => ({
  RevisionMergeView: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="merge-view">
      <span>Original: {original}</span>
      <span>Modified: {modified}</span>
    </div>
  ),
}))

vi.mock('./api', () => ({
  api: {
    listChatProposals: vi.fn(),
    listDocuments: vi.fn(),
    getDocument: vi.fn(),
    history: vi.fn(),
    applyChatProposal: (proposal: ChatProposal, content?: string) => mockApplyChatProposal(proposal, content),
    dismissChatProposal: (id: string, reason?: string) => mockDismissChatProposal(id, reason),
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('review inbox', () => {
  beforeEach(() => {
    testProposals = []
  })

  it('only exposes proposals that still need a decision', () => {
    expect(
      reviewableProposals([
        { status: 'pending' },
        { status: 'stale' },
        { status: 'applied' },
        { status: 'dismissed' },
      ]),
    ).toHaveLength(2)
  })

  it('gives an honest empty state when the workspace has no pending proposals', () => {
    render(<ReviewInbox />)
    expect(screen.getByText('Nothing needs review')).toBeTruthy()
  })

  it('refreshes proposal and document state after a failed apply', async () => {
    const invalidateQueries = vi.fn(async () => undefined)

    await refreshReviewQueries({ invalidateQueries }, 'document-1')

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['chat-proposals', 'workspace-review'] })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['documents'] })
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['document', 'document-1'] })
  })

  it('renders editorial two-pane questions: what changed, why, supporting citations, and retrieved sources', () => {
    testProposals = [
      {
        proposal_id: 'prop-12345678',
        document_id: 'doc-1',
        thread_id: 'thread-87654321',
        expected_revision_id: 'rev-1',
        content: 'Proposed paragraph with editorial updates.',
        summary: 'Clarify deployment section',
        rationale: 'The previous section lacked production container instructions.',
        judgment_needed: 'Confirm whether Docker or Podman is the preferred container runtime.',
        status: 'pending',
        applied_revision_id: null,
        created_at: new Date().toISOString(),
        applied_at: null,
        evidence: null,
        evidence_status: 'recorded',
        citations: [
          {
            document_id: 'doc-src-1',
            title: 'Production Guide',
            path: 'docs/production.md',
            snippet: 'Containers must be run in unprivileged user namespaces.',
            location: 'Section 4.1',
            page_number: null,
            annotation_id: null,
            revision_id: 'rev-src-1',
          },
        ],
        sources_retrieved: [
          {
            document_id: 'doc-src-2',
            title: 'Infrastructure RFC',
            path: 'rfcs/infra.md',
            page_number: null,
            revision_id: 'rev-src-2',
          },
        ],
      },
    ]

    render(<ReviewInbox />)

    // Check editorial answers
    expect(screen.getByText('What changed & why')).toBeTruthy()
    expect(screen.getByText('The previous section lacked production container instructions.')).toBeTruthy()
    expect(screen.getByText('Judgment needed')).toBeTruthy()
    expect(
      screen.getByText('Confirm whether Docker or Podman is the preferred container runtime.'),
    ).toBeTruthy()

    // Supporting passages
    expect(screen.getByText('Supporting passages')).toBeTruthy()
    expect(screen.getByText('Production Guide')).toBeTruthy()
    expect(screen.getByText('Containers must be run in unprivileged user namespaces.')).toBeTruthy()
    expect(screen.getByText(/Location: Section 4\.1/)).toBeTruthy()

    // Sources retrieved during turn
    expect(screen.getByText('Sources retrieved during turn')).toBeTruthy()
    expect(screen.getByText('Infrastructure RFC')).toBeTruthy()
  })

  it('allows editing proposed wording directly, toggling diff, resetting, and applying edited wording', async () => {
    testProposals = [
      {
        proposal_id: 'prop-edit-test',
        document_id: 'doc-1',
        thread_id: 'thread-1',
        expected_revision_id: 'rev-1',
        content: 'Draft by AI agent.',
        summary: 'Update draft wording',
        rationale: 'Fix draft',
        judgment_needed: null,
        status: 'pending',
        applied_revision_id: null,
        created_at: new Date().toISOString(),
        applied_at: null,
        evidence: null,
        evidence_status: 'not_recorded',
        citations: [],
        sources_retrieved: [],
      },
    ]

    render(<ReviewInbox />)

    // Initial state: diff view is shown
    expect(screen.getByTestId('merge-view')).toBeTruthy()
    expect(screen.queryByLabelText('Editable proposed wording')).toBeNull()

    // Toggle edit wording mode
    const editBtn = screen.getByRole('button', { name: /Edit wording/i })
    fireEvent.click(editBtn)

    // SAFETY: textarea retrieved by label is an HTMLTextAreaElement
    const textarea = screen.getByLabelText('Editable proposed wording') as HTMLTextAreaElement
    expect(textarea.value).toBe('Draft by AI agent.')

    // Edit content
    fireEvent.change(textarea, { target: { value: 'Refined by human reviewer.' } })

    // "Edited" badge and "Reset to proposal" button should now be visible
    expect(screen.getByText('Edited')).toBeTruthy()
    const resetBtn = screen.getByRole('button', { name: /Reset to proposal/i })
    expect(resetBtn).toBeTruthy()

    // Apply button text reflects that edited change will be applied
    const applyBtn = screen.getByRole('button', { name: /Apply edited change/i })
    expect(applyBtn).toBeTruthy()

    // Reset back to original proposal
    fireEvent.click(resetBtn)
    expect(textarea.value).toBe('Draft by AI agent.')
    expect(screen.queryByText('Edited')).toBeNull()

    // Edit again and apply
    fireEvent.change(textarea, { target: { value: 'Refined by human reviewer final.' } })
    fireEvent.click(screen.getByRole('button', { name: /Apply edited change/i }))

    await waitFor(() => {
      expect(mockApplyChatProposal).toHaveBeenCalledWith(
        expect.objectContaining({ proposal_id: 'prop-edit-test' }),
        'Refined by human reviewer final.',
      )
    })
  })

  it('hands off exact proposal context without dismissing before the reviewer sends', async () => {
    testProposals = [
      {
        proposal_id: 'prop-revision-test',
        document_id: 'doc-1',
        thread_id: 'thread-999',
        expected_revision_id: 'rev-1',
        content: 'Proposed text',
        summary: 'Proposed edit',
        rationale: 'Initial attempt',
        judgment_needed: null,
        status: 'pending',
        applied_revision_id: null,
        created_at: new Date().toISOString(),
        applied_at: null,
        evidence: null,
        evidence_status: 'not_recorded',
        citations: [],
        sources_retrieved: [],
      },
    ]

    render(<ReviewInbox />)

    // Click "Request a revision" button
    const requestRevBtn = screen.getByRole('button', { name: /Request a revision/i })
    fireEvent.click(requestRevBtn)

    // Revision input prompt appears
    const input = screen.getByPlaceholderText(/e\.g\. Tighten the second paragraph/i)
    fireEvent.change(input, { target: { value: 'Please add benchmarks to the performance section' } })

    const sendBtn = screen.getByRole('button', { name: /Prepare revision request in chat/i })
    fireEvent.click(sendBtn)

    await waitFor(() => {
      expect(mockDismissChatProposal).not.toHaveBeenCalled()
      expect(mockNavigate).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '/chat',
          search: {
            document: 'doc-1',
            thread: 'thread-999',
            proposal: 'prop-revision-test',
            prompt: expect.stringContaining('Please add benchmarks to the performance section'),
            returnTo: '/documents/doc-1',
          },
        }),
      )
      expect(mockNavigate.mock.calls[0]?.[0].search.prompt).toContain('rev-1')
      expect(mockNavigate.mock.calls[0]?.[0].search.prompt).toContain('prop-revision-test')
      expect(mockNavigate.mock.calls[0]?.[0].state.sangamChatInitialPrompt).toContain('Proposed text')
    })
  })

  it('displays clear message when source document is unavailable or deleted', () => {
    testProposals = [
      {
        proposal_id: 'prop-deleted-source',
        document_id: 'doc-1',
        thread_id: 'thread-1',
        expected_revision_id: 'rev-1',
        content: 'Proposed content',
        summary: 'Proposal with deleted source',
        rationale: 'Testing unavailable evidence',
        judgment_needed: null,
        status: 'pending',
        applied_revision_id: null,
        created_at: new Date().toISOString(),
        applied_at: null,
        evidence: null,
        evidence_status: 'unavailable',
        citations: [],
        sources_retrieved: [],
      },
    ]

    render(<ReviewInbox />)

    expect(screen.getByText('Source document deleted or inaccessible.')).toBeTruthy()
  })
})
