import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type {
  ContextMenuItem,
  ContextMenuOpenContext,
  FileTreeDropContext,
  FileTreeDropResult,
  FileTreeRenameEvent,
  FileTreeRenamingItem,
  FileTreeRowDecorationContext,
} from '@pierre/trees'
import { prepareFileTreeInput } from '@pierre/trees'
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react'
import { createPortal } from 'react-dom'
import {
  ArrowDownAZ,
  ArrowUpZA,
  Clock,
  Copy,
  FilePlus2,
  FolderPlus,
  PanelRightOpen,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react'
import { api, type DocumentSummary, type Folder } from '../api'
import { preferredSplitDirection } from '../splitPolicy'
import { findGroup, useWorkbench, useWorkbenchActions } from '../workbench'
import {
  buildModifiedSortComparator,
  buildNameDescSortComparator,
  buildWorkspaceTreeAdapter,
  ensureMarkdownExtension,
  joinWorkspacePath,
  parentWorkspacePath,
  workspaceBasename,
  type WorkspaceTreeAdapter,
} from '../workspaceTree'

type CreateMode = { kind: 'file' | 'folder'; parentPath: string } | null

type TreeCallbacks = {
  onSelectionChange: (paths: readonly string[]) => void
  canDrag: (paths: readonly string[]) => boolean
  canDrop: (event: FileTreeDropContext) => boolean
  onDropComplete: (event: FileTreeDropResult) => void
  canRename: (item: FileTreeRenamingItem) => boolean
  onRename: (event: FileTreeRenameEvent) => void
  renderRowDecoration: (context: FileTreeRowDecorationContext) => { text: string; title: string } | null
}

type ExplorerSort = 'modified' | 'name-asc' | 'name-desc'
const sortStorageKey = 'sangam.explorer.sort.v1'
const expandedStorageKey = 'sangam.explorer.expanded.v2'

function sortLabel(sort: ExplorerSort) {
  if (sort === 'modified') return 'Last modified'
  if (sort === 'name-asc') return 'Name A–Z'
  return 'Name Z–A'
}

export function FileExplorerPanel({ onSearch }: { onSearch: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const workbenchActions = useWorkbenchActions()
  const activeDocumentId = findGroup(workbench.root, workbench.activeGroupId)?.activeTabId
  const documents = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.listFolders })
  const adapter = useMemo(
    () => buildWorkspaceTreeAdapter(documents.data ?? [], folders.data ?? []),
    [documents.data, folders.data],
  )
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null)
  const [createMode, setCreateMode] = useState<CreateMode>(null)
  const [createName, setCreateName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pendingFocusDocumentIdRef = useRef<string | null>(null)
  const [explorerSort, setExplorerSort] = useState<ExplorerSort>(() => {
    try {
      const stored = localStorage.getItem(sortStorageKey)
      if (stored === 'name-asc' || stored === 'name-desc') return stored
      return 'modified'
    } catch {
      return 'modified'
    }
  })

  const sortComparator = useMemo(() => {
    if (explorerSort === 'name-asc') return undefined
    if (explorerSort === 'name-desc') {
      return buildNameDescSortComparator()
    }
    const timestamps = new Map<string, string>()
    for (const [treePath, doc] of adapter.documentByTreePath) {
      timestamps.set(treePath, doc.updated_at)
    }
    return buildModifiedSortComparator(timestamps)
  }, [explorerSort, adapter.documentByTreePath])

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['documents'] }),
      queryClient.invalidateQueries({ queryKey: ['folders'] }),
    ])
  }

  const create = useMutation({
    mutationFn: async ({ mode, name }: { mode: Exclude<CreateMode, null>; name: string }) => {
      if (mode.kind === 'folder')
        return { folder: await api.createFolder(joinWorkspacePath(mode.parentPath, name)) }
      const filename = ensureMarkdownExtension(name)
      const title = name.replace(/\.md$/i, '').trim() || 'Untitled document'
      return { document: await api.createDocument(title, joinWorkspacePath(mode.parentPath, filename)) }
    },
    onSuccess: async (result) => {
      setCreateMode(null)
      setCreateName('')
      setError(null)
      await refresh()
      if (result.document) {
        workbench.ensureDocumentOpen(
          result.document.document_id,
          result.document.title,
          workbench.activeGroupId,
        )
        await navigate({ to: '/documents/$documentId', params: { documentId: result.document.document_id } })
      }
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'The item could not be created.'),
  })

  const rename = useMutation({
    mutationFn: async ({
      document,
      destinationPath,
    }: {
      document: DocumentSummary
      destinationPath: string
    }) => {
      if (document.path) {
        const parent = parentWorkspacePath(destinationPath)
        const filename = ensureMarkdownExtension(workspaceBasename(destinationPath))
        return api.moveDocument(document, joinWorkspacePath(parent, filename))
      }
      const current = await api.getDocument(document.document_id)
      const title = workspaceBasename(destinationPath).trim() || 'Untitled document'
      return api.updateDocument(current, current.content, title)
    },
    onSuccess: async (document) => {
      pendingFocusDocumentIdRef.current = document.document_id
      setError(null)
      workbenchActions.updateDocumentTitle(document.document_id, document.title)
      await refresh()
    },
    onError: async (cause) => {
      setError(cause instanceof Error ? cause.message : 'The document could not be renamed.')
      await refresh()
    },
  })

  const renameFolder = useMutation({
    mutationFn: ({ folder, destinationPath }: { folder: Folder; destinationPath: string }) =>
      api.renameFolder(folder, destinationPath),
    onSuccess: async () => {
      setError(null)
      await refresh()
    },
    onError: async (cause) => {
      setError(cause instanceof Error ? cause.message : 'The folder could not be renamed.')
      await refresh()
    },
  })

  const duplicate = useMutation({
    mutationFn: (document: DocumentSummary) => api.duplicateDocument(document),
    onSuccess: async (created) => {
      await refresh()
      workbench.ensureDocumentOpen(created.document_id, created.title, workbench.activeGroupId)
      await navigate({ to: '/documents/$documentId', params: { documentId: created.document_id } })
    },
    onError: (cause) =>
      setError(cause instanceof Error ? cause.message : 'The document could not be duplicated.'),
  })

  const remove = useMutation({
    mutationFn: (document: DocumentSummary) => api.deleteDocument(document),
    onSuccess: refresh,
    onError: (cause) =>
      setError(cause instanceof Error ? cause.message : 'The document could not be moved to trash.'),
  })

  const move = useMutation({
    mutationFn: ({ document, folderPath }: { document: DocumentSummary; folderPath: string }) => {
      if (!document.path) throw new Error('Save this draft to the workspace before moving it.')
      return api.moveDocument(document, joinWorkspacePath(folderPath, workspaceBasename(document.path)))
    },
    onMutate: async ({ document, folderPath }) => {
      await queryClient.cancelQueries({ queryKey: ['documents'] })
      const previous = queryClient.getQueryData<DocumentSummary[]>(['documents'])
      if (document.path)
        queryClient.setQueryData<DocumentSummary[]>(['documents'], (current) =>
          current?.map((candidate) =>
            candidate.document_id === document.document_id
              ? { ...candidate, path: joinWorkspacePath(folderPath, workspaceBasename(document.path!)) }
              : candidate,
          ),
        )
      return { previous }
    },
    onError: (cause, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['documents'], context.previous)
      setError(cause instanceof Error ? cause.message : 'The document could not be moved.')
    },
    onSettled: refresh,
  })

  const openDocument = async (document: DocumentSummary, toSide = false) => {
    if (toSide) workbench.splitGroup(workbench.activeGroupId, preferredSplitDirection(), document.document_id)
    else workbench.ensureDocumentOpen(document.document_id, document.title, workbench.activeGroupId)
    await navigate({ to: '/documents/$documentId', params: { documentId: document.document_id } })
  }

  const adapterRef = useRef(adapter)
  const suppressOpenRef = useRef(false)
  const callbacks: TreeCallbacks = {
    onSelectionChange: (paths) => {
      const path = paths.at(-1) ?? null
      setSelectedTreePath(path)
      if (path && !suppressOpenRef.current) {
        const document = adapterRef.current.documentByTreePath.get(path)
        if (document) void openDocument(document)
      }
    },
    canDrag: (paths) =>
      paths.length === 1 &&
      Boolean(adapterRef.current.documentByTreePath.get(paths[0]!)?.path) &&
      adapterRef.current.documentByTreePath.get(paths[0]!)?.content_type !== 'application/pdf',
    canDrop: ({ draggedPaths, target }) =>
      draggedPaths.length === 1 &&
      target.directoryPath !== adapterRef.current.draftsRootPath &&
      (target.directoryPath === null || adapterRef.current.folderByTreePath.has(target.directoryPath)),
    onDropComplete: ({ draggedPaths, target }) => {
      const document = adapterRef.current.documentByTreePath.get(draggedPaths[0]!)
      if (document?.path) move.mutate({ document, folderPath: target.directoryPath ?? '' })
    },
    canRename: ({ isFolder, path }) =>
      isFolder
        ? path !== adapterRef.current.draftsRootPath
        : adapterRef.current.documentByTreePath.get(path)?.content_type !== 'application/pdf',
    onRename: ({ sourcePath, destinationPath }) => {
      const document = adapterRef.current.documentByTreePath.get(sourcePath)
      if (document) {
        rename.mutate({ document, destinationPath })
        return
      }
      const folder = adapterRef.current.folderByTreePath.get(sourcePath)
      if (folder) {
        renameFolder.mutate({ folder, destinationPath })
        return
      }
    },
    renderRowDecoration: ({ item }) => {
      const folder = adapterRef.current.folderByTreePath.get(item.path)
      if (folder)
        return {
          text: String(folder.document_count),
          title: `${folder.document_count} documents`,
        }
      if (item.path === adapterRef.current.draftsRootPath) {
        const count = [...adapterRef.current.documentByTreePath.values()].filter(
          (document) => !document.path,
        ).length
        return { text: String(count), title: `${count} drafts` }
      }
      return null
    },
  }
  const callbacksRef = useRef(callbacks)
  useEffect(() => {
    adapterRef.current = adapter
    callbacksRef.current = callbacks
  })

  const [activeContextMenu, setActiveContextMenu] = useState<{
    item: ContextMenuItem
    context: ContextMenuOpenContext
  } | null>(null)
  const { model } = useFileTree({
    id: 'sangam-workspace-tree',
    paths: adapter.paths,
    density: 'compact',
    icons: 'minimal',
    flattenEmptyDirectories: false,
    // Hide Pierre's MiddleTruncate and render label from aria-label (upstream: pierrecomputer/pierre#939)
    unsafeCSS: `
      [data-type="item"]:not(:has([data-item-rename-input]))
        > [data-item-section="content"] {
        display: none !important;
      }
      [data-type="item"]:not(:has([data-item-rename-input]))::after {
        content: attr(aria-label);
        min-width: 0;
        flex: 1 1 auto;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        text-align: start;
      }
      [data-item-section="decoration"],
      [data-item-section="git"],
      [data-item-section="action"] {
        order: 1;
      }
      [data-item-section="decoration"] {
        flex: 0 0 auto !important;
      }
      [data-item-section="decoration"]:empty {
        display: none !important;
      }
    `,
    initialExpansion: 'open',
    initialExpandedPaths: loadExpanded(),
    initialSelectedPaths: activeDocumentId
      ? [adapter.treePathByDocumentId.get(activeDocumentId)].filter((path): path is string => Boolean(path))
      : [],
    dragAndDrop: {
      canDrag: (paths) => callbacksRef.current.canDrag(paths),
      canDrop: (event) => callbacksRef.current.canDrop(event),
      onDropComplete: (event) => callbacksRef.current.onDropComplete(event),
      onDropError: (message) => setError(message),
    },
    renaming: {
      canRename: (item) => callbacksRef.current.canRename(item),
      onRename: (event) => callbacksRef.current.onRename(event),
      onError: (message) => setError(message),
    },
    onSelectionChange: (paths) => callbacksRef.current.onSelectionChange(paths),
    renderRowDecoration: (context) => callbacksRef.current.renderRowDecoration(context),
  })

  useEffect(() => {
    const preparedInput = prepareFileTreeInput(adapter.paths, {
      sort: sortComparator ?? 'default',
    })
    model.resetPaths({
      preparedInput,
      initialExpandedPaths: loadExpanded().filter(
        (path) => adapter.folderByTreePath.has(path) || path === adapter.draftsRootPath,
      ),
    })
  }, [adapter, model, sortComparator])

  useEffect(() => {
    if (!activeDocumentId) return
    const activePath = adapter.treePathByDocumentId.get(activeDocumentId)
    if (!activePath || model.getSelectedPaths().includes(activePath)) return
    suppressOpenRef.current = true
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect()
    model.getItem(activePath)?.select()
    model.scrollToPath(activePath, { focus: false, offset: 'nearest' })
    suppressOpenRef.current = false
  }, [activeDocumentId, adapter, model])

  useEffect(() => {
    const pendingDocumentId = pendingFocusDocumentIdRef.current
    if (!pendingDocumentId) return
    const path = adapter.treePathByDocumentId.get(pendingDocumentId)
    const item = path ? model.getItem(path) : null
    if (!path || !item) return
    suppressOpenRef.current = true
    for (const selectedPath of model.getSelectedPaths()) {
      if (selectedPath !== path) model.getItem(selectedPath)?.deselect()
    }
    if (!item.isSelected()) item.select()
    item.focus()
    model.scrollToPath(path, { focus: false, offset: 'nearest' })
    suppressOpenRef.current = false
    pendingFocusDocumentIdRef.current = null
  }, [adapter, model])

  useEffect(
    () =>
      model.subscribe(() => {
        const candidates = [...adapterRef.current.folderByTreePath.keys()]
        if (adapterRef.current.draftsRootPath) candidates.push(adapterRef.current.draftsRootPath)
        const expanded = candidates.filter((path) => {
          const item = model.getItem(path)
          return item?.isDirectory() && 'isExpanded' in item ? item.isExpanded() : false
        })
        localStorage.setItem(expandedStorageKey, JSON.stringify(expanded))
      }),
    [model],
  )

  const openContextMenu = (
    item: ContextMenuItem,
    anchorElement: HTMLElement,
    anchorRect: DOMRect | Pick<DOMRect, 'top' | 'right' | 'bottom' | 'left' | 'width' | 'height' | 'x' | 'y'>,
  ) => {
    const close = ({ restoreFocus = true }: { restoreFocus?: boolean } = {}) => {
      setActiveContextMenu(null)
      if (restoreFocus) requestAnimationFrame(() => anchorElement.focus())
    }
    setActiveContextMenu({
      item,
      context: {
        anchorElement,
        anchorRect,
        close,
        restoreFocus: () => requestAnimationFrame(() => anchorElement.focus()),
      },
    })
  }
  const itemFromPath = (path: string): ContextMenuItem | null => {
    const normalizedPath = path.endsWith('/') ? path.slice(0, -1) : path
    const folder = adapterRef.current.folderByTreePath.get(normalizedPath)
    if (folder) return { kind: 'directory', name: folder.name, path: normalizedPath }
    const document = adapterRef.current.documentByTreePath.get(normalizedPath)
    return document
      ? { kind: 'file', name: workspaceBasename(document.path ?? document.title), path: normalizedPath }
      : null
  }
  const selectedDocument = selectedTreePath ? adapter.documentByTreePath.get(selectedTreePath) : undefined
  const selectedFolderPath = selectedTreePath
    ? adapter.folderByTreePath.has(selectedTreePath)
      ? selectedTreePath
      : selectedDocument?.path
        ? parentWorkspacePath(selectedDocument.path)
        : ''
    : ''

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      const path = model.getFocusedPath()
      const item = path ? itemFromPath(path) : null
      const activeElement = event.currentTarget.shadowRoot?.activeElement
      const anchorElement = activeElement instanceof HTMLElement ? activeElement : null
      if (item && anchorElement) {
        event.preventDefault()
        openContextMenu(item, anchorElement, anchorElement.getBoundingClientRect())
      }
      return
    }
    if (event.key === 'F2') {
      const path = model.getFocusedPath()
      if (path) {
        event.preventDefault()
        model.startRenaming(path)
      }
      return
    }
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return
    const path = model.getFocusedPath()
    const document = path ? adapterRef.current.documentByTreePath.get(path) : undefined
    if (!document) return
    event.preventDefault()
    void openDocument(document)
  }

  const handleTreeContextMenu = (event: MouseEvent<HTMLElement>) => {
    const path = model.getFocusedPath()
    const item = path ? itemFromPath(path) : null
    const host = event.currentTarget as HTMLElement
    const activeElement = host.shadowRoot?.activeElement
    const anchorElement = activeElement instanceof HTMLElement ? activeElement : null
    if (!item || !anchorElement || !anchorElement.closest('[data-type="item"]')) return
    event.preventDefault()
    event.stopPropagation()
    openContextMenu(item, anchorElement, {
      top: event.clientY,
      right: event.clientX,
      bottom: event.clientY,
      left: event.clientX,
      width: 0,
      height: 0,
      x: event.clientX,
      y: event.clientY,
    })
  }

  return (
    <div className="sidebar-content file-explorer-panel">
      <div className="sidebar-actions">
        <button onClick={() => setCreateMode({ kind: 'file', parentPath: selectedFolderPath })}>
          <FilePlus2 size="var(--icon-inline)" /> New file
        </button>
        <button
          aria-label="New folder"
          title="New folder"
          onClick={() => setCreateMode({ kind: 'folder', parentPath: selectedFolderPath })}
        >
          <FolderPlus size="var(--icon-page)" />
        </button>
      </div>
      {createMode && (
        <form
          className="sidebar-inline-form explorer-create"
          onSubmit={(event) => {
            event.preventDefault()
            if (createName.trim()) create.mutate({ mode: createMode, name: createName.trim() })
          }}
        >
          <span>{createMode.parentPath || 'workspace'} /</span>
          <input
            autoFocus
            aria-label={`New ${createMode.kind} name`}
            placeholder={createMode.kind === 'file' ? 'note.md' : 'folder'}
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setCreateMode(null)
            }}
          />
          <button disabled={create.isPending}>Create</button>
        </form>
      )}
      <button className="sidebar-search-trigger" onClick={onSearch}>
        <Search size="var(--icon-control)" />
        <span>Search workspace</span>
      </button>
      <div className="sidebar-section-title">
        <span>Workspace</span>
        <span className="explorer-heading-actions">
          <button
            className="explorer-sort"
            type="button"
            aria-label={`Sort: ${sortLabel(explorerSort)}. Click to change.`}
            title={sortLabel(explorerSort)}
            onClick={() => {
              const order: ExplorerSort[] = ['modified', 'name-asc', 'name-desc']
              const next = order[(order.indexOf(explorerSort) + 1) % order.length]!
              setExplorerSort(next)
              localStorage.setItem(sortStorageKey, next)
            }}
          >
            {explorerSort === 'modified' && <Clock size="var(--icon-detail)" />}
            {explorerSort === 'name-asc' && <ArrowDownAZ size="var(--icon-detail)" />}
            {explorerSort === 'name-desc' && <ArrowUpZA size="var(--icon-detail)" />}
          </button>
          <small>{documents.data?.length ?? 0}</small>
        </span>
      </div>
      {error && (
        <div className="explorer-error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      {documents.isLoading && <p className="sidebar-message">Loading files…</p>}
      {documents.isError && <p className="sidebar-message error-text">Files could not be loaded.</p>}
      <div className="pierre-tree-shell">
        <PierreFileTree
          aria-label="Files"
          onContextMenu={handleTreeContextMenu}
          className="sangam-file-tree"
          model={model}
          onKeyDown={handleTreeKeyDown}
          onDoubleClick={() => {
            const path = model.getFocusedPath()
            if (path && adapterRef.current.documentByTreePath.has(path)) model.startRenaming(path)
          }}
        />
        {activeContextMenu && (
          <ExplorerContextMenu
            adapter={adapter}
            context={activeContextMenu.context}
            item={activeContextMenu.item}
            onClose={() => setActiveContextMenu(null)}
            onCreate={(kind, parentPath) => setCreateMode({ kind, parentPath })}
            onDuplicate={(document) => duplicate.mutate(document)}
            onOpenToSide={(document) => void openDocument(document, true)}
            onRename={(path) => model.startRenaming(path)}
            onTrash={(document) => {
              if (window.confirm(`Move “${document.title}” to trash?`)) remove.mutate(document)
            }}
          />
        )}
        {!documents.isLoading && adapter.paths.length === 0 && (
          <div className="explorer-empty">
            <p className="sidebar-message">No documents yet.</p>
            <button
              type="button"
              className="secondary-action explorer-empty-action"
              onClick={() => setCreateMode({ kind: 'file', parentPath: '' })}
            >
              <FilePlus2 size="var(--icon-inline)" /> New document
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function ExplorerContextMenu({
  adapter,
  context,
  item,
  onClose,
  onCreate,
  onDuplicate,
  onOpenToSide,
  onRename,
  onTrash,
}: {
  adapter: WorkspaceTreeAdapter
  context: ContextMenuOpenContext
  item: ContextMenuItem
  onClose: () => void
  onCreate: (kind: 'file' | 'folder', parentPath: string) => void
  onDuplicate: (document: DocumentSummary) => void
  onOpenToSide: (document: DocumentSummary) => void
  onRename: (path: string) => void
  onTrash: (document: DocumentSummary) => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const anchorRect = context.anchorRect ?? context.anchorElement.getBoundingClientRect()
  const [position, setPosition] = useState({ top: anchorRect.bottom, left: anchorRect.left })
  const selectedDocument = adapter.documentByTreePath.get(item.path)
  const folder = adapter.folderByTreePath.get(item.path)

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const edge = 8
    const gap = 4
    const rect = menu.getBoundingClientRect()
    const left = Math.min(window.innerWidth - rect.width - edge, Math.max(edge, anchorRect.left))
    const below = anchorRect.bottom + gap
    const top =
      below + rect.height <= window.innerHeight - edge
        ? below
        : Math.max(edge, anchorRect.top - rect.height - gap)
    setPosition({ top, left })
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [anchorRect.bottom, anchorRect.left, anchorRect.top])

  useEffect(() => {
    const handleClickOutside = (event: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
        context.restoreFocus()
      }
    }
    globalThis.document.addEventListener('mousedown', handleClickOutside)
    return () => globalThis.document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose, context])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current
    if (!menu) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      requestAnimationFrame(() => context.anchorElement.focus())
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')]
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(globalThis.document.activeElement as HTMLElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1 + items.length) % items.length
            : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }
  const run = (action: () => void, restoreFocus = true) => {
    onClose()
    context.close({ restoreFocus })
    action()
  }
  const menuItems = folder ? (
    <>
      <button type="button" role="menuitem" onClick={() => run(() => onCreate('file', folder.path))}>
        <FilePlus2 size="var(--icon-inline)" /> New file
      </button>
      <button type="button" role="menuitem" onClick={() => run(() => onCreate('folder', folder.path))}>
        <FolderPlus size="var(--icon-inline)" /> New folder
      </button>
      <button type="button" role="menuitem" onClick={() => run(() => onRename(item.path), false)}>
        <Pencil size="var(--icon-inline)" /> Rename
      </button>
    </>
  ) : selectedDocument ? (
    <>
      <button type="button" role="menuitem" onClick={() => run(() => onOpenToSide(selectedDocument))}>
        <PanelRightOpen size="var(--icon-inline)" /> Open in split
      </button>
      {selectedDocument.content_type !== 'application/pdf' && (
        <>
          <button type="button" role="menuitem" onClick={() => run(() => onRename(item.path), false)}>
            <Pencil size="var(--icon-inline)" /> Rename
          </button>
          <button type="button" role="menuitem" onClick={() => run(() => onDuplicate(selectedDocument))}>
            <Copy size="var(--icon-inline)" /> Duplicate
          </button>
          <button
            className="danger"
            type="button"
            role="menuitem"
            onClick={() => run(() => onTrash(selectedDocument))}
          >
            <Trash2 size="var(--icon-inline)" /> Move to trash
          </button>
        </>
      )}
    </>
  ) : null
  if (!menuItems) return null
  return createPortal(
    <div
      ref={menuRef}
      data-file-tree-context-menu-root="true"
      className="tree-context-menu"
      role="menu"
      aria-label={`Actions for ${item.name}`}
      style={{ top: position.top, left: position.left }}
      onKeyDown={handleKeyDown}
    >
      {menuItems}
    </div>,
    globalThis.document.body,
  )
}

function loadExpanded() {
  try {
    return JSON.parse(localStorage.getItem(expandedStorageKey) ?? '[]') as string[]
  } catch {
    return []
  }
}
