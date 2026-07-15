import { describe, expect, it } from 'vitest'
import {
  closeGroup,
  closeTab,
  collectGroups,
  createDefaultLayoutState,
  ensureDocumentOpen,
  reopenClosedTab,
  resetLayout,
  setSplitRatio,
  splitGroup,
} from './workbenchLayout'

describe('workbench layout', () => {
  it('starts with one group and only adds splits when requested', () => {
    const initial = createDefaultLayoutState('group-1')
    expect(collectGroups(initial.root)).toHaveLength(1)

    const opened = ensureDocumentOpen(initial, 'doc-1', 'First')
    const split = splitGroup(opened, 'group-1', 'horizontal', 'split-1', 'group-2')
    expect(collectGroups(split.root).map((group) => group.id)).toEqual(['group-1', 'group-2'])
    expect(split.root).toMatchObject({ kind: 'split', id: 'split-1', direction: 'horizontal', ratio: 50 })
    expect(split.activeGroupId).toBe('group-2')
  })

  it('uses caller-provided IDs and leaves the source state untouched', () => {
    const initial = ensureDocumentOpen(createDefaultLayoutState('group-1'), 'doc-1', 'First')
    const split = splitGroup(initial, 'group-1', 'vertical', 'split-fixed', 'group-fixed')
    expect(initial.root.kind).toBe('group')
    expect(split.root.id).toBe('split-fixed')
    expect(collectGroups(split.root)[1]?.id).toBe('group-fixed')
  })

  it('closes groups, bounds ratios, resets, and reopens the last closed tab', () => {
    let state = ensureDocumentOpen(createDefaultLayoutState('group-1'), 'doc-1', 'First')
    state = splitGroup(state, 'group-1', 'horizontal', 'split-1', 'group-2')
    state = setSplitRatio(state, 'split-1', 99)
    expect(state.root).toMatchObject({ kind: 'split', ratio: 90 })

    state = closeGroup(state, 'group-2')
    expect(collectGroups(state.root)).toHaveLength(1)
    state = closeTab(state, 'group-1', 'doc-1')
    const reopened = reopenClosedTab(state)
    expect(reopened.documentId).toBe('doc-1')
    expect(collectGroups(reopened.state.root)[0]?.activeTabId).toBe('doc-1')

    const reset = resetLayout(reopened.state, 'group-reset')
    expect(reset.root).toMatchObject({ kind: 'group', id: 'group-reset' })
  })
})
