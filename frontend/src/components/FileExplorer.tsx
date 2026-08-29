import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { z } from 'zod'
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
  FolderInput,
  FolderPlus,
  PanelRightOpen,
  Pencil,
  Search,
  Tag as TagIcon,
  Trash2,
} from 'lucide-react'
import { api, type DocumentSummary, type Folder, type OrganizationOperation, type Tag } from '../api'
import { preferredSplitDirection } from '../splitPolicy'
import { findGroup, useWorkbench, useWorkbenchActions } from '../workbench'
import {
  buildModifiedSortComparator,
  buildNameDescSortComparator,
  buildWorkspaceTreeAdapter,
  ensureMarkdownExtension,
  joinWorkspacePath,
  parentWorkspacePath,
  workspacePathFromTreePath,
  workspaceBasename,
  type WorkspaceTreeAdapter,
} from '../workspaceTree'

type CreateMode = { kind: 'file' | 'folder' } | null

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
  if (sort === 'name-asc') return 'Name A-Z'
  return 'Name Z-A'
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
  const [movePickerOpen, setMovePickerOpen] = useState(false)
  const [metadataPickerOpen, setMetadataPickerOpen] = useState(false)
  const [createMode, setCreateMode] = useState<CreateMode>(null)
  const [createPath, setCreatePath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pendingFocusDocumentIdRef = useRef<string | null>(null)
  const pendingSelectionRef = useRef<{ documentIds: string[]; folderIds: string[] } | null>(null)
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
    mutationFn: async ({ mode, path }: { mode: Exclude<CreateMode, null>; path: string }) => {
      if (mode.kind === 'folder') return { folder: await api.createFolder(path) }
      const documentPath = ensureMarkdownExtension(path)
      const title = workspaceBasename(documentPath).replace(/\.md$/i, '').trim() || 'Untitled document'
      return { document: await api.createDocument(title, documentPath) }
    },
    onSuccess: async (result) => {
      setCreateMode(null)
      setCreatePath('')
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

  const movePlan = useMutation({
    mutationFn: (operations: OrganizationOperation[]) => api.applyOrganizationPlan(operations),
    onSuccess: async (result) => {
      if (result.status !== 'completed') {
        const problem = result.items.find((item) => item.status !== 'completed')
        setError(problem?.message ?? 'The move did not complete.')
      } else {
        setError(null)
        setMovePickerOpen(false)
      }
      await refresh()
    },
    onError: async (cause) => {
      setError(cause instanceof Error ? cause.message : 'The selected items could not be moved.')
      await refresh()
    },
  })

  const metadataPlan = useMutation({
    mutationFn: (operations: OrganizationOperation[]) => api.applyOrganizationPlan(operations),
    onSuccess: async (result) => {
      if (result.status !== 'completed') {
        const problem = result.items.find((item) => item.status !== 'completed')
        setError(problem?.message ?? 'The metadata change did not complete.')
      } else {
        setError(null)
        setMetadataPickerOpen(false)
      }
      await refresh()
    },
    onError: async (cause) => {
      setError(cause instanceof Error ? cause.message : 'The selected metadata could not be updated.')
      await refresh()
    },
  })

  const trashPlan = useMutation({
    mutationFn: (operations: OrganizationOperation[]) => api.applyOrganizationPlan(operations),
    onSuccess: async (result) => {
      if (result.status !== 'completed') {
        const problem = result.items.find((item) => item.status !== 'completed')
        setError(problem?.message ?? 'The selected documents were not moved to Trash.')
      } else {
        setError(null)
        setSelectedTreePaths([])
      }
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ['trash'] })])
    },
    onError: async (cause) => {
      setError(cause instanceof Error ? cause.message : 'The selected documents could not be moved to Trash.')
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
      const normalizedPaths = paths.map(workspacePathFromTreePath)
      setSelectedTreePaths(normalizedPaths)
      const path = normalizedPaths.length === 1 ? normalizedPaths[0] : null
      if (path && !suppressOpenRef.current) {
        const document = adapterRef.current.documentByTreePath.get(path)
        if (document) void openDocument(document)
      }
    },
    canDrag: (paths) => {
      const normalized = paths.map(workspacePathFromTreePath)
      if (!normalized.length || normalized.includes(adapterRef.current.draftsRootPath ?? '')) return false
      const selectedFolders = normalized.filter((path) => adapterRef.current.folderByTreePath.has(path))
      const roots = normalized.filter(
        (path) => !selectedFolders.some((folder) => path !== folder && path.startsWith(`${folder}/`)),
      )
      return roots.every((path) => {
        const document = adapterRef.current.documentByTreePath.get(path)
        return document
          ? Boolean(document.path) && document.content_type !== 'application/pdf'
          : adapterRef.current.folderByTreePath.has(path)
      })
    },
    canDrop: ({ draggedPaths, target }) => {
      const targetPath = workspacePathFromTreePath(target.directoryPath)
      const normalized = draggedPaths.map(workspacePathFromTreePath)
      if (targetPath === adapterRef.current.draftsRootPath) return false
      if (targetPath && !adapterRef.current.folderByTreePath.has(targetPath)) return false
      return normalized.every((sourcePath) => {
        if (sourcePath === targetPath || parentWorkspacePath(sourcePath) === targetPath) return false
        return (
          !adapterRef.current.folderByTreePath.has(sourcePath) || !targetPath.startsWith(`${sourcePath}/`)
        )
      })
    },
    onDropComplete: ({ draggedPaths, target }) => {
      const targetPath = workspacePathFromTreePath(target.directoryPath)
      const operations = moveOperationsForPaths(
        draggedPaths.map(workspacePathFromTreePath),
        targetPath,
        adapterRef.current,
      )
      if (operations.length) {
        pendingSelectionRef.current = selectionIdentityForPaths(
          draggedPaths.map(workspacePathFromTreePath),
          adapterRef.current,
        )
        movePlan.mutate(operations)
      }
    },
    canRename: ({ isFolder, path }) =>
      isFolder
        ? path !== adapterRef.current.draftsRootPath
        : adapterRef.current.documentByTreePath.get(path)?.content_type !== 'application/pdf',
    onRename: ({ sourcePath, destinationPath }) => {
      const normalizedSource = workspacePathFromTreePath(sourcePath)
      const normalizedDestination = workspacePathFromTreePath(destinationPath)
      const document = adapterRef.current.documentByTreePath.get(normalizedSource)
      if (document) {
        rename.mutate({ document, destinationPath: normalizedDestination })
        return
      }
      const folder = adapterRef.current.folderByTreePath.get(normalizedSource)
      if (folder) {
        renameFolder.mutate({ folder, destinationPath: normalizedDestination })
        return
      }
    },
    renderRowDecoration: ({ item }) => {
      const normalizedPath = workspacePathFromTreePath(item.path)
      const folder = adapterRef.current.folderByTreePath.get(normalizedPath)
      if (folder)
        return {
          text: String(folder.document_count),
          title: `${folder.document_count} documents`,
        }
      if (normalizedPath === adapterRef.current.draftsRootPath) {
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
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: 'both',
        buttonVisibility: 'always',
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
    const preparedInput = prepareFileTreeInput(adapter.paths, {
      sort: sortComparator ?? 'default',
    })
    model.resetPaths({
      preparedInput,
      initialExpandedPaths: loadExpanded().filter(
        (path) =>
          adapter.folderByTreePath.has(workspacePathFromTreePath(path)) ||
          workspacePathFromTreePath(path) === adapter.draftsRootPath,
      ),
    })
  }, [adapter, model, sortComparator])

  useEffect(() => {
    if (!activeDocumentId) return
    const activePath = adapter.treePathByDocumentId.get(activeDocumentId)
    if (!activePath) return
    const modelSelection = model.getSelectedPaths()
    if (modelSelection.includes(activePath) && modelSelection.length > 1) return
    if (modelSelection.includes(activePath)) return
    suppressOpenRef.current = true
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect()
    model.getItem(activePath)?.select()
    model.scrollToPath(activePath, { focus: false, offset: 'nearest' })
    suppressOpenRef.current = false
  }, [activeDocumentId, adapter, model])

  useEffect(() => {
    const pending = pendingSelectionRef.current
    if (!pending) return
    const paths = [
      ...pending.documentIds.flatMap((id) => {
        const path = adapter.treePathByDocumentId.get(id)
        return path ? [path] : []
      }),
      ...pending.folderIds.flatMap((id) => {
        const entry = [...adapter.folderByTreePath.entries()].find(([, folder]) => folder.folder_id === id)
        return entry ? [entry[0]] : []
      }),
    ]
    if (paths.length !== pending.documentIds.length + pending.folderIds.length) return
    suppressOpenRef.current = true
    for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect()
    for (const path of paths) model.getItem(path)?.select()
    if (paths[0]) model.scrollToPath(paths[0], { focus: true, offset: 'nearest' })
    suppressOpenRef.current = false
    setSelectedTreePaths(paths)
    pendingSelectionRef.current = null
  }, [adapter, model])

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

  const activeTreePath = activeDocumentId ? adapter.treePathByDocumentId.get(activeDocumentId) : undefined
  const effectiveSelectedTreePaths = selectedTreePaths.length
    ? selectedTreePaths
    : activeTreePath
      ? [workspacePathFromTreePath(activeTreePath)]
      : []
  const selectedTreePath = effectiveSelectedTreePaths.length === 1 ? effectiveSelectedTreePaths[0] : null
  const selectedDocument = selectedTreePath ? adapter.documentByTreePath.get(selectedTreePath) : undefined
  const selectedFolderPath = selectedTreePath
    ? adapter.folderByTreePath.has(selectedTreePath)
      ? selectedTreePath
      : selectedDocument?.path
        ? parentWorkspacePath(selectedDocument.path)
        : ''
    : ''

  useEffect(() => {
    if (selectedTreePaths.length <= 1) return
    const collapseBulkSelection = () => {
      suppressOpenRef.current = true
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect()
      if (activeTreePath) model.getItem(activeTreePath)?.select()
      suppressOpenRef.current = false
      setSelectedTreePaths(activeTreePath ? [workspacePathFromTreePath(activeTreePath)] : [])
    }
    const dismissBulkSelection = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return
      if (
        event.target.closest(
          '[role="treeitem"], .explorer-selection-actions, .move-destination-dialog, .tree-context-menu',
        )
      )
        return
      collapseBulkSelection()
    }
    globalThis.document.addEventListener('pointerdown', dismissBulkSelection)
    return () => globalThis.document.removeEventListener('pointerdown', dismissBulkSelection)
  }, [activeTreePath, model, selectedTreePaths.length])

  const commandTargets = (itemPath: string) => {
    const normalizedPath = workspacePathFromTreePath(itemPath)
    return effectiveSelectedTreePaths.includes(normalizedPath) ? effectiveSelectedTreePaths : [normalizedPath]
  }

  const openMoveFor = (paths: readonly string[]) => {
    setSelectedTreePaths([...paths])
    if (!moveOperationsForPaths(paths, '', adapter).length) {
      setError('The selected items cannot be moved.')
      return
    }
    setMovePickerOpen(true)
  }

  const openMetadataFor = (paths: readonly string[]) => {
    setSelectedTreePaths([...paths])
    if (!metadataTargetsForPaths(paths, adapter).length) {
      setError('The selected items do not support tags or categories.')
      return
    }
    setMetadataPickerOpen(true)
  }

  const moveToTrash = (paths: readonly string[]) => {
    const operations = trashOperationsForPaths(paths, adapter)
    if (!operations.length) {
      setError('Select one or more materialized documents to move to Trash.')
      return
    }
    if (!window.confirm(`Move ${operations.length} document${operations.length === 1 ? '' : 's'} to Trash?`))
      return
    trashPlan.mutate(operations)
  }

  useEffect(() => {
    const moveSelected = () => openMoveFor(effectiveSelectedTreePaths)
    const editSelectedMetadata = () => openMetadataFor(effectiveSelectedTreePaths)
    const trashSelected = () => moveToTrash(effectiveSelectedTreePaths)
    const renameSelected = () => {
      const path = effectiveSelectedTreePaths.length === 1 ? effectiveSelectedTreePaths[0] : null
      if (path && model.getItem(path)) model.startRenaming(path)
      else setError('Select one file or folder to rename.')
    }
    const duplicateSelected = () => {
      const path = effectiveSelectedTreePaths.length === 1 ? effectiveSelectedTreePaths[0] : null
      const document = path ? adapter.documentByTreePath.get(path) : undefined
      if (document && document.content_type !== 'application/pdf') duplicate.mutate(document)
      else setError('Select one editable document to duplicate.')
    }
    globalThis.addEventListener('sangam:explorer-move-selection', moveSelected)
    globalThis.addEventListener('sangam:explorer-edit-metadata', editSelectedMetadata)
    globalThis.addEventListener('sangam:explorer-trash-selection', trashSelected)
    globalThis.addEventListener('sangam:explorer-rename-selection', renameSelected)
    globalThis.addEventListener('sangam:explorer-duplicate-selection', duplicateSelected)
    return () => {
      globalThis.removeEventListener('sangam:explorer-move-selection', moveSelected)
      globalThis.removeEventListener('sangam:explorer-edit-metadata', editSelectedMetadata)
      globalThis.removeEventListener('sangam:explorer-trash-selection', trashSelected)
      globalThis.removeEventListener('sangam:explorer-rename-selection', renameSelected)
      globalThis.removeEventListener('sangam:explorer-duplicate-selection', duplicateSelected)
    }
  })

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
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

  return (
    <div className="sidebar-content file-explorer-panel">
      <div className="sidebar-actions">
        <button
          onClick={() => {
            const initialPath = selectedFolderPath ? `${selectedFolderPath}/` : ''
            setCreateMode({ kind: 'file' })
            setCreatePath(initialPath)
          }}
        >
          <FilePlus2 size="var(--icon-inline)" /> New file
        </button>
        <button
          aria-label="New folder"
          title="New folder"
          onClick={() => {
            const initialPath = selectedFolderPath ? `${selectedFolderPath}/` : ''
            setCreateMode({ kind: 'folder' })
            setCreatePath(initialPath)
          }}
        >
          <FolderPlus size="var(--icon-page)" />
        </button>
      </div>
      {createMode && (
        <form
          className="sidebar-inline-form explorer-create"
          onSubmit={(event) => {
            event.preventDefault()
            if (createPath.trim()) create.mutate({ mode: createMode, path: createPath.trim() })
          }}
        >
          <input
            autoFocus
            aria-label={`New ${createMode.kind} path`}
            title="Workspace-relative path. Edit or remove the folder prefix to create at the workspace root."
            placeholder={createMode.kind === 'file' ? 'notes/note.md' : 'notes/archive'}
            value={createPath}
            onChange={(event) => setCreatePath(event.target.value)}
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
      {effectiveSelectedTreePaths.length > 1 && (
        <div className="explorer-selection-actions" aria-label="Selected item actions">
          <span>{effectiveSelectedTreePaths.length} selected</span>
          <button
            type="button"
            aria-label="Move selected items"
            title="Move selected items"
            onClick={() => openMoveFor(effectiveSelectedTreePaths)}
          >
            <FolderInput size="var(--icon-control)" />
          </button>
          <button
            type="button"
            aria-label="Edit selected tags and category"
            title="Edit selected tags and category"
            onClick={() => openMetadataFor(effectiveSelectedTreePaths)}
          >
            <TagIcon size="var(--icon-control)" />
          </button>
          {trashOperationsForPaths(effectiveSelectedTreePaths, adapter).length > 0 && (
            <button
              type="button"
              className="danger"
              aria-label="Move selected items to Trash"
              title="Move selected items to Trash"
              onClick={() => moveToTrash(effectiveSelectedTreePaths)}
            >
              <Trash2 size="var(--icon-control)" />
            </button>
          )}
        </div>
      )}
      {documents.isLoading && <p className="sidebar-message">Loading files…</p>}
      {documents.isError && <p className="sidebar-message error-text">Files could not be loaded.</p>}
      <div className="pierre-tree-shell">
        <PierreFileTree
          aria-label="Files"
          className="sangam-file-tree"
          model={model}
          onKeyDown={handleTreeKeyDown}
          renderContextMenu={(item, context) => (
            <ExplorerContextMenu
              adapter={adapter}
              context={context}
              item={item}
              onClose={() => context.close()}
              onCreate={(kind, parentPath) => {
                const initialPath = parentPath ? `${parentPath}/` : ''
                setCreateMode({ kind })
                setCreatePath(initialPath)
              }}
              onDuplicate={(document) => duplicate.mutate(document)}
              onOpenToSide={(document) => void openDocument(document, true)}
              onMove={() => openMoveFor(commandTargets(item.path))}
              onEditMetadata={() => openMetadataFor(commandTargets(item.path))}
              onRename={(path) => model.startRenaming(workspacePathFromTreePath(path))}
              onTrash={() => moveToTrash(commandTargets(item.path))}
            />
          )}
        />
      </div>
      {movePickerOpen && (
        <MoveDestinationDialog
          adapter={adapter}
          selectedPaths={effectiveSelectedTreePaths}
          busy={movePlan.isPending}
          onCancel={() => setMovePickerOpen(false)}
          onMove={(destination) => {
            const operations = moveOperationsForPaths(effectiveSelectedTreePaths, destination, adapter)
            if (operations.length) {
              pendingSelectionRef.current = selectionIdentityForPaths(effectiveSelectedTreePaths, adapter)
              movePlan.mutate(operations)
            }
          }}
        />
      )}
      {metadataPickerOpen && (
        <MetadataDialog
          adapter={adapter}
          availableTags={tags.data ?? []}
          selectedPaths={effectiveSelectedTreePaths}
          busy={metadataPlan.isPending}
          onCancel={() => setMetadataPickerOpen(false)}
          onApply={(tagIds, category) => {
            const operations = metadataOperationsForPaths(
              effectiveSelectedTreePaths,
              adapter,
              tagIds,
              category,
            )
            if (operations.length) metadataPlan.mutate(operations)
          }}
        />
      )}
    </div>
  )
}

function moveOperationsForPaths(
  paths: readonly string[],
  destinationFolder: string,
  adapter: WorkspaceTreeAdapter,
): OrganizationOperation[] {
  const normalizedPaths = [...new Set(paths.map(workspacePathFromTreePath))]
  const selectedFolders = normalizedPaths.filter((path) => adapter.folderByTreePath.has(path))
  const roots = normalizedPaths.filter(
    (path) => !selectedFolders.some((folder) => path !== folder && path.startsWith(`${folder}/`)),
  )
  return roots.flatMap((path): OrganizationOperation[] => {
    const document = adapter.documentByTreePath.get(path)
    if (document && document.content_type !== 'application/pdf') {
      if (!document.path) {
        return [
          {
            kind: 'materialize_document',
            document_id: document.document_id,
            expected_revision_id: document.current_revision_id,
            destination_path: joinWorkspacePath(destinationFolder, draftFilename(document)),
          },
        ]
      }
      return [
        {
          kind: 'move_document',
          document_id: document.document_id,
          expected_revision_id: document.current_revision_id,
          expected_source_path: document.path,
          destination_path: joinWorkspacePath(destinationFolder, workspaceBasename(document.path)),
        },
      ]
    }
    const folder = adapter.folderByTreePath.get(path)
    if (!folder) return []
    return [
      {
        kind: 'move_folder',
        folder_id: folder.folder_id,
        expected_source_path: folder.path,
        destination_path: joinWorkspacePath(destinationFolder, workspaceBasename(folder.path)),
        expected_descendant_documents: folder.document_count,
      },
    ]
  })
}

function draftFilename(document: DocumentSummary) {
  const basename = workspaceBasename(document.title).trim() || 'Untitled document'
  if (document.content_type === 'text/html') {
    return /\.html?$/i.test(basename) ? basename : `${basename}.html`
  }
  return ensureMarkdownExtension(basename)
}

function selectionIdentityForPaths(paths: readonly string[], adapter: WorkspaceTreeAdapter) {
  const documentIds: string[] = []
  const folderIds: string[] = []
  for (const path of new Set(paths.map(workspacePathFromTreePath))) {
    const document = adapter.documentByTreePath.get(path)
    const folder = adapter.folderByTreePath.get(path)
    if (document) documentIds.push(document.document_id)
    else if (folder) folderIds.push(folder.folder_id)
  }
  return { documentIds, folderIds }
}

type MetadataTarget = { kind: 'document'; document: DocumentSummary } | { kind: 'folder'; folder: Folder }

function metadataTargetsForPaths(paths: readonly string[], adapter: WorkspaceTreeAdapter): MetadataTarget[] {
  return [...new Set(paths.map(workspacePathFromTreePath))].flatMap((path): MetadataTarget[] => {
    const document = adapter.documentByTreePath.get(path)
    if (document) return [{ kind: 'document', document }]
    const folder = adapter.folderByTreePath.get(path)
    return folder ? [{ kind: 'folder', folder }] : []
  })
}

function metadataOperationsForPaths(
  paths: readonly string[],
  adapter: WorkspaceTreeAdapter,
  tagIds: readonly string[],
  category: { change: boolean; value: string | null },
): OrganizationOperation[] {
  const normalizedTagIds = [...new Set(tagIds)].sort()
  return metadataTargetsForPaths(paths, adapter).map((target): OrganizationOperation => {
    if (target.kind === 'document') {
      const { document } = target
      return {
        kind: 'update_document_metadata',
        document_id: document.document_id,
        expected_metadata_version: document.metadata_version,
        expected_category: document.category,
        expected_tag_ids: document.tags.map((tag) => tag.tag_id).sort(),
        category: category.change ? category.value : document.category,
        tag_ids: normalizedTagIds,
      }
    }
    const { folder } = target
    return {
      kind: 'update_folder_metadata',
      folder_id: folder.folder_id,
      expected_metadata_version: folder.metadata_version,
      expected_category: folder.category,
      expected_tag_ids: folder.tags.map((tag) => tag.tag_id).sort(),
      category: category.change ? category.value : folder.category,
      tag_ids: normalizedTagIds,
    }
  })
}

function trashOperationsForPaths(
  paths: readonly string[],
  adapter: WorkspaceTreeAdapter,
): OrganizationOperation[] {
  return [...new Set(paths.map(workspacePathFromTreePath))].flatMap((path): OrganizationOperation[] => {
    const document = adapter.documentByTreePath.get(path)
    if (!document?.path || document.content_type === 'application/pdf') return []
    return [
      {
        kind: 'trash_document',
        document_id: document.document_id,
        expected_revision_id: document.current_revision_id,
        expected_source_path: document.path,
      },
    ]
  })
}

function MetadataDialog({
  adapter,
  availableTags,
  selectedPaths,
  busy,
  onCancel,
  onApply,
}: {
  adapter: WorkspaceTreeAdapter
  availableTags: readonly Tag[]
  selectedPaths: readonly string[]
  busy: boolean
  onCancel: () => void
  onApply: (tagIds: readonly string[], category: { change: boolean; value: string | null }) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const targets = metadataTargetsForPaths(selectedPaths, adapter)
  const commonTagIds = targets.length
    ? targets
        .map((target) =>
          (target.kind === 'document' ? target.document.tags : target.folder.tags).map((tag) => tag.tag_id),
        )
        .reduce((common, ids) => common.filter((id) => ids.includes(id)))
    : []
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>(commonTagIds)
  const [changeCategory, setChangeCategory] = useState(false)
  const [category, setCategory] = useState('')
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return createPortal(
    <dialog
      ref={dialogRef}
      className="move-destination-dialog metadata-dialog"
      aria-labelledby="metadata-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault()
          onApply(selectedTagIds, {
            change: changeCategory,
            value: category.trim() || null,
          })
        }}
      >
        <header>
          <div>
            <p>Workspace metadata</p>
            <h2 id="metadata-dialog-title">
              Edit {targets.length} item{targets.length === 1 ? '' : 's'}
            </h2>
          </div>
          <button type="button" aria-label="Close metadata dialog" onClick={onCancel}>
            ×
          </button>
        </header>
        <p className="metadata-dialog-note">Selected tags become the exact tag set for every item.</p>
        <fieldset>
          <legend>Existing tags</legend>
          <div className="metadata-tag-list">
            {availableTags.map((tag) => (
              <label key={tag.tag_id}>
                <input
                  type="checkbox"
                  checked={selectedTagIds.includes(tag.tag_id)}
                  onChange={(event) =>
                    setSelectedTagIds((current) =>
                      event.target.checked
                        ? [...current, tag.tag_id]
                        : current.filter((id) => id !== tag.tag_id),
                    )
                  }
                />
                <span className="metadata-tag-swatch" style={{ backgroundColor: tag.color }} />
                {tag.name}
              </label>
            ))}
            {!availableTags.length && <p>No tags exist yet. Create tags in Workspace settings.</p>}
          </div>
        </fieldset>
        <label className="metadata-category-toggle">
          <input
            type="checkbox"
            checked={changeCategory}
            onChange={(event) => setChangeCategory(event.target.checked)}
          />
          Set one category for every selected item
        </label>
        {changeCategory && (
          <label>
            Category
            <input
              value={category}
              maxLength={120}
              placeholder="Leave blank to clear"
              onChange={(event) => setCategory(event.target.value)}
            />
          </label>
        )}
        <footer>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !targets.length}>
            {busy ? 'Applying…' : 'Apply exact metadata'}
          </button>
        </footer>
      </form>
    </dialog>,
    globalThis.document.body,
  )
}

