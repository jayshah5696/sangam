import { z } from 'zod'

export type SplitDirection = 'horizontal' | 'vertical'

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
export type ClosedTab = { tab: WorkbenchTab; groupId: string }

export type WorkbenchLayoutState = {
  schemaVersion: 1
  root: LayoutNode
  activeGroupId: string
  recentlyClosed: ClosedTab[]
}

export function createGroup(
  id: string,
  tabs: WorkbenchTab[] = [],
  activeTabId: string | null = null,
): GroupNode {
  return { kind: 'group', id, tabs, activeTabId }
}

export function createDefaultLayoutState(groupId: string): WorkbenchLayoutState {
  return { schemaVersion: 1, root: createGroup(groupId), activeGroupId: groupId, recentlyClosed: [] }
}

export function ensureDocumentOpen(
  state: WorkbenchLayoutState,
  documentId: string,
  title = 'Opening…',
  requestedGroupId?: string,
): WorkbenchLayoutState {
  const existing = findGroupWithDocument(state.root, documentId)
  const active = findGroup(state.root, state.activeGroupId)
  const groupId =
    requestedGroupId ??
    (active?.tabs.some((tab) => tab.documentId === documentId) ? active.id : existing?.id) ??
    state.activeGroupId
  const target = findGroup(state.root, groupId)
  if (
    target?.activeTabId === documentId &&
    target.tabs.some((tab) => tab.documentId === documentId) &&
    state.activeGroupId === groupId
  ) {
    return state
  }
  return {
    ...state,
    root: updateGroup(state.root, groupId, (group) => {
      const hasTab = group.tabs.some((tab) => tab.documentId === documentId)
      return {
        ...group,
        tabs: hasTab ? group.tabs : [...group.tabs, { documentId, title, pinned: false }],
        activeTabId: documentId,
      }
    }),
    activeGroupId: groupId,
  }
}

export function activateTab(
  state: WorkbenchLayoutState,
  groupId: string,
  documentId: string,
): WorkbenchLayoutState {
  return {
    ...state,
    root: updateGroup(state.root, groupId, (group) => ({ ...group, activeTabId: documentId })),
    activeGroupId: groupId,
  }
}

export function closeTab(
  state: WorkbenchLayoutState,
  groupId: string,
  documentId: string,
): WorkbenchLayoutState {
  let closed: WorkbenchTab | undefined
  const root = updateGroup(state.root, groupId, (group) => {
    closed = group.tabs.find((tab) => tab.documentId === documentId)
    const tabs = group.tabs.filter((tab) => tab.documentId !== documentId)
    const previousIndex = group.tabs.findIndex((tab) => tab.documentId === documentId)
    const activeTabId =
      group.activeTabId === documentId
        ? (tabs[Math.max(0, previousIndex - 1)]?.documentId ?? tabs[0]?.documentId ?? null)
        : group.activeTabId
    return { ...group, tabs, activeTabId }
  })
  return {
    ...state,
    root,
    recentlyClosed: closed
      ? [{ tab: closed, groupId }, ...state.recentlyClosed].slice(0, 12)
      : state.recentlyClosed,
  }
}

export function closeOtherTabs(
  state: WorkbenchLayoutState,
  groupId: string,
  documentId: string,
): WorkbenchLayoutState {
  return {
    ...state,
    root: updateGroup(state.root, groupId, (group) => ({
      ...group,
      tabs: group.tabs.filter((tab) => tab.documentId === documentId || tab.pinned),
      activeTabId: documentId,
    })),
  }
}

export interface ReopenedTabResult {
  state: WorkbenchLayoutState
  documentId: string | null
}

export function reopenClosedTab(state: WorkbenchLayoutState): ReopenedTabResult {
  const closed = state.recentlyClosed[0]
  if (!closed) return { state, documentId: null }
  const targetGroupId = collectGroups(state.root).some((group) => group.id === closed.groupId)
    ? closed.groupId
    : state.activeGroupId
  return {
    state: {
      ...state,
      root: updateGroup(state.root, targetGroupId, (group) => ({
        ...group,
        tabs: group.tabs.some((tab) => tab.documentId === closed.tab.documentId)
          ? group.tabs
          : [...group.tabs, closed.tab],
        activeTabId: closed.tab.documentId,
      })),
      activeGroupId: targetGroupId,
      recentlyClosed: state.recentlyClosed.slice(1),
    },
    documentId: closed.tab.documentId,
  }
}

export function togglePinned(
  state: WorkbenchLayoutState,
  groupId: string,
  documentId: string,
): WorkbenchLayoutState {
  return {
    ...state,
    root: updateGroup(state.root, groupId, (group) => ({
      ...group,
      tabs: group.tabs.map((tab) => (tab.documentId === documentId ? { ...tab, pinned: !tab.pinned } : tab)),
    })),
  }
}

export function updateDocumentTitle(
  state: WorkbenchLayoutState,
  documentId: string,
  title: string,
): WorkbenchLayoutState {
  let changed = false
  const root = mapGroups(state.root, (group) => ({
    ...group,
    tabs: group.tabs.map((tab) => {
      if (tab.documentId !== documentId || tab.title === title) return tab
      changed = true
      return { ...tab, title }
    }),
  }))
  return changed ? { ...state, root } : state
}

