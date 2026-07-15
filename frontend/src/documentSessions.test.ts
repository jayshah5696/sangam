// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Document } from './api'
import { DocumentSessionStore, type DraftStorage } from './documentSessions'

function documentAt(revision: string, content: string): Document {
  return {
    document_id: 'doc-1',
    title: 'Test',
    content_type: 'text/markdown',
    path: 'test.md',
    current_revision_id: revision,
    content,
    content_hash: `hash-${revision}`,
    size_bytes: content.length,
    materialization_state: 'clean',
    file_hash: `hash-${revision}`,
    deleted: false,
    created_by: 'human:test',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    updated_by: 'human:test',
    updated_by_name: 'Test',
    revision_summary: null,
    category: null,
    metadata_version: 1,
    tags: [],
    search_snippet: null,
  }
}

function memoryStorage() {
  const drafts = new Map<
    string,
    { documentId: string; content: string; baseRevisionId?: string; updatedAt: number }
  >()
  const storage: DraftStorage = {
    get: vi.fn(async (documentId) => drafts.get(documentId)),
    set: vi.fn(async (draft) => {
      drafts.set(draft.documentId, draft)
    }),
    delete: vi.fn(async (documentId) => {
      drafts.delete(documentId)
    }),
  }
  return { drafts, storage }
}

afterEach(() => vi.useRealTimers())

describe('document session autosave', () => {
  it('never lets an older save response replace newer editor content', async () => {
    vi.useFakeTimers()
    const { storage } = memoryStorage()
    const pending: Array<{ content: string; resolve: (document: Document) => void }> = []
    const saveDocument = vi.fn(
      (_base: Document, content: string) =>
        new Promise<Document>((resolve) => {
          pending.push({ content, resolve })
        }),
    )
    const store = new DocumentSessionStore({ storage, saveDocument, saveDelay: 20, persistDelay: 5 })
    await store.initializeDocument(documentAt('rev-1', 'original'))

    store.updateSession('doc-1', { content: 'first edit' })
    await vi.advanceTimersByTimeAsync(20)
    expect(pending[0]?.content).toBe('first edit')

    store.updateSession('doc-1', { content: 'newer edit' })
    pending[0]!.resolve(documentAt('rev-2', 'first edit'))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSession('doc-1').content).toBe('newer edit')
    expect(store.getSession('doc-1').saveState).toBe('dirty')

    await vi.advanceTimersByTimeAsync(20)
    expect(pending[1]?.content).toBe('newer edit')
    pending[1]!.resolve(documentAt('rev-3', 'newer edit'))
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getSession('doc-1')).toMatchObject({
      content: 'newer edit',
      saveState: 'saved',
      baseRevisionId: 'rev-3',
    })
  })

  it('does not restart draft or save debounce for selection-only updates', async () => {
    vi.useFakeTimers()
    const { storage } = memoryStorage()
    const saveDocument = vi.fn(async (_base: Document, content: string) => documentAt('rev-2', content))
    const store = new DocumentSessionStore({ storage, saveDocument, saveDelay: 80, persistDelay: 20 })
    await store.initializeDocument(documentAt('rev-1', 'original'))

    store.updateSession('doc-1', { content: 'edited' })
    await vi.advanceTimersByTimeAsync(10)
    store.updateSession('doc-1', { selection: { line: 2, column: 3, selectedCharacters: 0 } })
    await vi.advanceTimersByTimeAsync(10)
    expect(storage.set).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60)
    expect(saveDocument).toHaveBeenCalledTimes(1)
  })

  it('recovers a separately persisted draft without putting it in layout state', async () => {
    const { drafts, storage } = memoryStorage()
    drafts.set('doc-1', { documentId: 'doc-1', content: 'recovered', baseRevisionId: 'rev-1', updatedAt: 1 })
    const store = new DocumentSessionStore({
      storage,
      saveDocument: vi.fn(async (_base, content) => documentAt('rev-2', content)),
    })
    await store.initializeDocument(documentAt('rev-1', 'original'))
    expect(store.getSession('doc-1')).toMatchObject({
      content: 'recovered',
      baseRevisionId: 'rev-1',
      saveState: 'dirty',
    })
    store.dispose()
  })
})
