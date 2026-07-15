import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  activateTab as activateTabInLayout,
  closeGroup as closeGroupInLayout,
  closeOtherTabs as closeOtherTabsInLayout,
  closeTab as closeTabInLayout,
  collectGroups,
  createDefaultLayoutState,
  ensureDocumentOpen as ensureDocumentOpenInLayout,
  isLayoutNode,
  reopenClosedTab as reopenClosedTabInLayout,
  resetLayout as resetLayoutState,
  setSplitRatio as setSplitRatioInLayout,
  splitGroup as splitGroupInLayout,
  togglePinned as togglePinnedInLayout,
  updateDocumentTitle as updateDocumentTitleInLayout,
  type SplitDirection,
  type WorkbenchLayoutState,
} from './workbenchLayout'

export type { GroupNode, LayoutNode, SplitDirection, WorkbenchTab } from './workbenchLayout'

type WorkbenchContextValue = WorkbenchLayoutState & {
  openDocument: (documentId: string, title?: string, groupId?: string) => void
  ensureDocumentOpen: (documentId: string, title?: string, groupId?: string) => void
  activateTab: (groupId: string, documentId: string) => void
  closeTab: (groupId: string, documentId: string) => void
  closeOtherTabs: (groupId: string, documentId: string) => void
  reopenClosedTab: () => string | null
  togglePinned: (groupId: string, documentId: string) => void
  setActiveGroup: (groupId: string) => void
  updateDocumentTitle: (documentId: string, title: string) => void
  splitGroup: (groupId: string, direction: SplitDirection, documentId?: string) => string
  closeGroup: (groupId: string) => void
  setSplitRatio: (splitId: string, ratio: number) => void
  resetLayout: () => void
}

const storageKey = 'sangam.workbench.v1'

function defaultState(): WorkbenchLayoutState {
  return createDefaultLayoutState(crypto.randomUUID())
}

function loadState(): WorkbenchLayoutState {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as
      | (Partial<WorkbenchLayoutState> & {
          sessions?: Record<string, { content?: string; baseRevisionId?: string }>
        })
      | null
    if (!value?.root || !isLayoutNode(value.root)) return defaultState()
    const legacyDrafts = Object.fromEntries(
      Object.entries(value.sessions ?? {})
        .filter(
          (entry): entry is [string, { content: string; baseRevisionId?: string }] =>
            typeof entry[1].content === 'string',
        )
        .map(([documentId, session]) => [
          documentId,
          {
            documentId,
            content: session.content,
            baseRevisionId: session.baseRevisionId,
            updatedAt: Date.now(),
          },
        ]),
    )
    if (
      Object.keys(legacyDrafts).length > 0 &&
      !localStorage.getItem('sangam.document-drafts.migration.v1')
    ) {
      localStorage.setItem('sangam.document-drafts.migration.v1', JSON.stringify(legacyDrafts))
    }
    const groups = collectGroups(value.root)
    const activeGroupId = groups.some((group) => group.id === value.activeGroupId)
      ? value.activeGroupId!
      : groups[0]!.id
    return {
      root: value.root,
      activeGroupId,
      recentlyClosed: Array.isArray(value.recentlyClosed) ? value.recentlyClosed.slice(0, 12) : [],
    }
  } catch {
    return defaultState()
  }
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null)

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(loadState)

  useEffect(() => localStorage.setItem(storageKey, JSON.stringify(state)), [state])

  const value = useMemo<WorkbenchContextValue>(
    () => ({
      ...state,
      openDocument(documentId, title, groupId) {
        setState((current) => ensureDocumentOpenInLayout(current, documentId, title, groupId))
      },
      ensureDocumentOpen(documentId, title, groupId) {
        setState((current) => ensureDocumentOpenInLayout(current, documentId, title, groupId))
      },
      activateTab(groupId, documentId) {
        setState((current) => activateTabInLayout(current, groupId, documentId))
      },
      closeTab(groupId, documentId) {
        setState((current) => closeTabInLayout(current, groupId, documentId))
      },
      closeOtherTabs(groupId, documentId) {
        setState((current) => closeOtherTabsInLayout(current, groupId, documentId))
      },
      reopenClosedTab() {
        const result = reopenClosedTabInLayout(state)
        if (result.documentId) setState(result.state)
        return result.documentId
      },
      togglePinned(groupId, documentId) {
        setState((current) => togglePinnedInLayout(current, groupId, documentId))
      },
      setActiveGroup(activeGroupId) {
        setState((current) =>
          current.activeGroupId === activeGroupId ? current : { ...current, activeGroupId },
        )
      },
      updateDocumentTitle(documentId, title) {
        setState((current) => updateDocumentTitleInLayout(current, documentId, title))
      },
      splitGroup(groupId, direction, documentId) {
        const newGroupId = crypto.randomUUID()
        const splitId = crypto.randomUUID()
        setState((current) =>
          splitGroupInLayout(current, groupId, direction, splitId, newGroupId, documentId),
        )
        return newGroupId
      },
      closeGroup(groupId) {
        setState((current) => closeGroupInLayout(current, groupId))
      },
      setSplitRatio(splitId, ratio) {
        setState((current) => setSplitRatioInLayout(current, splitId, ratio))
      },
      resetLayout() {
        const groupId = crypto.randomUUID()
        setState((current) => resetLayoutState(current, groupId))
      },
    }),
    [state],
  )

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
}

export function useWorkbench() {
  const value = useContext(WorkbenchContext)
  if (!value) throw new Error('useWorkbench must be used inside WorkbenchProvider')
  return value
}

export { collectGroups, findGroup } from './workbenchLayout'
