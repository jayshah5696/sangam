import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, collectPages, type ChatProposal } from './api'

afterEach(() => vi.restoreAllMocks())

describe('collectPages', () => {
  it('collects bounded pages and advances by the requested page size', async () => {
    const offsets: number[] = []
    const values = await collectPages(
      async (offset, limit) => {
        offsets.push(offset)
        return offset === 0 ? Array.from({ length: limit }, (_, index) => index) : [2]
      },
      2,
      3,
    )

    expect(values).toEqual([0, 1, 2])
    expect(offsets).toEqual([0, 2])
  })

  it('fails closed when every page is unexpectedly full', async () => {
    await expect(collectPages(async () => [1, 2], 2, 2)).rejects.toThrow(
      'Pagination exceeded the safety limit of 4 items',
    )
  })
})

describe('chat proposal requests', () => {
  it('keeps a stable idempotency key when an apply request is retried', async () => {
    const proposal: ChatProposal = {
      proposal_id: 'proposal-1',
      thread_id: 'thread-1',
      document_id: 'document-1',
      expected_revision_id: 'revision-1',
      content: 'Updated content',
      summary: 'Update the document',
      status: 'pending',
      applied_revision_id: null,
      created_at: '2026-07-19T00:00:00Z',
      applied_at: null,
    }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify(proposal), { status: 200 }))

    await api.applyChatProposal(proposal)
    await api.applyChatProposal(proposal)

    const keys = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers).get('Idempotency-Key'))
    expect(keys).toEqual(['chat-proposal:proposal-1', 'chat-proposal:proposal-1'])
  })
})