function MoveDestinationDialog({
  adapter,
  selectedPaths,
  busy,
  onCancel,
  onMove,
}: {
  adapter: WorkspaceTreeAdapter
  selectedPaths: readonly string[]
  busy: boolean
  onCancel: () => void
  onMove: (destination: string) => void
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [query, setQuery] = useState('')
  const [destination, setDestination] = useState('')
  const selectedFolders = selectedPaths.filter((path) => adapter.folderByTreePath.has(path))
  const options = ['', ...adapter.folderByTreePath.keys()]
    .filter(
      (path) =>
        !selectedFolders.some((source) => path === source || path.startsWith(`${source}/`)) &&
        (path || 'workspace root').toLowerCase().includes(query.trim().toLowerCase()),
    )
    .sort((left, right) => left.localeCompare(right))
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    dialog.showModal()
    return () => dialog.close()
  }, [])
  return createPortal(
    <dialog
      ref={dialogRef}
      className="move-destination-dialog"
      aria-labelledby="move-destination-title"
      onCancel={(event) => {
        event.preventDefault()
        onCancel()
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault()
          onMove(destination)
        }}
      >
        <header>
          <div>
            <p>Workspace organizer</p>
            <h2 id="move-destination-title">
              Move {selectedPaths.length} item{selectedPaths.length === 1 ? '' : 's'}
            </h2>
          </div>
          <button type="button" aria-label="Close move dialog" onClick={onCancel}>
            ×
          </button>
        </header>
        <label>
          Find destination
          <input
            autoFocus
            type="search"
            value={query}
            placeholder="Search folders"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="move-destination-list" role="listbox" aria-label="Move destination">
          {options.map((path) => (
            <button
              key={path || 'workspace-root'}
              type="button"
              role="option"
              aria-selected={destination === path}
              onClick={() => setDestination(path)}
            >
              <FolderInput size="var(--icon-inline)" />
              <span>{path || 'Workspace root'}</span>
            </button>
          ))}
          {!options.length && <p>No matching destination.</p>}
        </div>
        <footer>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" disabled={busy || !options.includes(destination)}>
            {busy ? 'Moving…' : 'Move here'}
          </button>
        </footer>
      </form>
    </dialog>,
    globalThis.document.body,
  )
}

