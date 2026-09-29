import { useSyncExternalStore } from 'react'
import type { EvidenceItem } from './evidenceCitation'

export const EVIDENCE_STORAGE_KEY = 'sangam-workspace-evidence'
export const EVIDENCE_UPDATED_EVENT = 'sangam-evidence-updated'

export type WorkspaceEvidenceState = {
  evidence: EvidenceItem[]
  keepEvidence: (item: Omit<EvidenceItem, 'id' | 'createdAt'>) => EvidenceItem
  updateEvidence: (id: string, patch: Partial<EvidenceItem>) => void
  removeEvidence: (id: string) => void
  replaceEvidenceRevision: (id: string, newRevisionId: string) => void
  clearEvidence: () => void
}

let cachedRaw: string | null = null
let cachedItems: EvidenceItem[] = []

function readItems(): EvidenceItem[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(EVIDENCE_STORAGE_KEY)
  } catch {
    return []
  }
  if (raw === cachedRaw) return cachedItems
  cachedRaw = raw
  if (!raw) {
    cachedItems = []
    return cachedItems
  }
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      // SAFETY: parsed is validated as array from localStorage JSON
      cachedItems = parsed as EvidenceItem[]
      return cachedItems
    }
  } catch {
    // Ignore malformed JSON and return empty items
  }
  cachedItems = []
  return cachedItems
}

function writeItems(items: EvidenceItem[]): void {
  cachedItems = items
  cachedRaw = JSON.stringify(items)
  try {
    localStorage.setItem(EVIDENCE_STORAGE_KEY, cachedRaw)
  } catch {
    // Ignore storage quota or environment issues
  }
  window.dispatchEvent(new CustomEvent(EVIDENCE_UPDATED_EVENT))
}

const listeners = new Set<() => void>()

function subscribe(callback: () => void): () => void {
  listeners.add(callback)
  const handleStorage = (event: StorageEvent) => {
    if (event.key === EVIDENCE_STORAGE_KEY) {
      callback()
    }
  }
  const handleCustom = () => {
    callback()
  }

  window.addEventListener('storage', handleStorage)
  window.addEventListener(EVIDENCE_UPDATED_EVENT, handleCustom)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener(EVIDENCE_UPDATED_EVENT, handleCustom)
  }
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export const workspaceEvidenceStore = {
  getEvidence(): EvidenceItem[] {
    return readItems()
  },

  keepEvidence(item: Omit<EvidenceItem, 'id' | 'createdAt'>): EvidenceItem {
    const created: EvidenceItem = {
      ...item,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }
    const current = readItems()
    writeItems([created, ...current])
    notify()
    return created
  },

  updateEvidence(id: string, patch: Partial<EvidenceItem>): void {
    const current = readItems()
    const next = current.map((item) => (item.id === id ? { ...item, ...patch } : item))
    writeItems(next)
    notify()
  },

  removeEvidence(id: string): void {
    const current = readItems()
    const next = current.filter((item) => item.id !== id)
    writeItems(next)
    notify()
  },

  replaceEvidenceRevision(id: string, newRevisionId: string): void {
    this.updateEvidence(id, { pinnedRevisionId: newRevisionId })
  },

  clearEvidence(): void {
    writeItems([])
    notify()
  },
}

export function useWorkspaceEvidence(): WorkspaceEvidenceState {
  const evidence = useSyncExternalStore(subscribe, readItems, () => [])

  return {
    evidence,
    keepEvidence: workspaceEvidenceStore.keepEvidence,
    updateEvidence: workspaceEvidenceStore.updateEvidence,
    removeEvidence: workspaceEvidenceStore.removeEvidence,
    replaceEvidenceRevision: workspaceEvidenceStore.replaceEvidenceRevision,
    clearEvidence: workspaceEvidenceStore.clearEvidence,
  }
}
