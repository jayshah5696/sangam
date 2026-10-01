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

  it('returns a bounded result window without waiting for a terminal page', async () => {
    const offsets: number[] = []
    const values = await collectPages(
      async (offset, limit) => {
        offsets.push(offset)
        return Array.from({ length: limit }, (_, index) => offset + index)
      },
      2,
      50,
      5,
    )

    expect(values).toEqual([0, 1, 2, 3, 4])
    expect(offsets).toEqual([0, 2, 4])
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
      evidence: null,
      evidence_status: 'not_recorded',
      citations: [],
      sources_retrieved: [],
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

describe('projects api', () => {
  it('lists projects with parsed summary fields', async () => {
    const mockProjects = [
      {
        project_id: 'proj_123',
        name: 'Research Paper',
        description: 'Deep dive into architecture',
        brief_document_id: 'doc_brief',
        brief_document_title: 'Research Paper Brief',
        active_thread_id: 'thread_1',
        version: 1,
        document_count: 3,
        thread_count: 1,
        annotation_count: 2,
        created_by: 'human:jay',
        created_at: '2026-09-29T00:00:00Z',
        updated_at: '2026-09-29T00:00:00Z',
      },
    ]
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(mockProjects), { status: 200 }))

    const projects = await api.listProjects()
    expect(projects).toEqual(mockProjects)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/projects', expect.anything())
  })

  it('gets full project details including documents and layout state', async () => {
    const mockDetail = {
      project_id: 'proj_123',
      name: 'Research Paper',
      description: null,
      brief_document_id: 'doc_brief',
      brief_document_title: 'Brief',
      active_thread_id: null,
      version: 1,
      document_count: 1,
      thread_count: 0,
      annotation_count: 0,
      created_by: 'human:jay',
      created_at: '2026-09-29T00:00:00Z',
      updated_at: '2026-09-29T00:00:00Z',
      workbench_state_json: '{"schemaVersion":1}',
      documents: [
        {
          project_id: 'proj_123',
          document_id: 'doc_1',
          document_title: 'Doc 1',
          document_path: 'paper.pdf',
          content_type: 'application/pdf',
          role: 'source',
          pinned_page: 5,
          notes: 'Key methodology citation',
          current_revision_id: 'revision_1',
          updated_at: '2026-09-29T00:00:00Z',
          created_at: '2026-09-29T00:00:00Z',
        },
      ],
      threads: [],
      annotations: [],
    }
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(mockDetail), { status: 200 }))

    const detail = await api.getProject('proj_123')
    expect(detail.name).toBe('Research Paper')
    expect(detail.documents).toHaveLength(1)
    expect(detail.documents[0]?.role).toBe('source')
    expect(detail.documents[0]?.pinned_page).toBe(5)
  })

  it('creates a project with brief generation requested', async () => {
    const mockCreated = {
      project_id: 'proj_new',
      name: 'New Investigation',
      description: 'Project description',
      brief_document_id: 'doc_auto_brief',
      brief_document_title: 'New Investigation Brief',
      active_thread_id: null,
      version: 1,
      document_count: 1,
      thread_count: 0,
      annotation_count: 0,
      created_by: 'human:jay',
      created_at: '2026-09-29T00:00:00Z',
      updated_at: '2026-09-29T00:00:00Z',
      workbench_state_json: null,
      documents: [],
      threads: [],
      annotations: [],
    }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(mockCreated), { status: 200 }))

    const result = await api.createProject({
      name: 'New Investigation',
      description: 'Project description',
      create_brief: true,
    })

    expect(result.project_id).toBe('proj_new')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/projects',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'New Investigation',
          description: 'Project description',
          create_brief: true,
        }),
      }),
    )
  })

  it('requests and parses document backlinks', async () => {
    const mockSummary = {
      document_id: 'doc-source',
      title: 'Referring Note',
      content_type: 'text/markdown',
      path: 'notes/referring.md',
      current_revision_id: 'rev-1',
      content_hash: 'hash-1',
      size_bytes: 42,
      materialization_state: 'clean',
      file_hash: null,
      deleted: false,
      created_by: 'user-1',
      created_at: '2026-09-30T00:00:00Z',
      updated_at: '2026-09-30T00:00:00Z',
      updated_by: 'user-1',
      updated_by_name: 'User One',
      revision_summary: null,
      category: null,
      metadata_version: 1,
      trust_level: 'untrusted',
      trust_version: 1,
      tags: [],
      search_snippet: '… links to [Target](sangam://document/doc-target) …',
      pdf_page_count: null,
      pdf_extraction_status: null,
      pdf_extraction_error: null,
      supersedes_document_id: null,
    }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify([mockSummary]), { status: 200 }))

    const result = await api.getBacklinks('doc-target')
    expect(result).toHaveLength(1)
    expect(result[0]?.document_id).toBe('doc-source')
    expect(result[0]?.search_snippet).toContain('links to [Target]')
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/documents/doc-target/backlinks', expect.anything())
  })
})
