import { useSyncExternalStore } from 'react'
import { z } from 'zod'
import { evidenceItemSchema, remapEvidencePassage, type EvidenceItem } from './evidenceCitation'

export const EVIDENCE_STORAGE_KEY = 'sangam-workspace-evidence'
export const EVIDENCE_UPDATED_EVENT = 'sangam-evidence-updated'
const itemsSchema = z.array(evidenceItemSchema)
let cachedRaw: string | null | undefined
let cachedItems: EvidenceItem[] = []
let storageError: string | null = null
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())
function readItems(): EvidenceItem[] {
  const raw = localStorage.getItem(EVIDENCE_STORAGE_KEY)
  if (raw === cachedRaw) return cachedItems
  const items = raw === null ? [] : itemsSchema.parse(JSON.parse(raw))
  cachedRaw = raw
  cachedItems = items
  return items
}
function snapshot() {
  try {
    return readItems()
  } catch (error) {
    storageError = `Evidence storage could not be read: ${error instanceof Error ? error.message : String(error)}`
    return cachedItems
  }
}
function subscribe(callback: () => void) {
  listeners.add(callback)
  const storage = (event: StorageEvent) => {
    if (event.key === EVIDENCE_STORAGE_KEY) callback()
  }
  window.addEventListener('storage', storage)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('storage', storage)
  }
}

// All tabs take the same exclusive Web Lock and re-read inside the critical section.
// Failed reads/writes never mutate the last known collection or the durable bytes.
async function mutate<T>(
  operation: (items: EvidenceItem[]) => { items: EvidenceItem[]; result: T },
): Promise<T> {
  try {
    if (!navigator.locks)
      throw new Error('This browser cannot serialize evidence storage. Use a browser with Web Locks support.')
    return await navigator.locks.request(EVIDENCE_STORAGE_KEY, () => {
      const next = operation(readItems())
      const validated = itemsSchema.parse(next.items)
      const raw = JSON.stringify(validated)
      localStorage.setItem(EVIDENCE_STORAGE_KEY, raw)
      cachedRaw = raw
      cachedItems = validated
      storageError = null
      notify()
      return next.result
    })
  } catch (error) {
    storageError = `Evidence storage failed: ${error instanceof Error ? error.message : String(error)}`
    notify()
    throw error
  }
}
export const workspaceEvidenceStore = {
  getEvidence: readItems,
  keepEvidence: async (item: Omit<EvidenceItem, 'id' | 'createdAt'>): Promise<EvidenceItem> => {
    const created = evidenceItemSchema.parse({
      ...item,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    })
    return mutate((items) => ({ items: [created, ...items], result: created }))
  },
  updateEvidence: async (
    id: string,
    patch: Partial<Pick<EvidenceItem, 'claim' | 'note' | 'claimTarget' | 'claimClassification'>>,
  ): Promise<void> =>
    mutate((items) => ({
      items: items.map((item) =>
        item.id === id ? { ...item, ...patch, id: item.id, createdAt: item.createdAt } : item,
      ),
      result: undefined,
    })),
  removeEvidence: async (id: string): Promise<void> =>
    mutate((items) => ({ items: items.filter((item) => item.id !== id), result: undefined })),
  replaceEvidenceRevision: async (id: string, newRevisionId: string, content: string): Promise<void> =>
    mutate((items) => ({
      items: items.map((item) => {
        if (item.id !== id) return item
        const textLocator = remapEvidencePassage(content, item)
        if (!textLocator || item.sourceContentType === 'application/pdf')
          throw new Error(
            'The original passage is absent from this revision. Keep the original pin or capture a new passage.',
          )
        return { ...item, pinnedRevisionId: newRevisionId, textLocator }
      }),
      result: undefined,
    })),
  clearEvidence: async (): Promise<void> => mutate(() => ({ items: [], result: undefined })),
  retry: () => {
    cachedRaw = undefined
    storageError = null
    snapshot()
    notify()
  },
}
export function useWorkspaceEvidence() {
  const evidence = useSyncExternalStore(subscribe, snapshot)
  const error = useSyncExternalStore(subscribe, () => {
    snapshot()
    return storageError
  })
  return { evidence, error, ...workspaceEvidenceStore }
}
export type WorkspaceEvidenceState = ReturnType<typeof useWorkspaceEvidence>
