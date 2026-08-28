import { z } from 'zod'
import type { DraftRecord, DraftStorage } from './draftStorage'

export const workbenchStorageKey = 'sangam.workbench.v1'
export const legacyDraftMigrationKey = 'sangam.browser-state.migration.legacy-drafts.v1'
const legacyDraftBridgeKey = 'sangam.document-drafts.migration.v1'

const legacySessionSchema = z.object({
  content: z.string().optional(),
  baseRevisionId: z.string().optional(),
})

const legacyWorkbenchStateSchema = z
  .object({
    sessions: z.record(z.string(), legacySessionSchema).optional(),
  })
  .passthrough()

type LegacyWorkbenchState = z.infer<typeof legacyWorkbenchStateSchema>

const bridgeDraftSchema = z.object({
  content: z.string().optional(),
  baseRevisionId: z.string().optional(),
  updatedAt: z.number().optional(),
})

const bridgeDraftsMapSchema = z.record(z.string(), bridgeDraftSchema)

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
    const parsed = JSON.parse(rawState)
    const result = legacyWorkbenchStateSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

function collectLegacyDrafts(state: LegacyWorkbenchState | null): DraftRecord[] {
  return Object.entries(state?.sessions ?? {}).flatMap(([documentId, session]) => {
    if (session.content === undefined) return []
    return [
      {
        documentId,
        content: session.content,
        baseRevisionId: session.baseRevisionId,
        updatedAt: Date.now(),
      },
    ]
  })
}

function collectBridgeDrafts(rawDrafts: string | null): DraftRecord[] {
  if (!rawDrafts) return []
  try {
    const parsed = JSON.parse(rawDrafts)
    const result = bridgeDraftsMapSchema.safeParse(parsed)
    if (!result.success) return []
    return Object.entries(result.data).flatMap(([documentId, draft]) =>
      draft.content !== undefined
        ? [
            {
              documentId,
              content: draft.content,
              baseRevisionId: draft.baseRevisionId,
              updatedAt: draft.updatedAt ?? Date.now(),
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
