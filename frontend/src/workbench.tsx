import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { EditorSelection, EditorViewState } from './components/MarkdownEditor'

export type EditorMode = 'edit' | 'split' | 'preview'
export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'failed' | 'offline'
export type SplitDirection = 'horizontal' | 'vertical'

export type DocumentSession = {
  content?: string
  baseRevisionId?: string
  mode: EditorMode
  saveState: SaveState
  selection: EditorSelection
  viewState?: EditorViewState
  compareFrom?: string
  compareTo?: string
}

export type WorkbenchTab = {
  documentId: string
  title: string
  pinned: boolean
}

export type GroupNode = {
  kind: 'group'
  id: string
  tabs: WorkbenchTab[]
  activeTabId: string | null
}

export type SplitNode = {
  kind: 'split'
  id: string
  direction: SplitDirection
  ratio: number
  first: LayoutNode
  second: LayoutNode
}

export type LayoutNode = GroupNode | SplitNode

type ClosedTab = { tab: WorkbenchTab; groupId: string }

type WorkbenchState = {
  root: LayoutNode
  activeGroupId: string
  sessions: Record<string, DocumentSession>
  recentlyClosed: ClosedTab[]
}

type WorkbenchContextValue = WorkbenchState & {
  openDocument: (documentId: string, title?: string, groupId?: string) => void
  activateTab: (groupId: string, documentId: string) => void
  closeTab: (groupId: string, documentId: string) => void
  closeOtherTabs: (groupId: string, documentId: string) => void
  reopenClosedTab: () => string | null
  togglePinned: (groupId: string, documentId: string) => void
  setActiveGroup: (groupId: string) => void
  updateDocumentTitle: (documentId: string, title: string) => void
  updateSession: (documentId: string, patch: Partial<DocumentSession>) => void
  splitGroup: (groupId: string, direction: SplitDirection, documentId?: string) => string
  closeGroup: (groupId: string) => void
  setSplitRatio: (splitId: string, ratio: number) => void
  resetLayout: () => void
}

const storageKey = 'sangam.workbench.v1'
const initialSelection: EditorSelection = { line: 1, column: 1, selectedCharacters: 0 }

function newGroup(id = crypto.randomUUID()): GroupNode {
  return { kind: 'group', id, tabs: [], activeTabId: null }
}

function defaultState(): WorkbenchState {
  const group = newGroup()
  return { root: group, activeGroupId: group.id, sessions: {}, recentlyClosed: [] }
}

