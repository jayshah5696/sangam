// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import { alternativeDraftsStore } from './alternativeDrafts'

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

describe('alternativeDraftsStore', () => {
  beforeEach(async () => {
    Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name: string, callback: () => void) => callback() },
    })
    await alternativeDraftsStore.clear()
  })

  it('registers and retrieves candidate drafts for a parent document', async () => {
    const candidate = await alternativeDraftsStore.registerCandidate({
      parentDocumentId: 'doc-original',
      candidateDocumentId: 'doc-candidate-1',
      baseRevisionId: 'rev-base-1',
      title: 'Original Draft (Alternative Conclusion)',
      conclusionNote: 'Smaller model hypothesis',
    })

    expect(candidate.id).toBeDefined()
    expect(candidate.createdAt).toBeDefined()
    expect(candidate.conclusionNote).toBe('Smaller model hypothesis')

    const parentCandidates = alternativeDraftsStore.getByParent('doc-original')
    expect(parentCandidates).toHaveLength(1)
    expect(parentCandidates[0]?.candidateDocumentId).toBe('doc-candidate-1')

    const otherCandidates = alternativeDraftsStore.getByParent('doc-other')
    expect(otherCandidates).toHaveLength(0)
  })

  it('removes candidate drafts by candidate document ID', async () => {
    await alternativeDraftsStore.registerCandidate({
      parentDocumentId: 'doc-original',
      candidateDocumentId: 'doc-candidate-1',
      baseRevisionId: 'rev-base-1',
      title: 'Candidate 1',
    })

    await alternativeDraftsStore.removeCandidate('doc-candidate-1')
    expect(alternativeDraftsStore.getByParent('doc-original')).toHaveLength(0)
  })
})
