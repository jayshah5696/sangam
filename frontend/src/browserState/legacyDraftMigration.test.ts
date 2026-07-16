// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import type { DraftStorage } from './draftStorage'
import { legacyDraftMigrationKey, migrateLegacyDrafts, workbenchStorageKey } from './legacyDraftMigration'

function storageThat(set: DraftStorage['set'] = vi.fn(async () => undefined)): DraftStorage {
  return {
    get: vi.fn(async () => undefined),
    set,
    delete: vi.fn(async () => undefined),
  }
}

function memoryBrowserStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  }
}

describe('legacy draft migration', () => {
  it('copies drafts before removing them from layout storage and runs once', async () => {
    const draftStorage = storageThat()
    const browserStorage = memoryBrowserStorage()
    browserStorage.setItem(
      workbenchStorageKey,
      JSON.stringify({
        root: { kind: 'group', id: 'group-1', tabs: [], activeTabId: null },
        activeGroupId: 'group-1',
        sessions: { 'doc-1': { content: 'recovered', baseRevisionId: 'rev-1' } },
      }),
    )
    browserStorage.setItem(
      'sangam.document-drafts.migration.v1',
      JSON.stringify({ 'doc-2': { content: 'bridged draft', updatedAt: 10 } }),
    )

    await expect(migrateLegacyDrafts(draftStorage, browserStorage)).resolves.toBe(2)
    expect(draftStorage.set).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: 'doc-1', content: 'recovered', baseRevisionId: 'rev-1' }),
    )
    expect(JSON.parse(browserStorage.getItem(workbenchStorageKey)!)).not.toHaveProperty('sessions')
    expect(browserStorage.getItem(legacyDraftMigrationKey)).toBe('complete')
    expect(browserStorage.getItem('sangam.document-drafts.migration.v1')).toBeNull()

    await expect(migrateLegacyDrafts(draftStorage, browserStorage)).resolves.toBe(0)
    expect(draftStorage.set).toHaveBeenCalledTimes(2)
  })

  it('keeps the source draft and marker untouched when persistence fails', async () => {
    const draftStorage = storageThat(vi.fn(async () => Promise.reject(new Error('storage failed'))))
    const browserStorage = memoryBrowserStorage()
    browserStorage.setItem(
      workbenchStorageKey,
      JSON.stringify({ sessions: { 'doc-1': { content: 'do not lose me' } } }),
    )

    await expect(migrateLegacyDrafts(draftStorage, browserStorage)).rejects.toThrow('storage failed')
    expect(JSON.parse(browserStorage.getItem(workbenchStorageKey)!)).toHaveProperty('sessions.doc-1.content')
    expect(browserStorage.getItem(legacyDraftMigrationKey)).toBeNull()
  })
})
