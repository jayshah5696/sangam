import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
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
import { FileTree as PierreFileTree, useFileTree } from '@pierre/trees/react'
import { Copy, FilePlus2, FolderPlus, PanelRightOpen, Pencil, Search, Trash2 } from 'lucide-react'
import { api, type DocumentSummary } from '../api'
import { preferredSplitDirection } from '../splitPolicy'
import { findGroup, useWorkbench } from '../workbench'
import {
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

const expandedStorageKey = 'sangam.explorer.expanded.v2'

export function FileExplorerPanel({ onSearch }: { onSearch: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const activeDocumentId = findGroup(workbench.root, workbench.activeGroupId)?.activeTabId
  const documents = useQuery({ queryKey: ['documents', 'explorer'], queryFn: api.listDocuments })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.listFolders })
  const adapter = useMemo(
    () => buildWorkspaceTreeAdapter(documents.data ?? [], folders.data ?? []),
    [documents.data, folders.data],
  )
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null)
  const [createMode, setCreateMode] = useState<CreateMode>(null)
  const [createName, setCreateName] = useState('')
  const [error, setError] = useState<string | null>(null)

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
    onSuccess: async () => {
      setError(null)
      await refresh()
    },
    onError: async (cause) => {
      setError(cause instanceof Error ? cause.message : 'The document could not be renamed.')
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
      await queryClient.cancelQueries({ queryKey: ['documents', 'explorer'] })
      const previous = queryClient.getQueryData<DocumentSummary[]>(['documents', 'explorer'])
      if (document.path)
        queryClient.setQueryData<DocumentSummary[]>(['documents', 'explorer'], (current) =>
          current?.map((candidate) =>
            candidate.document_id === document.document_id
              ? { ...candidate, path: joinWorkspacePath(folderPath, workspaceBasename(document.path!)) }
              : candidate,
          ),
        )
      return { previous }
    },
    onError: (cause, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['documents', 'explorer'], context.previous)
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
  const callbacksRef = useRef<TreeCallbacks | null>(null)
  const suppressOpenRef = useRef(false)
  useEffect(() => {
    adapterRef.current = adapter
    callbacksRef.current = {
      onSelectionChange: (paths) => {
        const path = paths.at(-1) ?? null
        setSelectedTreePath(path)
        if (path && !suppressOpenRef.current) {
          const document = adapterRef.current.documentByTreePath.get(path)
          if (document) void openDocument(document)
        }
      },
      canDrag: (paths) =>
        paths.length === 1 && Boolean(adapterRef.current.documentByTreePath.get(paths[0]!)?.path),
      canDrop: ({ draggedPaths, target }) =>
        draggedPaths.length === 1 &&
        target.directoryPath !== adapterRef.current.draftsRootPath &&
        (target.directoryPath === null || adapterRef.current.folderByTreePath.has(target.directoryPath)),
      onDropComplete: ({ draggedPaths, target }) => {
        const document = adapterRef.current.documentByTreePath.get(draggedPaths[0]!)
        if (document?.path) move.mutate({ document, folderPath: target.directoryPath ?? '' })
      },
      canRename: ({ isFolder, path }) => !isFolder && adapterRef.current.documentByTreePath.has(path),
      onRename: ({ sourcePath, destinationPath }) => {
        const document = adapterRef.current.documentByTreePath.get(sourcePath)
        if (document) rename.mutate({ document, destinationPath })
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
  })

  const { model } = useFileTree({
    id: 'sangam-workspace-tree',
    paths: adapter.paths,
    density: 'compact',
    icons: 'minimal',
    initialExpansion: 'closed',
    initialExpandedPaths: loadExpanded(),
    initialSelectedPaths: activeDocumentId
      ? [adapter.treePathByDocumentId.get(activeDocumentId)].filter((path): path is string => Boolean(path))
      : [],
    composition: {
      contextMenu: { enabled: true, triggerMode: 'both', buttonVisibility: 'when-needed' },
    },
    dragAndDrop: {
      canDrag: (paths) => callbacksRef.current?.canDrag(paths) ?? false,
      canDrop: (event) => callbacksRef.current?.canDrop(event) ?? false,
      onDropComplete: (event) => callbacksRef.current?.onDropComplete(event),
      onDropError: (message) => setError(message),
    },
    renaming: {
      canRename: (item) => callbacksRef.current?.canRename(item) ?? false,
      onRename: (event) => callbacksRef.current?.onRename(event),
      onError: (message) => setError(message),
    },
    onSelectionChange: (paths) => callbacksRef.current?.onSelectionChange(paths),
    renderRowDecoration: (context) => callbacksRef.current?.renderRowDecoration(context) ?? null,
  })

  useEffect(() => {
    model.resetPaths(adapter.paths, {
      initialExpandedPaths: loadExpanded().filter(
        (path) => adapter.folderByTreePath.has(path) || path === adapter.draftsRootPath,
      ),
    })
  }, [adapter, model])

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

  const selectedDocument = selectedTreePath ? adapter.documentByTreePath.get(selectedTreePath) : undefined
  const selectedFolderPath = selectedTreePath
    ? adapter.folderByTreePath.has(selectedTreePath)
      ? selectedTreePath
      : selectedDocument?.path
        ? parentWorkspacePath(selectedDocument.path)
        : ''
    : ''

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
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
        <button onClick={() => setCreateMode({ kind: 'file', parentPath: selectedFolderPath })}>
          <FilePlus2 size={14} /> New file
        </button>
        <button
          aria-label="New folder"
          title="New folder"
          onClick={() => setCreateMode({ kind: 'folder', parentPath: selectedFolderPath })}
        >
          <FolderPlus size={15} />
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
        <Search size={14} />
        <span>Search workspace</span>
      </button>
      <div className="sidebar-section-title">
        <span>Workspace</span>
        <small>{documents.data?.length ?? 0}</small>
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
          className="sangam-file-tree"
          model={model}
          onKeyDown={handleTreeKeyDown}
          onDoubleClick={() => {
            const path = model.getFocusedPath()
            if (path && adapterRef.current.documentByTreePath.has(path)) model.startRenaming(path)
          }}
          renderContextMenu={(item, context) => (
            <ExplorerContextMenu
              adapter={adapterRef.current}
              context={context}
              item={item}
              onCreate={(kind, parentPath) => setCreateMode({ kind, parentPath })}
              onDuplicate={(document) => duplicate.mutate(document)}
              onOpenToSide={(document) => void openDocument(document, true)}
              onRename={(path) => model.startRenaming(path)}
              onTrash={(document) => {
                if (window.confirm(`Move “${document.title}” to trash?`)) remove.mutate(document)
              }}
            />
          )}
        />
        {!documents.isLoading && adapter.paths.length === 0 && (
          <p className="sidebar-message explorer-empty">No documents yet.</p>
        )}
      </div>
    </div>
  )
}

