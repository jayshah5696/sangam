import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
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
import {
  ArrowDownAZ,
  ArrowUpZA,
  Clock,
  Copy,
  FileInput,
  FilePlus2,
  FolderInput,
  FolderPlus,
  PanelRightOpen,
  Pencil,
  Search,
  Tags,
  Trash2,
  X,
} from 'lucide-react'
import { api, type BulkOrganizationResult, type DocumentSummary, type Folder, type Tag } from '../api'
import { subscribeExplorerCommands } from '../explorerCommands'
import { preferredSplitDirection } from '../splitPolicy'
import { findGroup, useWorkbench, useWorkbenchActions } from '../workbench'
import {
  buildModifiedSortComparator,
  buildNameDescSortComparator,
  buildWorkspaceTreeAdapter,
  ensureMarkdownExtension,
  joinWorkspacePath,
  parentWorkspacePath,
  toTreeDirectoryPath,
  workspaceBasename,
  workspacePathFromTreePath,
  type WorkspaceTreeAdapter,
} from '../workspaceTree'
import { StateMessage } from './ui/StateMessage'

type CreateMode = { kind: 'file' | 'folder'; parentPath: string } | null

type ExplorerTarget = {
  paths: string[]
  documents: DocumentSummary[]
  folder: Folder | null
}

type DialogRequest = {
  target: ExplorerTarget
  restoreFocus: () => void
}

