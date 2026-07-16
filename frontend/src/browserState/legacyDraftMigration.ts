import type { DraftRecord, DraftStorage } from './draftStorage'

export const workbenchStorageKey = 'sangam.workbench.v1'
export const legacyDraftMigrationKey = 'sangam.browser-state.migration.legacy-drafts.v1'
const legacyDraftBridgeKey = 'sangam.document-drafts.migration.v1'

type LegacyWorkbenchState = {
  sessions?: Record<string, { content?: unknown; baseRevisionId?: unknown }>
  [key: string]: unknown
}

export async function migrateLegacyDrafts(
  draftStorage: DraftStorage,
  browserStorage: Storage = localStorage,
): Promise<number> {
  if (browserStorage.getItem(legacyDraftMigrationKey)) return 0

  const rawState = browserStorage.getItem(workbenchStorageKey)
  const state = parseLegacyState(rawState)
  const drafts = mergeDrafts(
    collectLegacyDrafts(state),
    collectBridgeDrafts(browserStorage.getItem(legacyDraftBridgeKey)),
  )
  await Promise.all(drafts.map((draft) => draftStorage.set(draft)))

  if (state?.sessions) {
    const layoutState = { ...state }
    delete layoutState.sessions
    browserStorage.setItem(workbenchStorageKey, JSON.stringify(layoutState))
  }
  browserStorage.removeItem(legacyDraftBridgeKey)
  browserStorage.setItem(legacyDraftMigrationKey, 'complete')
  return drafts.length
}

function parseLegacyState(rawState: string | null): LegacyWorkbenchState | null {
  if (!rawState) return null
  try {
    const value = JSON.parse(rawState) as unknown
    return value && typeof value === 'object' ? (value as LegacyWorkbenchState) : null
  } catch {
    return null
  }
}

function collectLegacyDrafts(state: LegacyWorkbenchState | null): DraftRecord[] {
  return Object.entries(state?.sessions ?? {}).flatMap(([documentId, session]) => {
    if (typeof session.content !== 'string') return []
    return [
      {
        documentId,
        content: session.content,
        baseRevisionId: typeof session.baseRevisionId === 'string' ? session.baseRevisionId : undefined,
        updatedAt: Date.now(),
      },
    ]
  })
}

function collectBridgeDrafts(rawDrafts: string | null): DraftRecord[] {
  if (!rawDrafts) return []
  try {
    const drafts = JSON.parse(rawDrafts) as Record<string, Partial<DraftRecord>>
    return Object.entries(drafts).flatMap(([documentId, draft]) =>
      typeof draft.content === 'string'
        ? [
            {
              documentId,
              content: draft.content,
              baseRevisionId: typeof draft.baseRevisionId === 'string' ? draft.baseRevisionId : undefined,
              updatedAt: typeof draft.updatedAt === 'number' ? draft.updatedAt : Date.now(),
            },
          ]
        : [],
    )
  } catch {
    return []
  }
}

function mergeDrafts(...sources: DraftRecord[][]) {
  const drafts = new Map<string, DraftRecord>()
  for (const source of sources) {
    for (const draft of source) drafts.set(draft.documentId, draft)
  }
  return [...drafts.values()]
}