function ExplorerContextMenu({
  adapter,
  context,
  item,
  onCreate,
  onDuplicate,
  onOpenToSide,
  onRename,
  onTrash,
}: {
  adapter: WorkspaceTreeAdapter
  context: ContextMenuOpenContext
  item: ContextMenuItem
  onCreate: (kind: 'file' | 'folder', parentPath: string) => void
  onDuplicate: (document: DocumentSummary) => void
  onOpenToSide: (document: DocumentSummary) => void
  onRename: (path: string) => void
  onTrash: (document: DocumentSummary) => void
}) {
  const document = adapter.documentByTreePath.get(item.path)
  const folder = adapter.folderByTreePath.get(item.path)
  const run = (action: () => void, restoreFocus = true) => {
    context.close({ restoreFocus })
    action()
  }
  if (folder)
    return (
      <div className="tree-context-menu" role="menu" aria-label={`Actions for ${item.name}`}>
        <button type="button" role="menuitem" onClick={() => run(() => onCreate('file', folder.path))}>
          <FilePlus2 size={12} /> New file
        </button>
        <button type="button" role="menuitem" onClick={() => run(() => onCreate('folder', folder.path))}>
          <FolderPlus size={12} /> New folder
        </button>
      </div>
    )
  if (!document) return null
  return (
    <div className="tree-context-menu" role="menu" aria-label={`Actions for ${item.name}`}>
      <button type="button" role="menuitem" onClick={() => run(() => onOpenToSide(document))}>
        <PanelRightOpen size={12} /> Open in split
      </button>
      <button type="button" role="menuitem" onClick={() => run(() => onRename(item.path), false)}>
        <Pencil size={12} /> Rename
      </button>
      <button type="button" role="menuitem" onClick={() => run(() => onDuplicate(document))}>
        <Copy size={12} /> Duplicate
      </button>
      <button className="danger" type="button" role="menuitem" onClick={() => run(() => onTrash(document))}>
        <Trash2 size={12} /> Move to trash
      </button>
    </div>
  )
}

function loadExpanded() {
  try {
    return JSON.parse(localStorage.getItem(expandedStorageKey) ?? '[]') as string[]
  } catch {
    return []
  }
}
