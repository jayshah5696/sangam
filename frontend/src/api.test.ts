import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, collectPages, type ChatEffect, type ChatProposal } from './api'

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

describe('response handling', () => {
  it('accepts an empty 204 response from backup deletion', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))

    await expect(api.deleteBackup('20260822T120000000000Z-deadbeef')).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/backups/20260822T120000000000Z-deadbeef',
      expect.objectContaining({ method: 'DELETE' }),
    )
  })
})

describe('bounded document pages', () => {
  it('returns an explicit continuation when a page is full', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            document_id: 'doc-1',
            title: 'First',
            path: null,
            content_type: 'text/markdown',
            current_revision_id: 'rev-1',
            content_hash: 'hash',
            size_bytes: 5,
            materialization_state: 'none',
            file_hash: null,
            deleted: false,
            created_by: 'human:test',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            updated_by: 'human:test',
            updated_by_name: 'Test',
            revision_summary: '',
            category: null,
            metadata_version: 1,
            trust_level: 'untrusted',
            trust_version: 1,
            tags: [],
            search_snippet: null,
            pdf_page_count: null,
            pdf_extraction_status: null,
            pdf_extraction_error: null,
            supersedes_document_id: null,
          },
        ]),
        { status: 200 },
      ),
    )

    const result = await api.searchDocumentsPage('first', undefined, 'relevance', 20, 1)
    expect(result).toEqual({ items: expect.any(Array), hasMore: true })
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/search?q=first&sort=relevance&limit=1&offset=20',
      expect.anything(),
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

describe('chat effect requests', () => {
  it('binds the decision to the persisted argument digest and a stable key', async () => {
    const effect: ChatEffect = {
      effect_id: 'effect-1',
      thread_id: 'thread-1',
      requested_by: 'human:jay',
      capability_id: 'create_document',
      capability_version: 1,
      argument_digest: 'a'.repeat(64),
      preview: { title: 'Draft' },
      effect_class: 'write',
      risk: 'workspace',
      status: 'pending_approval',
      expires_at: '2026-08-23T01:00:00Z',
      resource_type: null,
      resource_id: null,
      result: null,
      failure: null,
      created_at: '2026-08-23T00:00:00Z',
      decided_at: null,
      completed_at: null,
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ effect: { ...effect, status: 'denied' }, client_result: {} }), {
        status: 200,
      }),
    )

    await api.decideChatEffect(effect, 'deny', 'Not this one')

    const call = fetchMock.mock.calls[0]
    expect(call).toBeDefined()
    const [, init] = call!
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('chat-effect:effect-1:deny')
    expect(JSON.parse(String(init?.body))).toEqual({
      verdict: 'deny',
      argument_digest: 'a'.repeat(64),
      reason: 'Not this one',
    })
  })
})