type TreeCallbacks = {
  onSelectionChange: (paths: readonly string[]) => void
  ensureContextSelection: (path: string) => void
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

function targetLabel(target: ExplorerTarget) {
  if (target.folder) return target.folder.path
  if (target.documents.length === 1) return target.documents[0]!.path ?? target.documents[0]!.title
  return `${target.documents.length} documents`
}

function bulkResultMessage(result: BulkOrganizationResult) {
  const completed = result.results.filter((item) => item.status === 'completed').length
  const skipped = result.results.filter((item) => item.status === 'skipped').length
  const failed = result.results.length - completed - skipped
  if (result.status === 'completed') {
    return `${completed} completed${skipped ? `, ${skipped} already current` : ''}.`
  }
  return `${completed} completed, ${failed} conflicted or failed. Refresh and review the selected items.`
}

function resolveExplorerTarget(
  paths: readonly string[],
  adapter: WorkspaceTreeAdapter,
): ExplorerTarget | null {
  const uniquePaths = [...new Set(paths)]
  const targetDocuments = uniquePaths
    .map((path) => adapter.documentByTreePath.get(path))
    .filter((document): document is DocumentSummary => Boolean(document))
  const targetFolders = uniquePaths
    .map((path) => adapter.folderByTreePath.get(path))
    .filter((folder): folder is Folder => Boolean(folder))
  if (targetFolders.length === 1 && targetDocuments.length === 0 && uniquePaths.length === 1) {
    return { paths: uniquePaths, documents: [], folder: targetFolders[0]! }
  }
  if (targetFolders.length === 0 && targetDocuments.length === uniquePaths.length) {
    return { paths: uniquePaths, documents: targetDocuments, folder: null }
  }
  return null
}

export function FileExplorerPanel({ onSearch }: { onSearch: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const workbenchActions = useWorkbenchActions()
  const activeDocumentId = findGroup(workbench.root, workbench.activeGroupId)?.activeTabId
  const documents = useQuery({ queryKey: ['documents'], queryFn: api.listDocuments })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.listFolders })
  const tags = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const adapter = useMemo(
    () => buildWorkspaceTreeAdapter(documents.data ?? [], folders.data ?? []),
    [documents.data, folders.data],
  )
  const [selectedTreePaths, setSelectedTreePaths] = useState<string[]>([])
  const [createMode, setCreateMode] = useState<CreateMode>(null)
  const [createName, setCreateName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [moveRequest, setMoveRequest] = useState<DialogRequest | null>(null)
  const [tagRequest, setTagRequest] = useState<DialogRequest | null>(null)
  const pendingFocusDocumentIdRef = useRef<string | null>(null)
  const modelRef = useRef<ReturnType<typeof useFileTree>['model'] | null>(null)
  const isCoarsePointer =
    typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(pointer: coarse)').matches
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
    if (explorerSort === 'name-desc') return buildNameDescSortComparator()
    const timestamps = new Map<string, string>()
    for (const [treePath, document] of adapter.documentByTreePath) {
      timestamps.set(treePath, document.updated_at)
    }
    return buildModifiedSortComparator(timestamps)
  }, [explorerSort, adapter.documentByTreePath])

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['documents'] }),
      queryClient.invalidateQueries({ queryKey: ['folders'] }),
      queryClient.invalidateQueries({ queryKey: ['tags'] }),
    ])
  }

  const reportBulkResult = (result: BulkOrganizationResult) => {
    const message = bulkResultMessage(result)
    if (result.status === 'completed') {
      setNotice(message)
      setError(null)
    } else {
      setNotice(null)
      setError(message)
    }
  }

  const create = useMutation({
    mutationFn: async ({ mode, name }: { mode: Exclude<CreateMode, null>; name: string }) => {
      if (mode.kind === 'folder') {
        return { folder: await api.createFolder(joinWorkspacePath(mode.parentPath, name)) }
      }
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
      api.renameFolder(folder, workspacePathFromTreePath(destinationPath)),
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

  const move = useMutation({
    mutationFn: async ({ target, destination }: { target: ExplorerTarget; destination: string }) => {
      if (target.folder) {
        return api.renameFolder(
          target.folder,
          joinWorkspacePath(destination, workspaceBasename(target.folder.path)),
        )
      }
      return api.bulkMoveDocuments(target.documents, destination)
    },
    onSuccess: async (result) => {
      if ('operation' in result) reportBulkResult(result)
      else {
        setNotice(`Moved folder to ${result.path}.`)
        setError(null)
      }
      const request = moveRequest
      setMoveRequest(null)
      await refresh()
      request?.restoreFocus()
    },
    onError: async (cause) => {
      setError(cause instanceof Error ? cause.message : 'The selected items could not be moved.')
      await refresh()
    },
  })

  const editTags = useMutation({
    mutationFn: async ({
      target,
      addTagIds,
      removeTagIds,
      category,
      exactTagIds,
    }: {
      target: ExplorerTarget
      addTagIds: string[]
      removeTagIds: string[]
      category: string | null
      exactTagIds: string[]
    }) => {
      if (target.folder) {
        return api.updateFolderMetadata(target.folder, category, exactTagIds)
      }
      return api.bulkTagDocuments(target.documents, addTagIds, removeTagIds)
    },
    onSuccess: async (result) => {
      if ('operation' in result) reportBulkResult(result)
      else {
        setNotice(`Updated organization for ${result.path}.`)
        setError(null)
      }
      const request = tagRequest
      setTagRequest(null)
      await refresh()
      request?.restoreFocus()
    },
    onError: async (cause) => {
      setError(cause instanceof Error ? cause.message : 'The tags could not be updated.')
      await refresh()
    },
  })

  const trash = useMutation({
    mutationFn: (target: ExplorerTarget) => api.bulkTrashDocuments(target.documents),
    onSuccess: async (result) => {
      reportBulkResult(result)
      await refresh()
    },
    onError: async (cause) => {
      setError(cause instanceof Error ? cause.message : 'The documents could not be moved to Trash.')
      await refresh()
    },
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
      const nextPaths = [...paths]
      setSelectedTreePaths(nextPaths)
      if (nextPaths.length !== 1 || suppressOpenRef.current) return
      const path = nextPaths[0]!
      if (modelRef.current?.getFocusedPath() !== path) return
      const document = adapterRef.current.documentByTreePath.get(path)
      if (document) void openDocument(document)
    },
    ensureContextSelection: (path) => {
      const model = modelRef.current
      if (!model || model.getSelectedPaths().includes(path)) return
      suppressOpenRef.current = true
      for (const selectedPath of model.getSelectedPaths()) model.getItem(selectedPath)?.deselect()
      model.getItem(path)?.select()
      setSelectedTreePaths([path])
      suppressOpenRef.current = false
    },
    canDrag: (paths) => {
      const target = resolveExplorerTarget(paths, adapterRef.current)
      if (!target) return false
      if (target.folder) return true
      return target.documents.every(
        (document) => Boolean(document.path) && document.content_type !== 'application/pdf',
      )
    },
    canDrop: ({ draggedPaths, target }) => {
      const resolved = resolveExplorerTarget(draggedPaths, adapterRef.current)
      if (!resolved || target.directoryPath === adapterRef.current.draftsRootPath) return false
      if (target.directoryPath !== null && !adapterRef.current.folderByTreePath.has(target.directoryPath)) {
        return false
      }
      const destination = workspacePathFromTreePath(target.directoryPath)
      if (resolved.folder) {
        const nextPath = joinWorkspacePath(destination, workspaceBasename(resolved.folder.path))
        return nextPath !== resolved.folder.path && !nextPath.startsWith(`${resolved.folder.path}/`)
      }
      return resolved.documents.some(
        (document) => document.path && parentWorkspacePath(document.path) !== destination,
      )
    },
    onDropComplete: ({ draggedPaths, target }) => {
      const resolved = resolveExplorerTarget(draggedPaths, adapterRef.current)
      if (resolved)
        move.mutate({ target: resolved, destination: workspacePathFromTreePath(target.directoryPath) })
    },
    canRename: ({ isFolder, path }) => {
      if (!isFolder) {
        return adapterRef.current.documentByTreePath.get(path)?.content_type !== 'application/pdf'
      }
      const treePath = toTreeDirectoryPath(path)
      return (
        treePath !== adapterRef.current.draftsRootPath && adapterRef.current.folderByTreePath.has(treePath)
      )
    },
    onRename: ({ sourcePath, destinationPath }) => {
      const document = adapterRef.current.documentByTreePath.get(sourcePath)
      if (document) {
        rename.mutate({ document, destinationPath })
        return
      }
      const folder = adapterRef.current.folderByTreePath.get(toTreeDirectoryPath(sourcePath))
      if (folder) renameFolder.mutate({ folder, destinationPath })
    },
    renderRowDecoration: ({ item }) => {
      const folder = adapterRef.current.folderByTreePath.get(item.path)
      if (folder) return { text: String(folder.document_count), title: `${folder.document_count} documents` }
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

  const { model } = useFileTree({
    id: 'sangam-workspace-tree',
    paths: adapter.paths,
    density: isCoarsePointer ? 'relaxed' : 'compact',
    itemHeight: isCoarsePointer ? 48 : undefined,
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
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: 'both',
        buttonVisibility: isCoarsePointer ? 'always' : 'when-needed',
        onOpen: (item) => callbacksRef.current.ensureContextSelection(item.path),
      },
    },
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
    modelRef.current = model
    return () => {
      modelRef.current = null
    }
  }, [model])

  useEffect(() => {
    const preparedInput = prepareFileTreeInput(adapter.paths, { sort: sortComparator ?? 'default' })
    const expanded = loadExpanded()
      .map((path) =>
        adapter.folderByTreePath.has(path) || path === adapter.draftsRootPath ? path : `${path}/`,
      )
      .filter((path) => adapter.folderByTreePath.has(path) || path === adapter.draftsRootPath)
    model.resetPaths({ preparedInput, initialExpandedPaths: expanded })
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

  const selectedTarget = resolveExplorerTarget(selectedTreePaths, adapter)
  const selectedFolderPath = selectedTarget?.folder
    ? selectedTarget.folder.path
    : selectedTarget?.documents.length === 1 && selectedTarget.documents[0]?.path
      ? parentWorkspacePath(selectedTarget.documents[0].path)
      : ''

  const restoreCurrentFocus = useCallback((): (() => void) => {
    const element = globalThis.document.activeElement
    return element instanceof HTMLElement
      ? () => {
          requestAnimationFrame(() => element.focus())
        }
      : () => undefined
  }, [])
  const openMove = useCallback(
    (target: ExplorerTarget, restoreFocus = restoreCurrentFocus()) => {
      setMoveRequest({ target, restoreFocus })
    },
    [restoreCurrentFocus, setMoveRequest],
  )
  const openTags = useCallback(
    (target: ExplorerTarget, restoreFocus = restoreCurrentFocus()) => {
      setTagRequest({ target, restoreFocus })
    },
    [restoreCurrentFocus, setTagRequest],
  )
  const trashTarget = useCallback(
    (target: ExplorerTarget) => {
      if (!target.documents.length) return
      const label =
        target.documents.length === 1
          ? `“${target.documents[0]!.title}”`
          : `${target.documents.length} documents`
      if (window.confirm(`Move ${label} to Trash?`)) trash.mutate(target)
    },
    [trash],
  )

  useEffect(
    () =>
      subscribeExplorerCommands((command) => {
        const target = resolveExplorerTarget(model.getSelectedPaths(), adapter)
        if (!target) {
          setError('Select documents or one folder before running an organization command.')
          return
        }
        if (command === 'move') openMove(target)
        if (command === 'tags') openTags(target)
        if (command === 'trash') {
          if (target.documents.length) trashTarget(target)
          else setError('Folders cannot be moved to Trash.')
        }
      }),
    [adapter, model, openMove, openTags, trashTarget],
  )

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const path = model.getFocusedPath()
    const document = path ? adapterRef.current.documentByTreePath.get(path) : undefined
    if (!document) return
    event.preventDefault()
    void openDocument(document)
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
      {selectedTarget && selectedTarget.documents.length > 1 && (
        <div className="explorer-bulk-actions" role="toolbar" aria-label="Selected document actions">
          <strong>{selectedTarget.documents.length} selected</strong>
          <button type="button" aria-label="Move selected documents" onClick={() => openMove(selectedTarget)}>
            <FileInput size="var(--icon-inline)" /> Move
          </button>
          <button
            type="button"
            aria-label="Edit tags for selected documents"
            onClick={() => openTags(selectedTarget)}
          >
            <Tags size="var(--icon-inline)" /> Tags
          </button>
          <button
            className="danger"
            type="button"
            aria-label="Move selected documents to Trash"
            onClick={() => trashTarget(selectedTarget)}
          >
            <Trash2 size="var(--icon-inline)" /> Trash
          </button>
        </div>
      )}
      {notice && (
        <div className="explorer-notice" role="status">
          <span>{notice}</span>
          <button aria-label="Dismiss message" onClick={() => setNotice(null)}>
            <X size="var(--icon-inline)" />
          </button>
        </div>
      )}
      {error && (
        <div className="explorer-error" role="alert">
          <span>{error}</span>
          <button aria-label="Dismiss error" onClick={() => setError(null)}>
            <X size="var(--icon-inline)" />
          </button>
        </div>
      )}
      {documents.isLoading && <StateMessage compact kind="loading" title="Loading files" />}
      {documents.isError && (
        <StateMessage
          compact
          kind="error"
          title="Files could not be loaded"
          action={
            <button type="button" className="secondary-action" onClick={() => void documents.refetch()}>
              Retry
            </button>
          }
        />
      )}
      <div className="pierre-tree-shell">
        <PierreFileTree
          aria-label="Files"
          className="sangam-file-tree"
          model={model}
          onKeyDown={handleTreeKeyDown}
          renderContextMenu={(item, context) => {
            const selected = model.getSelectedPaths()
            const target = resolveExplorerTarget(
              selected.includes(item.path) ? selected : [item.path],
              adapter,
            )
            if (!target) return null
            return (
              <ExplorerContextMenu
                context={context}
                item={item}
                target={target}
                onCreate={(kind, parentPath) => setCreateMode({ kind, parentPath })}
                onDuplicate={(document) => duplicate.mutate(document)}
                onOpenToSide={(document) => void openDocument(document, true)}
                onMove={(restoreFocus) => openMove(target, restoreFocus)}
                onTags={(restoreFocus) => openTags(target, restoreFocus)}
                onRename={(path) => model.startRenaming(path)}
                onTrash={() => trashTarget(target)}
              />
            )
          }}
          onDoubleClick={() => {
            const path = model.getFocusedPath()
            if (path && adapterRef.current.documentByTreePath.has(path)) model.startRenaming(path)
          }}
        />
        {!documents.isLoading && adapter.paths.length === 0 && (
          <div className="explorer-empty">
            <StateMessage compact kind="empty" title="No documents yet" />
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
      {moveRequest && (
        <MoveToDialog
          request={moveRequest}
          folders={folders.data ?? []}
          busy={move.isPending}
          onCancel={() => {
            setMoveRequest(null)
            moveRequest.restoreFocus()
          }}
          onMove={(destination) => move.mutate({ target: moveRequest.target, destination })}
        />
      )}
      {tagRequest && (
        <TagEditorDialog
          request={tagRequest}
          tags={tags.data ?? []}
          busy={editTags.isPending}
          onCancel={() => {
            setTagRequest(null)
            tagRequest.restoreFocus()
          }}
          onApply={(values) => editTags.mutate({ target: tagRequest.target, ...values })}
        />
      )}
    </div>
  )
}

function ExplorerContextMenu({
  context,
  item,
  target,
  onCreate,
  onDuplicate,
  onOpenToSide,
  onMove,
  onTags,
  onRename,
  onTrash,
}: {
  context: ContextMenuOpenContext
  item: ContextMenuItem
  target: ExplorerTarget
  onCreate: (kind: 'file' | 'folder', parentPath: string) => void
  onDuplicate: (document: DocumentSummary) => void
  onOpenToSide: (document: DocumentSummary) => void
  onMove: (restoreFocus: () => void) => void
  onTags: (restoreFocus: () => void) => void
  onRename: (path: string) => void
  onTrash: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const anchorRect = context.anchorRect ?? context.anchorElement.getBoundingClientRect()
  const [position, setPosition] = useState({ top: anchorRect.bottom, left: anchorRect.left })
  const selectedDocument = target.documents.length === 1 ? target.documents[0] : null

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

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current
    if (!menu) return
    if (event.key === 'Escape') {
      event.preventDefault()
      context.close()
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
    context.close({ restoreFocus })
    action()
  }
  const transferToDialog = (open: (restoreFocus: () => void) => void) =>
    run(() => open(context.restoreFocus), false)

  return (
    <div
      ref={menuRef}
      data-file-tree-context-menu-root="true"
      className="tree-context-menu"
      role="menu"
      aria-label={`Actions for ${item.name}`}
      style={{ top: position.top, left: position.left }}
      onKeyDown={handleKeyDown}
    >
      {target.folder ? (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(() => onCreate('file', target.folder!.path))}
          >
            <FilePlus2 size="var(--icon-inline)" /> New file
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(() => onCreate('folder', target.folder!.path))}
          >
            <FolderPlus size="var(--icon-inline)" /> New folder
          </button>
          <button type="button" role="menuitem" onClick={() => transferToDialog(onMove)}>
            <FolderInput size="var(--icon-inline)" /> Move to…
          </button>
          <button type="button" role="menuitem" onClick={() => transferToDialog(onTags)}>
            <Tags size="var(--icon-inline)" /> Edit tags and category…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => run(() => requestAnimationFrame(() => onRename(item.path)), false)}
          >
            <Pencil size="var(--icon-inline)" /> Rename
          </button>
        </>
      ) : target.documents.length > 1 ? (
        <>
          <button type="button" role="menuitem" onClick={() => transferToDialog(onMove)}>
            <FileInput size="var(--icon-inline)" /> Move {target.documents.length} documents…
          </button>
          <button type="button" role="menuitem" onClick={() => transferToDialog(onTags)}>
            <Tags size="var(--icon-inline)" /> Edit tags…
          </button>
          <button className="danger" type="button" role="menuitem" onClick={() => run(onTrash)}>
            <Trash2 size="var(--icon-inline)" /> Move to Trash
          </button>
        </>
      ) : selectedDocument ? (
        <>
          <button type="button" role="menuitem" onClick={() => run(() => onOpenToSide(selectedDocument))}>
            <PanelRightOpen size="var(--icon-inline)" /> Open in split
          </button>
          {selectedDocument.path && selectedDocument.content_type !== 'application/pdf' && (
            <button type="button" role="menuitem" onClick={() => transferToDialog(onMove)}>
              <FileInput size="var(--icon-inline)" /> Move to…
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => transferToDialog(onTags)}>
            <Tags size="var(--icon-inline)" /> Edit tags…
          </button>
          {selectedDocument.content_type !== 'application/pdf' && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => run(() => requestAnimationFrame(() => onRename(item.path)), false)}
              >
                <Pencil size="var(--icon-inline)" /> Rename
              </button>
              <button type="button" role="menuitem" onClick={() => run(() => onDuplicate(selectedDocument))}>
                <Copy size="var(--icon-inline)" /> Duplicate
              </button>
            </>
          )}
          <button className="danger" type="button" role="menuitem" onClick={() => run(onTrash)}>
            <Trash2 size="var(--icon-inline)" /> Move to Trash
          </button>
        </>
      ) : null}
    </div>
  )
}

function MoveToDialog({
  request,
  folders,
  busy,
  onCancel,
  onMove,
}: {
  request: DialogRequest
  folders: Folder[]
  busy: boolean
  onCancel: () => void
  onMove: (destination: string) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [destination, setDestination] = useState('')
  const sourceFolder = request.target.folder?.path
  const options = folders.filter((folder) => {
    if (sourceFolder && (folder.path === sourceFolder || folder.path.startsWith(`${sourceFolder}/`)))
      return false
    return folder.path.toLowerCase().includes(query.trim().toLowerCase())
  })

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="organization-dialog"
      aria-labelledby="move-to-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <header>
        <div>
          <h2 id="move-to-title">Move to…</h2>
          <p>{targetLabel(request.target)}</p>
        </div>
        <button type="button" className="quiet-icon" aria-label="Close move dialog" onClick={onCancel}>
          <X size="var(--icon-control)" />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          onMove(destination)
        }}
      >
        <label>
          Find a folder
          <span className="organization-search">
            <Search size="var(--icon-control)" />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} />
          </span>
        </label>
        <div className="organization-destinations" role="radiogroup" aria-label="Destination folder">
          {!query.trim() && (
            <label>
              <input
                type="radio"
                name="destination"
                checked={destination === ''}
                onChange={() => setDestination('')}
              />
              <span>Workspace root</span>
            </label>
          )}
          {options.map((folder) => (
            <label key={folder.folder_id}>
              <input
                type="radio"
                name="destination"
                checked={destination === folder.path}
                onChange={() => setDestination(folder.path)}
              />
              <span>{folder.path}</span>
            </label>
          ))}
          {options.length === 0 && query.trim() && (
            <StateMessage compact kind="empty" title="No matching folders" />
          )}
        </div>
        <footer>
          <button type="button" className="secondary-action" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Moving…' : 'Move'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}

function TagEditorDialog({
  request,
  tags,
  busy,
  onCancel,
  onApply,
}: {
  request: DialogRequest
  tags: Tag[]
  busy: boolean
  onCancel: () => void
  onApply: (values: {
    addTagIds: string[]
    removeTagIds: string[]
    category: string | null
    exactTagIds: string[]
  }) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const folder = request.target.folder
  const [category, setCategory] = useState(folder?.category ?? '')
  const [exactTagIds, setExactTagIds] = useState(() => new Set(folder?.tags.map((tag) => tag.tag_id) ?? []))
  const [addTagIds, setAddTagIds] = useState(new Set<string>())
  const [removeTagIds, setRemoveTagIds] = useState(new Set<string>())

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  const toggle = (current: Set<string>, setCurrent: (next: Set<string>) => void, tagId: string) => {
    const next = new Set(current)
    if (next.has(tagId)) next.delete(tagId)
    else next.add(tagId)
    setCurrent(next)
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onApply({
      addTagIds: [...addTagIds],
      removeTagIds: [...removeTagIds],
      category: category.trim() || null,
      exactTagIds: [...exactTagIds],
    })
  }

  return (
    <dialog
      ref={dialogRef}
      className="organization-dialog"
      aria-labelledby="tag-editor-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <header>
        <div>
          <h2 id="tag-editor-title">{folder ? 'Edit folder organization' : 'Edit document tags'}</h2>
          <p>{targetLabel(request.target)}</p>
        </div>
        <button type="button" className="quiet-icon" aria-label="Close tag dialog" onClick={onCancel}>
          <X size="var(--icon-control)" />
        </button>
      </header>
      <form onSubmit={submit}>
        {folder && (
          <label>
            Category
            <input value={category} maxLength={120} onChange={(event) => setCategory(event.target.value)} />
          </label>
        )}
        {tags.length === 0 ? (
          <StateMessage
            compact
            kind="empty"
            title="No workspace tags"
            description="Create tags in Settings first."
          />
        ) : folder ? (
          <fieldset>
            <legend>Tags</legend>
            {tags.map((tag) => (
              <label key={tag.tag_id}>
                <input
                  type="checkbox"
                  checked={exactTagIds.has(tag.tag_id)}
                  onChange={() => toggle(exactTagIds, setExactTagIds, tag.tag_id)}
                />
                <span className="organization-tag-dot" style={{ background: tag.color }} />
                {tag.name}
              </label>
            ))}
          </fieldset>
        ) : (
          <div className="organization-tag-columns">
            <fieldset>
              <legend>Add tags</legend>
              {tags.map((tag) => (
                <label key={tag.tag_id}>
                  <input
                    type="checkbox"
                    checked={addTagIds.has(tag.tag_id)}
                    disabled={removeTagIds.has(tag.tag_id)}
                    onChange={() => toggle(addTagIds, setAddTagIds, tag.tag_id)}
                  />
                  <span className="organization-tag-dot" style={{ background: tag.color }} />
                  {tag.name}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Remove tags</legend>
              {tags.map((tag) => (
                <label key={tag.tag_id}>
                  <input
                    type="checkbox"
                    checked={removeTagIds.has(tag.tag_id)}
                    disabled={addTagIds.has(tag.tag_id)}
                    onChange={() => toggle(removeTagIds, setRemoveTagIds, tag.tag_id)}
                  />
                  <span className="organization-tag-dot" style={{ background: tag.color }} />
                  {tag.name}
                </label>
              ))}
            </fieldset>
          </div>
        )}
        <footer>
          <button type="button" className="secondary-action" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? 'Applying…' : 'Apply changes'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}

function loadExpanded(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(expandedStorageKey) ?? '[]')
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []
  } catch {
    return []
  }
}
