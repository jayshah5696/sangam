// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { workspaceEvidenceStore } from './workspaceEvidenceState'

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

describe('workspaceEvidenceStore', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
    workspaceEvidenceStore.clearEvidence()
  })

  it('keeps and retrieves evidence items across the workspace', () => {
    const item = workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'doc-1',
      sourceTitle: 'System Design',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-alpha',
      selectedText: 'Distributed consensus requires quorum agreement.',
    })

    expect(item.id).toBeDefined()
    expect(item.createdAt).toBeDefined()
    expect(item.selectedText).toBe('Distributed consensus requires quorum agreement.')

    const items = workspaceEvidenceStore.getEvidence()
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe(item.id)
  })

  it('updates an evidence item with an attached claim or note', () => {
    const item = workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'doc-2',
      sourceTitle: 'Performance Report',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-beta',
      selectedText: 'P99 latency stayed under 15ms.',
    })

    workspaceEvidenceStore.updateEvidence(item.id, {
      claim: 'P99 latency does not degrade under peak concurrency.',
      note: 'Verified in cluster benchmark run 4.',
    })

    const updated = workspaceEvidenceStore.getEvidence().find((candidate) => candidate.id === item.id)
    expect(updated?.claim).toBe('P99 latency does not degrade under peak concurrency.')
    expect(updated?.note).toBe('Verified in cluster benchmark run 4.')
  })

  it('replaces pinned revision when source changes', () => {
    const item = workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'doc-3',
      sourceTitle: 'API Spec',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-1',
      selectedText: 'POST /v1/documents returns 201 Created.',
    })

    workspaceEvidenceStore.replaceEvidenceRevision(item.id, 'rev-2')
    const updated = workspaceEvidenceStore.getEvidence().find((candidate) => candidate.id === item.id)
    expect(updated?.pinnedRevisionId).toBe('rev-2')
  })

  it('removes and clears evidence', () => {
    const item1 = workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'doc-1',
      sourceTitle: 'Doc 1',
      sourceContentType: 'text/markdown',
      selectedText: 'Excerpt 1',
    })
    const item2 = workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'doc-2',
      sourceTitle: 'Doc 2',
      sourceContentType: 'text/markdown',
      selectedText: 'Excerpt 2',
    })

    expect(workspaceEvidenceStore.getEvidence()).toHaveLength(2)

    workspaceEvidenceStore.removeEvidence(item1.id)
    expect(workspaceEvidenceStore.getEvidence().map((i) => i.id)).toEqual([item2.id])

    workspaceEvidenceStore.clearEvidence()
    expect(workspaceEvidenceStore.getEvidence()).toHaveLength(0)
  })
})
