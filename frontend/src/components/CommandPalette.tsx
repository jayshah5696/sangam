import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArchiveRestore,
  Columns2,
  FilePlus2,
  Files,
  RotateCcw,
  Rows2,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { api } from '../api'
import { findGroup, useWorkbench } from '../workbench'

type Command = {
  id: string
  label: string
  detail: string
  icon: typeof Files
  run: () => void
  enabled?: boolean
}

export function CommandPalette({ onFiles, onSearch }: { onFiles: () => void; onSearch: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const activeGroup = findGroup(workbench.root, workbench.activeGroupId)
  const activeDocumentId = activeGroup?.activeTabId
  const createDocument = useMutation({
    mutationFn: () => api.createDocument('Untitled document'),
    onSuccess: async (document) => {
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      workbench.openDocument(document.document_id, document.title, workbench.activeGroupId)
      await navigate({ to: '/documents/$documentId', params: { documentId: document.document_id } })
    },
  })
  const commands = useMemo<Command[]>(() => [
    { id: 'file.new', label: 'New document', detail: 'Create a new draft', icon: FilePlus2, run: () => createDocument.mutate() },
    { id: 'view.files', label: 'Show files', detail: 'Open the workspace explorer', icon: Files, run: onFiles },
    { id: 'view.search', label: 'Search workspace', detail: 'Search content and metadata', icon: Search, run: onSearch },
    { id: 'group.splitRight', label: 'Split editor right', detail: 'Create a group beside the active one', icon: Columns2, enabled: Boolean(activeDocumentId), run: () => workbench.splitGroup(workbench.activeGroupId, 'horizontal', activeDocumentId ?? undefined) },
    { id: 'group.splitDown', label: 'Split editor down', detail: 'Create a group below the active one', icon: Rows2, enabled: Boolean(activeDocumentId), run: () => workbench.splitGroup(workbench.activeGroupId, 'vertical', activeDocumentId ?? undefined) },
    { id: 'layout.reset', label: 'Reset editor layout', detail: 'Return to one editor group', icon: RotateCcw, run: workbench.resetLayout },
    { id: 'view.reconciliation', label: 'Open reconciliation', detail: 'Review workspace integrity', icon: ShieldCheck, run: () => void navigate({ to: '/reconciliation' }) },
    { id: 'view.backups', label: 'Open backups', detail: 'Create and verify recovery sets', icon: ArchiveRestore, run: () => void navigate({ to: '/backups' }) },
    { id: 'view.trash', label: 'Open trash', detail: 'Restore deleted documents', icon: Trash2, run: () => void navigate({ to: '/trash' }) },
    { id: 'view.settings', label: 'Open settings', detail: 'Configure Sangam', icon: Settings, run: () => void navigate({ to: '/settings/appearance' }) },
  ], [activeDocumentId, createDocument, navigate, onFiles, onSearch, workbench])
  const results = commands.filter((command) => command.enabled !== false
    && `${command.label} ${command.detail} ${command.id}`.toLowerCase().includes(query.toLowerCase()))

  useEffect(() => {
    const keyboard = (event: globalThis.KeyboardEvent) => {
      const editable = event.target instanceof HTMLInputElement
        || event.target instanceof HTMLTextAreaElement
        || (event.target instanceof HTMLElement && event.target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen(true)
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !editable) {
        event.preventDefault()
        createDocument.mutate()
      }
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [createDocument])

  useEffect(() => { if (open) requestAnimationFrame(() => inputRef.current?.focus()) }, [open])

  if (!open) return null
  const run = (command: Command) => {
    setOpen(false)
    setQuery('')
    command.run()
  }
  return (
    <div className="command-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false) }}>
      <section className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <label><Search size={17} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && results[0]) run(results[0]) }} placeholder="Type a command…" aria-label="Command" /></label>
        <div role="listbox" aria-label="Commands">
          {results.map((command) => <button key={command.id} role="option" onClick={() => run(command)}><command.icon size={16} /><span><strong>{command.label}</strong><small>{command.detail}</small></span></button>)}
          {results.length === 0 && <p>No matching commands.</p>}
        </div>
        <footer><kbd>↵</kbd> run <kbd>esc</kbd> close</footer>
      </section>
    </div>
  )
}