export function splitGroup(
  state: WorkbenchLayoutState,
  groupId: string,
  direction: SplitDirection,
  splitId: string,
  newGroupId: string,
  documentId?: string,
): WorkbenchLayoutState {
  const source = findGroup(state.root, groupId)
  if (!source) return state
  const targetDocumentId = documentId ?? source.activeTabId
  const sourceTab = source.tabs.find((tab) => tab.documentId === targetDocumentId)
  const second = createGroup(newGroupId)
  if (targetDocumentId) {
    second.tabs = [sourceTab ?? { documentId: targetDocumentId, title: 'Opening…', pinned: false }]
    second.activeTabId = targetDocumentId
  }
  return {
    ...state,
    root: replaceNode(state.root, groupId, (node) => ({
      kind: 'split',
      id: splitId,
      direction,
      ratio: 50,
      first: node,
      second,
    })),
    activeGroupId: newGroupId,
  }
}

export function closeGroup(state: WorkbenchLayoutState, groupId: string): WorkbenchLayoutState {
  const groups = collectGroups(state.root)
  if (groups.length === 1) return state
  const root = removeGroup(state.root, groupId)
  if (!root) return state
  const remaining = collectGroups(root)
  const activeGroupId = remaining.some((group) => group.id === state.activeGroupId)
    ? state.activeGroupId
    : remaining[0]!.id
  return { ...state, root, activeGroupId }
}

export function setSplitRatio(
  state: WorkbenchLayoutState,
  splitId: string,
  ratio: number,
): WorkbenchLayoutState {
  let changed = false
  const boundedRatio = Math.max(10, Math.min(90, ratio))
  const root = replaceNode(state.root, splitId, (node) => {
    if (node.kind !== 'split' || Math.abs(node.ratio - boundedRatio) < 0.1) return node
    changed = true
    return { ...node, ratio: boundedRatio }
  })
  return changed ? { ...state, root } : state
}

export function resetLayout(state: WorkbenchLayoutState, groupId: string): WorkbenchLayoutState {
  const activeGroup = findGroup(state.root, state.activeGroupId) ?? collectGroups(state.root)[0]!
  const group = createGroup(groupId, activeGroup.tabs, activeGroup.activeTabId)
  return { ...state, root: group, activeGroupId: group.id }
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
  return mapGroups(root, (group) => (group.id === id ? update(group) : group))
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

export const workbenchTabSchema = z.object({
  documentId: z.string().min(1),
  title: z.string(),
  pinned: z.boolean(),
})

export const closedTabSchema = z.object({
  groupId: z.string(),
  tab: workbenchTabSchema,
})

export const groupNodeSchema = z.object({
  kind: z.literal('group'),
  id: z.string().min(1),
  tabs: z.array(workbenchTabSchema),
  activeTabId: z.string().nullable(),
})

export const layoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    groupNodeSchema,
    z.object({
      kind: z.literal('split'),
      id: z.string().min(1),
      direction: z.enum(['horizontal', 'vertical']),
      ratio: z.number().min(10).max(90),
      first: layoutNodeSchema,
      second: layoutNodeSchema,
    }),
  ]),
)

export const workbenchLayoutStateSchema = z.object({
  schemaVersion: z.literal(1).optional().default(1),
  root: layoutNodeSchema,
  activeGroupId: z.string(),
  recentlyClosed: z.array(closedTabSchema).optional().default([]),
})

function hasUniqueIds(node: LayoutNode, ids: Set<string>): boolean {
  if (ids.has(node.id)) return false
  ids.add(node.id)
  if (node.kind === 'group') {
    const documentIds = new Set(node.tabs.map((tab) => tab.documentId))
    if (documentIds.size !== node.tabs.length) return false
    if (node.activeTabId !== null && !documentIds.has(node.activeTabId)) return false
    return true
  }
  return hasUniqueIds(node.first, ids) && hasUniqueIds(node.second, ids)
}

export interface RawWorkbenchTab {
  documentId?: unknown
  title?: unknown
  pinned?: unknown
}

export interface RawClosedTab {
  groupId?: unknown
  tab?: RawWorkbenchTab
}

export interface RawGroupNode {
  kind?: unknown
  id?: unknown
  tabs?: RawWorkbenchTab[]
  activeTabId?: unknown
}

export interface RawSplitNode {
  kind?: unknown
  id?: unknown
  direction?: unknown
  ratio?: unknown
  first?: LayoutNodeCandidate
  second?: LayoutNodeCandidate
}

export type LayoutNodeCandidate = RawGroupNode | RawSplitNode | null | undefined

export interface WorkbenchLayoutCandidate {
  schemaVersion?: unknown
  root?: LayoutNodeCandidate
  activeGroupId?: unknown
  recentlyClosed?: RawClosedTab[]
}

export type WorkbenchLayoutStateCandidate = WorkbenchLayoutCandidate | null | undefined

export function isLayoutNode(value: LayoutNodeCandidate): value is LayoutNode {
  const result = layoutNodeSchema.safeParse(value)
  if (!result.success) return false
  return hasUniqueIds(result.data, new Set())
}

export function parseWorkbenchLayoutState(value: WorkbenchLayoutStateCandidate): WorkbenchLayoutState | null {
  const parsed = workbenchLayoutStateSchema.safeParse(value)
  if (!parsed.success) return null
  const state = parsed.data
  if (!hasUniqueIds(state.root, new Set())) return null
  const groups = collectGroups(state.root)
  if (groups.length === 0) return null
  const activeGroupId = groups.some((group) => group.id === state.activeGroupId)
    ? state.activeGroupId
    : groups[0]!.id
  const recentlyClosed = state.recentlyClosed.slice(0, 12)
  return { schemaVersion: 1, root: state.root, activeGroupId, recentlyClosed }
}
