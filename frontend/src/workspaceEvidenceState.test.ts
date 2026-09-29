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
  beforeEach(async () => {
    Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name: string, callback: () => void) => callback() },
    })
    await workspaceEvidenceStore.clearEvidence()
  })

  it('keeps and retrieves evidence items across the workspace', async () => {
    const item = await workspaceEvidenceStore.keepEvidence({
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
    expect(items[0]?.id).toBe(item.id)
  })

  it('updates an evidence item with an attached claim or note', async () => {
    const item = await workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'doc-2',
      sourceTitle: 'Performance Report',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-beta',
      selectedText: 'P99 latency stayed under 15ms.',
    })

    await workspaceEvidenceStore.updateEvidence(item.id, {
      claim: 'P99 latency does not degrade under peak concurrency.',
      note: 'Verified in cluster benchmark run 4.',
    })

    const updated = workspaceEvidenceStore.getEvidence().find((candidate) => candidate.id === item.id)
    expect(updated?.claim).toBe('P99 latency does not degrade under peak concurrency.')
    expect(updated?.note).toBe('Verified in cluster benchmark run 4.')
  })

  it('remaps the actual passage with an unbound revision callback and preserves the pin when absent', async () => {
    const item = await workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'doc-3',
      sourceTitle: 'API Spec',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-1',
      selectedText: 'POST /v1/documents returns 201 Created.',
    })

    const replace = workspaceEvidenceStore.replaceEvidenceRevision
    await expect(replace(item.id, 'rev-2', 'Unrelated text')).rejects.toThrow('passage')
    expect(workspaceEvidenceStore.getEvidence()[0]?.pinnedRevisionId).toBe('rev-1')
    await replace(item.id, 'rev-2', 'New introduction.\nPOST /v1/documents returns 201 Created.')
    const updated = workspaceEvidenceStore.getEvidence().find((candidate) => candidate.id === item.id)
    expect(updated?.pinnedRevisionId).toBe('rev-2')
    expect(updated?.textLocator?.start).toBe(18)
  })

  it('removes and clears evidence', async () => {
    const item1 = await workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'doc-1',
      sourceTitle: 'Doc 1',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-1',
      selectedText: 'Excerpt 1',
    })
    const item2 = await workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'doc-2',
      sourceTitle: 'Doc 2',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-2',
      selectedText: 'Excerpt 2',
    })

    expect(workspaceEvidenceStore.getEvidence()).toHaveLength(2)

    await workspaceEvidenceStore.removeEvidence(item1.id)
    expect(workspaceEvidenceStore.getEvidence().map((i) => i.id)).toEqual([item2.id])

    await workspaceEvidenceStore.clearEvidence()
    expect(workspaceEvidenceStore.getEvidence()).toHaveLength(0)
  })
  it('rejects malformed durable records and refuses to overwrite them', async () => {
    localStorage.setItem('sangam-workspace-evidence', '[{"selectedText":42}]')
    await expect(workspaceEvidenceStore.clearEvidence()).rejects.toThrow()
    expect(localStorage.getItem('sangam-workspace-evidence')).toBe('[{"selectedText":42}]')
  })
})