function loadState(): WorkbenchState {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<WorkbenchState> | null
    if (!value?.root || !isLayoutNode(value.root)) return defaultState()
    const groups = collectGroups(value.root)
    const activeGroupId = groups.some((group) => group.id === value.activeGroupId) ? value.activeGroupId! : groups[0]!.id
    return {
      root: value.root,
      activeGroupId,
      sessions: value.sessions ?? {},
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

  const value = useMemo<WorkbenchContextValue>(() => ({
    ...state,
    openDocument(documentId, title = 'Opening…', requestedGroupId) {
      setState((current) => {
        const existing = findGroupWithDocument(current.root, documentId)
        const active = findGroup(current.root, current.activeGroupId)
        const groupId = requestedGroupId ?? (active?.tabs.some((tab) => tab.documentId === documentId) ? active.id : existing?.id) ?? current.activeGroupId
        return {
          ...current,
          root: updateGroup(current.root, groupId, (group) => {
            const hasTab = group.tabs.some((tab) => tab.documentId === documentId)
            return {
              ...group,
              tabs: hasTab ? group.tabs : [...group.tabs, { documentId, title, pinned: false }],
              activeTabId: documentId,
            }
          }),
          activeGroupId: groupId,
        }
      })
    },
    activateTab(groupId, documentId) {
      setState((current) => ({ ...current, root: updateGroup(current.root, groupId, (group) => ({ ...group, activeTabId: documentId })), activeGroupId: groupId }))
    },
    closeTab(groupId, documentId) {
      setState((current) => {
        let closed: WorkbenchTab | undefined
        const root = updateGroup(current.root, groupId, (group) => {
          closed = group.tabs.find((tab) => tab.documentId === documentId)
          const tabs = group.tabs.filter((tab) => tab.documentId !== documentId)
          const previousIndex = group.tabs.findIndex((tab) => tab.documentId === documentId)
          const activeTabId = group.activeTabId === documentId ? tabs[Math.max(0, previousIndex - 1)]?.documentId ?? tabs[0]?.documentId ?? null : group.activeTabId
          return { ...group, tabs, activeTabId }
        })
        return { ...current, root, recentlyClosed: closed ? [{ tab: closed, groupId }, ...current.recentlyClosed].slice(0, 12) : current.recentlyClosed }
      })
    },
    closeOtherTabs(groupId, documentId) {
      setState((current) => ({ ...current, root: updateGroup(current.root, groupId, (group) => ({ ...group, tabs: group.tabs.filter((tab) => tab.documentId === documentId || tab.pinned), activeTabId: documentId })) }))
    },
    reopenClosedTab() {
      const closed = state.recentlyClosed[0]
      if (!closed) return null
      setState((current) => ({
        ...current,
        root: updateGroup(current.root, collectGroups(current.root).some((group) => group.id === closed.groupId) ? closed.groupId : current.activeGroupId, (group) => ({ ...group, tabs: group.tabs.some((tab) => tab.documentId === closed.tab.documentId) ? group.tabs : [...group.tabs, closed.tab], activeTabId: closed.tab.documentId })),
        activeGroupId: collectGroups(current.root).some((group) => group.id === closed.groupId) ? closed.groupId : current.activeGroupId,
        recentlyClosed: current.recentlyClosed.slice(1),
      }))
      return closed.tab.documentId
    },
    togglePinned(groupId, documentId) {
      setState((current) => ({ ...current, root: updateGroup(current.root, groupId, (group) => ({ ...group, tabs: group.tabs.map((tab) => tab.documentId === documentId ? { ...tab, pinned: !tab.pinned } : tab) })) }))
    },
    setActiveGroup(activeGroupId) {
      setState((current) => current.activeGroupId === activeGroupId ? current : { ...current, activeGroupId })
    },
    updateDocumentTitle(documentId, title) {
      setState((current) => {
        let changed = false
        const root = mapGroups(current.root, (group) => ({
          ...group,
          tabs: group.tabs.map((tab) => {
            if (tab.documentId !== documentId || tab.title === title) return tab
            changed = true
            return { ...tab, title }
          }),
        }))
        return changed ? { ...current, root } : current
      })
    },
    updateSession(documentId, patch) {
      setState((current) => ({
        ...current,
        sessions: {
          ...current.sessions,
          [documentId]: {
            mode: 'edit', saveState: 'saved', selection: initialSelection,
            ...current.sessions[documentId], ...patch,
          },
        },
      }))
    },
    splitGroup(groupId, direction, documentId) {
      const newGroupId = crypto.randomUUID()
      setState((current) => {
        const source = findGroup(current.root, groupId)
        const targetDocumentId = documentId ?? source?.activeTabId ?? null
        const sourceTab = source?.tabs.find((tab) => tab.documentId === targetDocumentId)
        const second = newGroup(newGroupId)
        if (targetDocumentId) {
          second.tabs = [sourceTab ?? { documentId: targetDocumentId, title: 'Opening…', pinned: false }]
          second.activeTabId = targetDocumentId
        }
        return { ...current, root: replaceNode(current.root, groupId, (node) => ({ kind: 'split', id: crypto.randomUUID(), direction, ratio: 50, first: node, second })), activeGroupId: newGroupId }
      })
      return newGroupId
    },
    closeGroup(groupId) {
      setState((current) => {
        const groups = collectGroups(current.root)
        if (groups.length === 1) return current
        const root = removeGroup(current.root, groupId) ?? newGroup()
        const remaining = collectGroups(root)
        return { ...current, root, activeGroupId: remaining[0]!.id }
      })
    },
    setSplitRatio(splitId, ratio) {
      setState((current) => {
        let changed = false
        const root = replaceNode(current.root, splitId, (node) => {
          if (node.kind !== 'split' || Math.abs(node.ratio - ratio) < .1) return node
          changed = true
          return { ...node, ratio }
        })
        return changed ? { ...current, root } : current
      })
    },
    resetLayout() {
      setState((current) => {
        const activeGroup = findGroup(current.root, current.activeGroupId) ?? collectGroups(current.root)[0]!
        const group = newGroup()
        group.tabs = activeGroup.tabs
        group.activeTabId = activeGroup.activeTabId
        return { ...current, root: group, activeGroupId: group.id }
      })
    },
  }), [state])

  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>
}

export function useWorkbench() {
  const value = useContext(WorkbenchContext)
  if (!value) throw new Error('useWorkbench must be used inside WorkbenchProvider')
  return value
}

export function findGroup(root: LayoutNode, id: string): GroupNode | null {
  if (root.kind === 'group') return root.id === id ? root : null
  return findGroup(root.first, id) ?? findGroup(root.second, id)
}

export function collectGroups(root: LayoutNode): GroupNode[] {
  return root.kind === 'group' ? [root] : [...collectGroups(root.first), ...collectGroups(root.second)]
}

function findGroupWithDocument(root: LayoutNode, documentId: string) {
  return collectGroups(root).find((group) => group.tabs.some((tab) => tab.documentId === documentId))
}

function updateGroup(root: LayoutNode, id: string, update: (group: GroupNode) => GroupNode): LayoutNode {
  return mapGroups(root, (group) => group.id === id ? update(group) : group)
}

function mapGroups(root: LayoutNode, update: (group: GroupNode) => GroupNode): LayoutNode {
  if (root.kind === 'group') return update(root)
  return { ...root, first: mapGroups(root.first, update), second: mapGroups(root.second, update) }
}

function replaceNode(root: LayoutNode, id: string, update: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (root.id === id) return update(root)
  if (root.kind === 'group') return root
  return { ...root, first: replaceNode(root.first, id, update), second: replaceNode(root.second, id, update) }
}

function removeGroup(root: LayoutNode, groupId: string): LayoutNode | null {
  if (root.kind === 'group') return root.id === groupId ? null : root
  const first = removeGroup(root.first, groupId)
  const second = removeGroup(root.second, groupId)
  if (!first) return second
  if (!second) return first
  return { ...root, first, second }
}

function isLayoutNode(value: unknown): value is LayoutNode {
  if (!value || typeof value !== 'object') return false
  const node = value as Partial<LayoutNode>
  if (node.kind === 'group') return typeof node.id === 'string' && Array.isArray(node.tabs)
  if (node.kind === 'split') return typeof node.id === 'string' && (node.direction === 'horizontal' || node.direction === 'vertical') && isLayoutNode(node.first) && isLayoutNode(node.second)
  return false
}
