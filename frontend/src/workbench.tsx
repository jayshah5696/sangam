import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { DebouncedStorageWriter } from './browserState/debouncedStorage'
import { workbenchStorageKey } from './browserState/legacyDraftMigration'
import {
  activateTab as activateTabInLayout,
  closeGroup as closeGroupInLayout,
  closeOtherTabs as closeOtherTabsInLayout,
  closeTab as closeTabInLayout,
  createDefaultLayoutState,
  ensureDocumentOpen as ensureDocumentOpenInLayout,
  parseWorkbenchLayoutState,
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

type WorkbenchActions = {
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

function defaultState(): WorkbenchLayoutState {
  return createDefaultLayoutState(crypto.randomUUID())
}

function loadState(): { state: WorkbenchLayoutState; recovered: boolean } {
  const raw = localStorage.getItem(workbenchStorageKey)
  if (!raw) return { state: defaultState(), recovered: false }
  try {
    const state = parseWorkbenchLayoutState(JSON.parse(raw) as unknown)
    return state ? { state, recovered: false } : { state: defaultState(), recovered: true }
  } catch {
    return { state: defaultState(), recovered: true }
  }
}

const WorkbenchStateContext = createContext<WorkbenchLayoutState | null>(null)
const WorkbenchActionsContext = createContext<WorkbenchActions | null>(null)
const WorkbenchRecoveryContext = createContext<{
  recovered: boolean
  dismiss: () => void
} | null>(null)

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [initialState] = useState(loadState)
  const [state, setState] = useState(initialState.state)
  const [recovered, setRecovered] = useState(initialState.recovered)
  const [storageWriter] = useState(
    () => new DebouncedStorageWriter<WorkbenchLayoutState>(localStorage, workbenchStorageKey),
  )

  useEffect(() => storageWriter.schedule(state), [state, storageWriter])
  useEffect(() => {
    const flush = () => storageWriter.flush()
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flushWhenHidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flushWhenHidden)
      storageWriter.dispose()
    }
  }, [storageWriter])

  const ensureDocumentOpen = useCallback((documentId: string, title?: string, groupId?: string) => {
    setState((current) => ensureDocumentOpenInLayout(current, documentId, title, groupId))
  }, [])
  const activateTab = useCallback((groupId: string, documentId: string) => {
    setState((current) => activateTabInLayout(current, groupId, documentId))
  }, [])
  const closeTab = useCallback((groupId: string, documentId: string) => {
    setState((current) => closeTabInLayout(current, groupId, documentId))
  }, [])
  const closeOtherTabs = useCallback((groupId: string, documentId: string) => {
    setState((current) => closeOtherTabsInLayout(current, groupId, documentId))
  }, [])
  const reopenClosedTab = useCallback(() => {
    const result = reopenClosedTabInLayout(state)
    if (result.documentId) setState(result.state)
    return result.documentId
  }, [state])
  const togglePinned = useCallback((groupId: string, documentId: string) => {
    setState((current) => togglePinnedInLayout(current, groupId, documentId))
  }, [])
  const setActiveGroup = useCallback((activeGroupId: string) => {
    setState((current) => (current.activeGroupId === activeGroupId ? current : { ...current, activeGroupId }))
  }, [])
  const updateDocumentTitle = useCallback((documentId: string, title: string) => {
    setState((current) => updateDocumentTitleInLayout(current, documentId, title))
  }, [])
  const splitGroup = useCallback((groupId: string, direction: SplitDirection, documentId?: string) => {
    const newGroupId = crypto.randomUUID()
    const splitId = crypto.randomUUID()
    setState((current) => splitGroupInLayout(current, groupId, direction, splitId, newGroupId, documentId))
    return newGroupId
  }, [])
  const closeGroup = useCallback((groupId: string) => {
    setState((current) => closeGroupInLayout(current, groupId))
  }, [])
  const setSplitRatio = useCallback((splitId: string, ratio: number) => {
    setState((current) => setSplitRatioInLayout(current, splitId, ratio))
  }, [])
  const resetLayout = useCallback(() => {
    const groupId = crypto.randomUUID()
    setState((current) => resetLayoutState(current, groupId))
  }, [])

  const actions = useMemo<WorkbenchActions>(
    () => ({
      ensureDocumentOpen,
      activateTab,
      closeTab,
      closeOtherTabs,
      reopenClosedTab,
      togglePinned,
      setActiveGroup,
      updateDocumentTitle,
      splitGroup,
      closeGroup,
      setSplitRatio,
      resetLayout,
    }),
    [
      activateTab,
      closeGroup,
      closeOtherTabs,
      closeTab,
      ensureDocumentOpen,
      reopenClosedTab,
      resetLayout,
      setActiveGroup,
      setSplitRatio,
      splitGroup,
      togglePinned,
      updateDocumentTitle,
    ],
  )

  return (
    <WorkbenchStateContext.Provider value={state}>
      <WorkbenchActionsContext.Provider value={actions}>
        <WorkbenchRecoveryContext.Provider value={{ recovered, dismiss: () => setRecovered(false) }}>
          {children}
        </WorkbenchRecoveryContext.Provider>
      </WorkbenchActionsContext.Provider>
    </WorkbenchStateContext.Provider>
  )
}

export function useWorkbench() {
  const state = useContext(WorkbenchStateContext)
  const actions = useContext(WorkbenchActionsContext)
  if (!state || !actions) throw new Error('useWorkbench must be used inside WorkbenchProvider')
  return { ...state, ...actions }
}

export function useWorkbenchActions() {
  const actions = useContext(WorkbenchActionsContext)
  if (!actions) throw new Error('useWorkbenchActions must be used inside WorkbenchProvider')
  return actions
}

export function useWorkbenchRecovery() {
  const recovery = useContext(WorkbenchRecoveryContext)
  if (!recovery) throw new Error('useWorkbenchRecovery must be used inside WorkbenchProvider')
  return recovery
}

export { collectGroups, findGroup } from './workbenchLayout'
