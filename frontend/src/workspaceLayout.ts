import type { EditorMode } from './documentSessions'
import type { InspectorTab } from './theme'

export type WorkspaceLayoutId = 'writing' | 'research' | 'review'

export type WorkspaceLayoutPreset = {
  id: WorkspaceLayoutId
  label: string
  description: string
}

type WorkspaceLayoutPatch = {
  editorMode: EditorMode
  rightVisible: boolean
  rightTab: InspectorTab
}

export const workspaceLayoutPresets: WorkspaceLayoutPreset[] = [
  { id: 'writing', label: 'Writing', description: 'Focus on the editor' },
  { id: 'research', label: 'Research', description: 'Edit beside research tools' },
  { id: 'review', label: 'Review', description: 'Preview with revision history' },
]

export function workspaceLayoutPatch(id: WorkspaceLayoutId): WorkspaceLayoutPatch {
  if (id === 'writing') return { editorMode: 'edit', rightVisible: false, rightTab: 'properties' }
  if (id === 'research') return { editorMode: 'split', rightVisible: true, rightTab: 'research' }
  return { editorMode: 'preview', rightVisible: true, rightTab: 'history' }
}
