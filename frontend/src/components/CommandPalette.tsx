import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  Activity,
  ArchiveRestore,
  Bookmark,
  Columns2,
  Copy,
  FileText,
  FilePlus2,
  Files,
  FolderInput,
  Globe2,
  MessageSquareText,
  Pencil,
  RotateCcw,
  Rows2,
  Search,
  Settings,
  ShieldCheck,
  Tag,
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
  group: 'Documents' | 'Actions'
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
  const documents = useQuery({
    queryKey: ['documents'],
    queryFn: api.listDocuments,
    enabled: open,
  })
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
        group: 'Actions',
        run: createNewDocument,
      },
      {
        id: 'view.files',
        label: 'Show files',
        detail: 'Open the workspace explorer',
        icon: Files,
        group: 'Actions',
        run: onFiles,
      },
      {
        id: 'view.search',
        label: 'Search workspace',
        detail: 'Search content and metadata',
        icon: Search,
        group: 'Actions',
        run: onSearch,
      },
      {
        id: 'organize.moveSelected',
        label: 'Move selected item(s)…',
        detail: 'Choose a workspace destination in Files',
        icon: FolderInput,
        group: 'Actions',
        run: () => dispatchExplorerCommand(onFiles, 'sangam:explorer-move-selection'),
      },
      {
        id: 'organize.renameSelected',
        label: 'Rename selected item',
        detail: 'Rename one selected file or folder',
        icon: Pencil,
        group: 'Actions',
        run: () => dispatchExplorerCommand(onFiles, 'sangam:explorer-rename-selection'),
      },
      {
        id: 'organize.duplicateSelected',
        label: 'Duplicate selected document',
        detail: 'Create a copy of one selected document',
        icon: Copy,
        group: 'Actions',
        run: () => dispatchExplorerCommand(onFiles, 'sangam:explorer-duplicate-selection'),
      },
      {
        id: 'organize.editMetadata',
        label: 'Edit tags for selected item(s)…',
        detail: 'Apply exact existing tags and an optional category',
        icon: Tag,
        group: 'Actions',
        run: () => dispatchExplorerCommand(onFiles, 'sangam:explorer-edit-metadata'),
      },
      {
        id: 'organize.trashSelected',
        label: 'Move selected document(s) to Trash',
        detail: 'Use one guarded bulk organization operation',
        icon: Trash2,
        group: 'Actions',
        run: () => dispatchExplorerCommand(onFiles, 'sangam:explorer-trash-selection'),
      },
      {
        id: 'group.splitRight',
        label: 'Split editor right',
        detail: 'Create a group beside the active one',
        icon: Columns2,
        group: 'Actions',
        enabled: Boolean(activeDocumentId) && canSplitActiveGroup('horizontal'),
        run: () => workbench.splitGroup(workbench.activeGroupId, 'horizontal', activeDocumentId ?? undefined),
      },
      {
        id: 'group.splitDown',
        label: 'Split editor down',
        detail: 'Create a group below the active one',
        icon: Rows2,
        group: 'Actions',
        enabled: Boolean(activeDocumentId) && canSplitActiveGroup('vertical'),
        run: () => workbench.splitGroup(workbench.activeGroupId, 'vertical', activeDocumentId ?? undefined),
      },
      {
        id: 'layout.reset',
        label: 'Reset editor layout',
        detail: 'Return to one editor group',
        icon: RotateCcw,
        group: 'Actions',
        run: workbench.resetLayout,
      },
      {
        id: 'view.chat',
        label: 'Open workspace chat',
        detail: 'Ask across documents without opening one',
        icon: MessageSquareText,
        group: 'Actions',
        run: () => void navigate({ to: '/chat' }),
      },
      {
        id: 'view.publications',
        label: 'Open publications',
        detail: 'Review live and unpublished links',
        icon: Globe2,
        group: 'Actions',
        run: () => void navigate({ to: '/publications' }),
      },
      {
        id: 'view.activity',
        label: 'Open agent activity',
        detail: 'Review accepted, denied, and conflicted operations',
        icon: Activity,
        group: 'Actions',
        run: () => void navigate({ to: '/activity' }),
      },
      {
        id: 'view.karakeep',
        label: 'Open Karakeep imports',
        detail: 'Review archived bookmarks and import provenance',
        icon: Bookmark,
        group: 'Actions',
        run: () => void navigate({ to: '/karakeep' }),
      },
      {
        id: 'view.reconciliation',
        label: 'Open reconciliation',
        detail: 'Review workspace integrity',
        icon: ShieldCheck,
        group: 'Actions',
        run: () => void navigate({ to: '/reconciliation' }),
      },
      {
        id: 'view.backups',
        label: 'Open backups',
        detail: 'Create and verify recovery sets',
        icon: ArchiveRestore,
        group: 'Actions',
        run: () => void navigate({ to: '/backups' }),
      },
      {
        id: 'view.trash',
        label: 'Open trash',
        detail: 'Restore deleted documents',
        icon: Trash2,
        group: 'Actions',
        run: () => void navigate({ to: '/trash' }),
      },
      {
        id: 'view.settings',
        label: 'Open settings',
        detail: 'Configure Sangam',
        icon: Settings,
        group: 'Actions',
        run: () => void navigate({ to: '/settings' }),
      },
    ],
    [activeDocumentId, createNewDocument, navigate, onFiles, onSearch, workbench],
  )
  const actionsOnly = query.startsWith('>')
  const normalizedQuery = (actionsOnly ? query.slice(1) : query).trim().toLowerCase()
  const documentCommands = (documents.data ?? [])
    .filter((document) => `${document.title} ${document.path ?? ''}`.toLowerCase().includes(normalizedQuery))
    .slice(0, 8)
    .map<Command>((document) => ({
      id: `document.${document.document_id}`,
      label: document.title,
      detail: document.path ?? 'Unmaterialized draft',
      icon: FileText,
      group: 'Documents',
      run: () => {
        workbench.ensureDocumentOpen(document.document_id, document.title, workbench.activeGroupId)
        void navigate({
          to: '/documents/$documentId',
          params: { documentId: document.document_id },
        })
      },
    }))
  const actionCommands = commands.filter(
    (command) =>
      command.enabled !== false &&
      `${command.label} ${command.detail} ${command.id}`.toLowerCase().includes(normalizedQuery),
  )
  const results = actionsOnly ? actionCommands : [...documentCommands, ...actionCommands]
  const effectiveSelectedIndex = Math.min(selectedIndex, Math.max(0, results.length - 1))
  const selectedCommand = results[effectiveSelectedIndex]

  const openPalette = () => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
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
      // "/" jumps straight to workspace search without opening this palette.
      if (event.key === '/' && !editable) {
        event.preventDefault()
        onSearch()
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('.sidebar-search-input input')?.focus()
        })
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !editable) {
        event.preventDefault()
        createNewDocument()
      }
    }
    window.addEventListener('keydown', keyboard)
    return () => window.removeEventListener('keydown', keyboard)
  }, [createNewDocument, onSearch])

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
          <Search size="var(--icon-control)" />
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
            placeholder="Search documents or type > for actions"
            aria-label="Search workspace and actions"
            aria-controls="command-results"
            aria-activedescendant={selectedCommand ? `command-${selectedCommand.id}` : undefined}
          />
        </label>
        <div id="command-results" role="listbox" aria-label="Commands">
          {results.map((command, index) => (
            <div className="command-result" key={command.id}>
              {(index === 0 || results[index - 1]?.group !== command.group) && (
                <span className="command-group">{command.group}</span>
              )}
              <button
                id={`command-${command.id}`}
                role="option"
                aria-selected={index === effectiveSelectedIndex}
                tabIndex={-1}
                onMouseMove={() => setSelectedIndex(index)}
                onClick={() => run(command)}
              >
                <command.icon size="var(--icon-inline)" />
                <span>
                  <strong>{command.label}</strong>
                  <small>{command.detail}</small>
                </span>
              </button>
            </div>
          ))}
          {results.length === 0 && <p>No matching commands.</p>}
        </div>
        <footer>
          <kbd>↑↓</kbd> select <kbd>↵</kbd> open <kbd>&gt;</kbd> actions <kbd>esc</kbd> close
        </footer>
      </section>
    </dialog>
  )
}

function dispatchExplorerCommand(openFiles: () => void, eventName: string) {
  openFiles()
  requestAnimationFrame(() => globalThis.dispatchEvent(new Event(eventName)))
}
