import { describe, expect, it } from 'vitest'
import { workspaceLayoutPresets, workspaceLayoutPatch } from './workspaceLayout'

describe('workspace layout presets', () => {
  it('offers writing, research, and review modes backed by existing preferences', () => {
    expect(workspaceLayoutPresets.map((preset) => preset.id)).toEqual(['writing', 'research', 'review'])
    expect(workspaceLayoutPatch('writing')).toEqual({
      editorMode: 'edit',
      rightVisible: false,
      rightTab: 'properties',
    })
    expect(workspaceLayoutPatch('research')).toEqual({
      editorMode: 'split',
      rightVisible: true,
      rightTab: 'research',
    })
    expect(workspaceLayoutPatch('review')).toEqual({
      editorMode: 'preview',
      rightVisible: true,
      rightTab: 'history',
    })
  })
})
