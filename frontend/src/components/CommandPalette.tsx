import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Activity,
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
import { canSplitActiveGroup } from '../splitPolicy'
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
  const [selectedIndex, setSelectedIndex] = useState(0)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const activeGroup = findGroup(workbench.root, workbench.activeGroupId)
  const activeDocumentId = activeGroup?.activeTabId
  const { mutate: createNewDocument } = useMutation({
    mutationFn: () => api.createDocument('Untitled document'),
    onSuccess: async (document) => {
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      workbench.ensureDocumentOpen(document.document_id, document.title, workbench.activeGroupId)
      await navigate({ to: '/documents/$documentId', params: { documentId: document.document_id } })
    },
  })

  const commands = useMemo<Command[]>(
    () => [
      {
        id: 'file.new',
        label: 'New document',
        detail: 'Create a new draft',
        icon: FilePlus2,
        run: createNewDocument,
      },
      {
        id: 'view.files',
        label: 'Show files',
        detail: 'Open the workspace explorer',
        icon: Files,
        run: onFiles,
      },
      {
        id: 'view.search',
        label: 'Search workspace',
        detail: 'Search content and metadata',
        icon: Search,
        run: onSearch,
      },
      {
        id: 'group.splitRight',
        label: 'Split editor right',
        detail: 'Create a group beside the active one',
        icon: Columns2,
        enabled: Boolean(activeDocumentId) && canSplitActiveGroup('horizontal'),
        run: () => workbench.splitGroup(workbench.activeGroupId, 'horizontal', activeDocumentId ?? undefined),
      },
      {
        id: 'group.splitDown',
        label: 'Split editor down',
        detail: 'Create a group below the active one',
        icon: Rows2,
        enabled: Boolean(activeDocumentId) && canSplitActiveGroup('vertical'),
        run: () => workbench.splitGroup(workbench.activeGroupId, 'vertical', activeDocumentId ?? undefined),
      },
      {
        id: 'layout.reset',
        label: 'Reset editor layout',
        detail: 'Return to one editor group',
        icon: RotateCcw,
        run: workbench.resetLayout,
      },
      {
        id: 'view.activity',
        label: 'Open agent activity',
        detail: 'Review accepted, denied, and conflicted operations',
        icon: Activity,
        run: () => void navigate({ to: '/activity' }),
      },
      {
        id: 'view.reconciliation',
        label: 'Open reconciliation',
        detail: 'Review workspace integrity',
        icon: ShieldCheck,
        run: () => void navigate({ to: '/reconciliation' }),
      },
      {
        id: 'view.backups',
        label: 'Open backups',
        detail: 'Create and verify recovery sets',
        icon: ArchiveRestore,
        run: () => void navigate({ to: '/backups' }),
      },
      {
        id: 'view.trash',
        label: 'Open trash',
        detail: 'Restore deleted documents',
        icon: Trash2,
        run: () => void navigate({ to: '/trash' }),
      },
      {
        id: 'view.settings',
        label: 'Open settings',
        detail: 'Configure Sangam',
        icon: Settings,
        run: () => void navigate({ to: '/settings' }),
      },
    ],
    [activeDocumentId, createNewDocument, navigate, onFiles, onSearch, workbench],
  )
  const results = commands.filter(
    (command) =>
      command.enabled !== false &&
      `${command.label} ${command.detail} ${command.id}`.toLowerCase().includes(query.toLowerCase()),
  )
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, results.length - 1))
  const selectedCommand = results[effectiveSelectedIndex]

  const openPalette = () => {
    returnFocusRef.current = document.activeElement as HTMLElement | null
    setOpen(true)
  }
  const closePalette = () => {
    setOpen(false)
    setQuery('')
    setSelectedIndex(0)
    requestAnimationFrame(() => returnFocusRef.current?.focus())
  }

  useEffect(() => {
    const keyboard = (event: globalThis.KeyboardEvent) => {
      const editable =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        openPalette()
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !editable) {
        event.preventDefault()
        createNewDocument()
      }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [createNewDocument])

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  if (!open) return null
  const run = (command: Command) => {
    closePalette()
    command.run()
  }
  const moveSelection = (key: string) => {
    if (results.length === 0) return
    setSelectedIndex((current) => {
      if (key === 'Home') return 0
      if (key === 'End') return results.length - 1
      return key === 'ArrowDown'
        ? (current + 1) % results.length
        : (current - 1 + results.length) % results.length
    })
  }
  return (
    <dialog
      ref={dialogRef}
      className="command-dialog"
      aria-label="Command palette"
      onCancel={(event) => {
        event.preventDefault()
        closePalette()
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closePalette()
      }}
    >
      <section className="command-palette">
        <label>
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={(event) => {
              if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault()
                moveSelection(event.key)
              }
              if (event.key === 'Enter' && selectedCommand) {
                event.preventDefault()
                run(selectedCommand)
              }
            }}
            placeholder="Type a command…"
            aria-label="Command"
            aria-controls="command-results"
            aria-activedescendant={selectedCommand ? `command-${selectedCommand.id}` : undefined}
          />
        </label>
        <div id="command-results" role="listbox" aria-label="Commands">
          {results.map((command, index) => (
            <button
              key={command.id}
              id={`command-${command.id}`}
              role="option"
              aria-selected={index === effectiveSelectedIndex}
              tabIndex={-1}
              onMouseMove={() => setSelectedIndex(index)}
              onClick={() => run(command)}
            >
              <command.icon size={16} />
              <span>
                <strong>{command.label}</strong>
                <small>{command.detail}</small>
              </span>
            </button>
          ))}
          {results.length === 0 && <p>No matching commands.</p>}
        </div>
        <footer>
          <kbd>↑↓</kbd> select <kbd>↵</kbd> run <kbd>esc</kbd> close
        </footer>
      </section>
    </dialog>
  )
}
