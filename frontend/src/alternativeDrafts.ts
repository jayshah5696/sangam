import { useSyncExternalStore } from 'react'
import { z } from 'zod'

export const ALTERNATIVE_DRAFTS_STORAGE_KEY = 'sangam-alternative-drafts'

export const alternativeCandidateSchema = z.object({
  id: z.string().min(1),
  parentDocumentId: z.string().min(1),
  candidateDocumentId: z.string().min(1),
  baseRevisionId: z.string().min(1),
  title: z.string().min(1),
  conclusionNote: z.string().optional(),
  createdAt: z.string(),
})

export type AlternativeCandidate = z.infer<typeof alternativeCandidateSchema>

const candidatesListSchema = z.array(alternativeCandidateSchema)
let cachedRaw: string | null | undefined
let cachedCandidates: AlternativeCandidate[] = []
const listeners = new Set<() => void>()
const notify = () => listeners.forEach((listener) => listener())

function readCandidates(): AlternativeCandidate[] {
  const raw = localStorage.getItem(ALTERNATIVE_DRAFTS_STORAGE_KEY)
  if (raw === cachedRaw) return cachedCandidates
  const items = raw === null ? [] : candidatesListSchema.parse(JSON.parse(raw))
  cachedRaw = raw
  cachedCandidates = items
  return items
}

function snapshot() {
  try {
    return readCandidates()
  } catch {
    return cachedCandidates
  }
}

function subscribe(callback: () => void) {
  listeners.add(callback)
  const storage = (event: StorageEvent) => {
    if (event.key === ALTERNATIVE_DRAFTS_STORAGE_KEY) callback()
  }
  window.addEventListener('storage', storage)
  return () => {
    listeners.delete(callback)
    window.removeEventListener('storage', storage)
  }
}

async function mutate<T>(
  operation: (items: AlternativeCandidate[]) => { items: AlternativeCandidate[]; result: T },
): Promise<T> {
  if ('locks' in navigator && navigator.locks) {
    return await navigator.locks.request(ALTERNATIVE_DRAFTS_STORAGE_KEY, () => {
      const next = operation(readCandidates())
      const validated = candidatesListSchema.parse(next.items)
      const raw = JSON.stringify(validated)
      localStorage.setItem(ALTERNATIVE_DRAFTS_STORAGE_KEY, raw)
      cachedRaw = raw
      cachedCandidates = validated
      notify()
      return next.result
    })
  }
  const next = operation(readCandidates())
  const validated = candidatesListSchema.parse(next.items)
  const raw = JSON.stringify(validated)
  localStorage.setItem(ALTERNATIVE_DRAFTS_STORAGE_KEY, raw)
  cachedRaw = raw
  cachedCandidates = validated
  notify()
  return next.result
}

export const alternativeDraftsStore = {
  getAll: readCandidates,
  getByParent: (parentDocumentId: string): AlternativeCandidate[] =>
    readCandidates().filter((c) => c.parentDocumentId === parentDocumentId),
  registerCandidate: async (
    candidate: Omit<AlternativeCandidate, 'id' | 'createdAt'>,
  ): Promise<AlternativeCandidate> => {
    const created: AlternativeCandidate = {
      ...candidate,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }
    return mutate((items) => ({
      items: [created, ...items],
      result: created,
    }))
  },
  removeCandidate: async (candidateDocumentId: string): Promise<void> =>
    mutate((items) => ({
      items: items.filter((c) => c.candidateDocumentId !== candidateDocumentId),
      result: undefined,
    })),
  clear: async (): Promise<void> =>
    mutate(() => ({
      items: [],
      result: undefined,
    })),
}

export function useAlternativeCandidates(parentDocumentId: string) {
  const allCandidates = useSyncExternalStore(subscribe, snapshot)
  const parentCandidates = allCandidates.filter((c) => c.parentDocumentId === parentDocumentId)
  return {
    candidates: parentCandidates,
    registerCandidate: alternativeDraftsStore.registerCandidate,
    removeCandidate: alternativeDraftsStore.removeCandidate,
  }
}
