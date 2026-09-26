import type { Document } from './api'
import type { EditorMode, SaveState } from './documentSessions'

export function initialDocumentMode(document: Document, preferredMode: EditorMode): EditorMode {
  return document.path === null && document.content.trim().length === 0 ? 'edit' : preferredMode
}

export function saveLabel(state: SaveState, materialized: boolean): string {
  if (state === 'saved') return materialized ? 'Saved' : 'Saved draft'
  if (state === 'offline') return materialized ? 'Offline · unsaved' : 'Offline · draft saved locally'
  return {
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    conflict: 'Conflict needs review',
    failed: 'Save failed',
  }[state]
}

export function materializePath(folder: string, filename: string): string {
  const normalizedFolder = folder.trim().replace(/^\/+|\/+$/g, '')
  const normalizedFilename = filename.trim().replace(/^\/+/, '')
  return normalizedFolder ? `${normalizedFolder}/${normalizedFilename}` : normalizedFilename
}