function ExplorerContextMenu({
  adapter,
  context,
  item,
  onClose,
  onCreate,
  onDuplicate,
  onEditMetadata,
  onOpenToSide,
  onMove,
  onRename,
  onTrash,
}: {
  adapter: WorkspaceTreeAdapter
  context: ContextMenuOpenContext
  item: ContextMenuItem
  onClose: () => void
  onCreate: (kind: 'file' | 'folder', parentPath: string) => void
  onDuplicate: (document: DocumentSummary) => void
  onEditMetadata: () => void
  onOpenToSide: (document: DocumentSummary) => void
  onMove: () => void
  onRename: (path: string) => void
  onTrash: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const anchorRect = context.anchorRect ?? context.anchorElement.getBoundingClientRect()
  const [position, setPosition] = useState({ top: anchorRect.bottom, left: anchorRect.left })
  const normalizedItemPath = workspacePathFromTreePath(item.path)
  const selectedDocument = adapter.documentByTreePath.get(normalizedItemPath)
  const folder = adapter.folderByTreePath.get(normalizedItemPath)

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
      if (event.target instanceof Node && menuRef.current && !menuRef.current.contains(event.target)) {
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
    const current =
      globalThis.document.activeElement instanceof HTMLElement
        ? items.indexOf(globalThis.document.activeElement)
        : -1
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
      <button type="button" role="menuitem" onClick={() => run(onMove)}>
        <FolderInput size="var(--icon-inline)" /> Move to…
      </button>
      <button type="button" role="menuitem" onClick={() => run(onEditMetadata)}>
        <TagIcon size="var(--icon-inline)" /> Edit tags and category…
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
        <button type="button" role="menuitem" onClick={() => run(onMove)}>
          <FolderInput size="var(--icon-inline)" /> Move to…
        </button>
      )}
      {selectedDocument.content_type !== 'application/pdf' && (
        <>
          <button type="button" role="menuitem" onClick={() => run(() => onRename(item.path), false)}>
            <Pencil size="var(--icon-inline)" /> Rename
          </button>
          <button type="button" role="menuitem" onClick={() => run(() => onDuplicate(selectedDocument))}>
            <Copy size="var(--icon-inline)" /> Duplicate
          </button>
          <button type="button" role="menuitem" onClick={() => run(onEditMetadata)}>
            <TagIcon size="var(--icon-inline)" /> Edit tags and category…
          </button>
          {selectedDocument.path && (
            <button className="danger" type="button" role="menuitem" onClick={() => run(onTrash)}>
              <Trash2 size="var(--icon-inline)" /> Move to trash
            </button>
          )}
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

function loadExpanded(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(expandedStorageKey) ?? '[]')
    return z.array(z.string()).safeParse(raw).data ?? []
  } catch {
    return []
  }
}
