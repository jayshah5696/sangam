// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshReviewQueries, ReviewInbox, reviewableProposals } from './review'

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
  useNavigate: () => vi.fn(),
}))
vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: [], isLoading: false, isError: false }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))
vi.mock('./api', () => ({ api: {} }))

afterEach(cleanup)

describe('review inbox', () => {
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
})
