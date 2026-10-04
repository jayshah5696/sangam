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
  { id: 'writing', label: 'Writing', description: 'Edit beside sources and related notes' },
  { id: 'research', label: 'Research', description: 'Split editor beside research tools' },
  { id: 'review', label: 'Review', description: 'Preview beside changes and evidence' },
]

export function workspaceLayoutPatch(id: WorkspaceLayoutId): WorkspaceLayoutPatch {
  if (id === 'writing') return { editorMode: 'edit', rightVisible: true, rightTab: 'research' }
  if (id === 'research') return { editorMode: 'split', rightVisible: true, rightTab: 'research' }
  return { editorMode: 'preview', rightVisible: true, rightTab: 'history' }
}
