import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus2,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  PanelRightOpen,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react'
import { api, type DocumentSummary } from '../api'
import { preferredSplitDirection } from '../splitPolicy'
import { findGroup, useWorkbench } from '../workbench'
import { ActionMenu, ActionMenuItem } from './ActionMenu'
import {
  adjacentVisibleNodeId,
  buildWorkspaceTree,
  ensureMarkdownExtension,
  flattenVisibleNodes,
  joinWorkspacePath,
  parentWorkspacePath,
  parentNodeId,
  typeaheadNodeId,
  workspaceBasename,
  type ExplorerDocument,
  type ExplorerNode,
} from '../workspaceTree'

type CreateMode = { kind: 'file' | 'folder'; parentPath: string } | null

type ExplorerActions = {
  expanded: Set<string>
  selectedId: string | null
  renamingId: string | null
  renameValue: string
  select: (id: string) => void
  toggle: (path: string) => void
  open: (node: ExplorerDocument) => void
  openToSide: (node: ExplorerDocument) => void
  startRename: (node: ExplorerDocument) => void
  setRenameValue: (value: string) => void
  commitRename: (node: ExplorerDocument) => void
  cancelRename: () => void
  create: (kind: 'file' | 'folder', parentPath: string) => void
  duplicate: (node: ExplorerDocument) => void
  trash: (node: ExplorerDocument) => void
  dropDocument: (event: DragEvent, folderPath: string) => void
}

const ExplorerActionsContext = createContext<ExplorerActions | null>(null)

const expandedStorageKey = 'sangam.explorer.expanded.v1'

export function FileExplorerPanel({ onSearch }: { onSearch: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const activeDocumentId = findGroup(workbench.root, workbench.activeGroupId)?.activeTabId
  const documents = useQuery({ queryKey: ['documents', 'explorer'], queryFn: api.listDocuments })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.listFolders })
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)
  const [selection, setSelection] = useState<{
    activeDocumentId: string | null | undefined
    selectedId: string | null
  }>({ activeDocumentId, selectedId: activeDocumentId ? `document:${activeDocumentId}` : null })
  const selectedId =
    selection.activeDocumentId === activeDocumentId
      ? selection.selectedId
      : activeDocumentId
        ? `document:${activeDocumentId}`
        : selection.selectedId
  const setSelectedId = (nextSelectedId: string | null) =>
    setSelection({ activeDocumentId, selectedId: nextSelectedId })
  const [createMode, setCreateMode] = useState<CreateMode>(null)
  const [createName, setCreateName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const treeRef = useRef<HTMLElement>(null)
  const tree = useMemo(
    () => buildWorkspaceTree(documents.data ?? [], folders.data ?? []),
    [documents.data, folders.data],
  )
  const flatNodes = useMemo(() => flattenVisibleNodes(tree, expanded), [tree, expanded])
  const selected = flatNodes.find((node) => node.id === selectedId)
  const selectedFolderPath =
    selected?.type === 'folder' ? selected.path : selected?.path ? parentWorkspacePath(selected.path) : ''

  useEffect(() => localStorage.setItem(expandedStorageKey, JSON.stringify([...expanded])), [expanded])

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
      if (result.folder) setExpanded((current) => new Set(current).add(result.folder!.path))
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
    mutationFn: async ({ node, value }: { node: ExplorerDocument; value: string }) => {
      if (node.document.path) {
        const parent = parentWorkspacePath(node.document.path)
        const filename = ensureMarkdownExtension(value)
        return api.moveDocument(node.document, joinWorkspacePath(parent, filename))
      }
      const document = await api.getDocument(node.document.document_id)
      return api.updateDocument(document, document.content, value)
    },
    onSuccess: async () => {
      setRenamingId(null)
      setError(null)
      await refresh()
    },
    onError: (cause) =>
      setError(cause instanceof Error ? cause.message : 'The document could not be renamed.'),
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
      const filename = workspaceBasename(document.path)
      return api.moveDocument(document, joinWorkspacePath(folderPath, filename))
    },
    onMutate: async ({ document, folderPath }) => {
      await queryClient.cancelQueries({ queryKey: ['documents', 'explorer'] })
      const previous = queryClient.getQueryData<DocumentSummary[]>(['documents', 'explorer'])
      const filename = document.path ? workspaceBasename(document.path) : undefined
      if (filename)
        queryClient.setQueryData<DocumentSummary[]>(['documents', 'explorer'], (current) =>
          current?.map((candidate) =>
            candidate.document_id === document.document_id
              ? { ...candidate, path: joinWorkspacePath(folderPath, filename) }
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

  const openDocument = async (node: ExplorerDocument, toSide = false) => {
    if (toSide)
      workbench.splitGroup(workbench.activeGroupId, preferredSplitDirection(), node.document.document_id)
    else workbench.ensureDocumentOpen(node.document.document_id, node.document.title, workbench.activeGroupId)
    await navigate({ to: '/documents/$documentId', params: { documentId: node.document.document_id } })
  }

  const startRename = (node: ExplorerDocument) => {
    setRenamingId(node.id)
    setRenameValue(node.name.replace(/\.md$/i, ''))
  }

  const onTreeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const activeId = (document.activeElement as HTMLElement | null)?.dataset.nodeId ?? selectedId
    const focusNode = (nodeId: string | null) => {
      if (!nodeId) return
      setSelectedId(nodeId)
      requestAnimationFrame(() =>
        treeRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(nodeId)}"]`)?.focus(),
      )
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      focusNode(adjacentVisibleNodeId(flatNodes, activeId, event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    const node = flatNodes.find((candidate) => candidate.id === activeId)
    if (!node) return
    if (event.key === 'ArrowRight' && node.type === 'folder') {
      event.preventDefault()
      if (expanded.has(node.path)) focusNode(node.children[0]?.id ?? null)
      else setExpanded((currentSet) => new Set(currentSet).add(node.path))
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (node.type === 'folder' && expanded.has(node.path)) {
        setExpanded((currentSet) => {
          const next = new Set(currentSet)
          next.delete(node.path)
          return next
        })
      } else focusNode(parentNodeId(tree, node.id))
      return
    }
    if (event.key === 'Enter' && node.type === 'document') {
      event.preventDefault()
      void openDocument(node)
      return
    }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      focusNode(typeaheadNodeId(flatNodes, activeId, event.key))
    }
  }

  const dropDocument = (event: DragEvent, folderPath: string) => {
    event.preventDefault()
    const documentId = event.dataTransfer.getData('application/x-sangam-document')
    const document = documents.data?.find((candidate) => candidate.document_id === documentId)
    if (document) move.mutate({ document, folderPath })
  }

  const actions: ExplorerActions = {
    expanded,
    selectedId,
    renamingId,
    renameValue,
    select: setSelectedId,
    toggle: (path) =>
      setExpanded((current) => {
        const next = new Set(current)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      }),
    open: (target) => void openDocument(target),
    openToSide: (target) => void openDocument(target, true),
    startRename,
    setRenameValue,
    commitRename: (target) => {
      if (renameValue.trim()) rename.mutate({ node: target, value: renameValue.trim() })
    },
    cancelRename: () => setRenamingId(null),
    create: (kind, parentPath) => setCreateMode({ kind, parentPath }),
    duplicate: (target) => duplicate.mutate(target.document),
    trash: (target) => {
      if (window.confirm(`Move “${target.document.title}” to trash?`)) remove.mutate(target.document)
    },
    dropDocument,
  }

  return (
    <ExplorerActionsContext.Provider value={actions}>
      <div className="sidebar-content file-explorer-panel">
        <div className="sidebar-actions">
          <button onClick={() => setCreateMode({ kind: 'file', parentPath: selectedFolderPath ?? '' })}>
            <FilePlus2 size={14} /> New file
          </button>
          <button
            aria-label="New folder"
            title="New folder"
            onClick={() => setCreateMode({ kind: 'folder', parentPath: selectedFolderPath ?? '' })}
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
        <nav
          ref={treeRef}
          role="tree"
          aria-label="Files"
          className="explorer-tree"
          onKeyDown={onTreeKeyDown}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => dropDocument(event, '')}
        >
          {tree.map((node) => (
            <ExplorerNodeView key={node.id} node={node} level={1} />
          ))}
          {tree.length === 0 && <p className="sidebar-message">No documents yet.</p>}
        </nav>
      </div>
    </ExplorerActionsContext.Provider>
  )
}

function ExplorerNodeView({ node, level }: { node: ExplorerNode; level: number }) {
  const actions = useContext(ExplorerActionsContext)
  if (!actions) throw new Error('ExplorerNodeView must be rendered inside FileExplorerPanel')
  const isExpanded = node.type === 'folder' && actions.expanded.has(node.path)
  if (node.type === 'folder') {
    return (
      <div
        role="treeitem"
        aria-level={level}
        aria-expanded={isExpanded}
        aria-selected={actions.selectedId === node.id}
        className="explorer-branch"
      >
        <div
          className={actions.selectedId === node.id ? 'explorer-row selected' : 'explorer-row'}
          style={{ paddingLeft: 5 + (level - 1) * 13 }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.stopPropagation()
            actions.dropDocument(event, node.virtual ? '' : node.path)
          }}
        >
          <button
            data-tree-row
            data-node-id={node.id}
            tabIndex={actions.selectedId === node.id ? 0 : -1}
            className="explorer-label"
            onClick={() => {
              actions.select(node.id)
              actions.toggle(node.path)
            }}
          >
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {isExpanded ? <FolderOpen size={13} /> : <Folder size={13} />}
            <span>{node.name}</span>
            <small>{node.documentCount}</small>
          </button>
          {!node.virtual && (
            <ActionMenu
              label={`Actions for ${node.name}`}
              icon={<MoreHorizontal size={13} />}
              className="tree-menu-trigger"
            >
              {(close) => (
                <>
                  <ActionMenuItem
                    onSelect={() => {
                      actions.create('file', node.path)
                      close()
                    }}
                  >
                    <FilePlus2 size={12} />
                    New file
                  </ActionMenuItem>
                  <ActionMenuItem
                    onSelect={() => {
                      actions.create('folder', node.path)
                      close()
                    }}
                  >
                    <FolderPlus size={12} />
                    New folder
                  </ActionMenuItem>
                </>
              )}
            </ActionMenu>
          )}
        </div>
        {isExpanded && (
          <div role="group">
            {node.children.map((child) => (
              <ExplorerNodeView key={child.id} node={child} level={level + 1} />
            ))}
          </div>
        )}
      </div>
    )
  }
  return (
    <div
      role="treeitem"
      aria-level={level}
      aria-selected={actions.selectedId === node.id}
      className={actions.selectedId === node.id ? 'explorer-row selected' : 'explorer-row'}
      style={{ paddingLeft: 20 + (level - 1) * 13 }}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-sangam-document', node.document.document_id)
      }}
    >
      {actions.renamingId === node.id ? (
        <form
          className="tree-rename"
          onSubmit={(event) => {
            event.preventDefault()
            actions.commitRename(node)
          }}
        >
          <input
            autoFocus
            aria-label={`Rename ${node.name}`}
            value={actions.renameValue}
            onChange={(event) => actions.setRenameValue(event.target.value)}
            onBlur={() => actions.commitRename(node)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                actions.cancelRename()
              }
            }}
          />
        </form>
      ) : (
        <button
          data-tree-row
          data-node-id={node.id}
          tabIndex={actions.selectedId === node.id ? 0 : -1}
          className="explorer-label"
          onClick={() => {
            actions.select(node.id)
            actions.open(node)
          }}
          onDoubleClick={() => actions.startRename(node)}
        >
          <FileText size={13} />
          <span>{node.name}</span>
        </button>
      )}
      <ActionMenu
        label={`Actions for ${node.name}`}
        icon={<MoreHorizontal size={13} />}
        className="tree-menu-trigger"
      >
        {(close) => (
          <>
            <ActionMenuItem
              onSelect={() => {
                actions.openToSide(node)
                close()
              }}
            >
              <PanelRightOpen size={12} />
              Open in split
            </ActionMenuItem>
            <ActionMenuItem
              onSelect={() => {
                actions.startRename(node)
                close()
              }}
            >
              <Pencil size={12} />
              Rename
            </ActionMenuItem>
            <ActionMenuItem
              onSelect={() => {
                actions.duplicate(node)
                close()
              }}
            >
              <Copy size={12} />
              Duplicate
            </ActionMenuItem>
            <ActionMenuItem
              className="danger"
              onSelect={() => {
                actions.trash(node)
                close()
              }}
            >
              <Trash2 size={12} />
              Move to trash
            </ActionMenuItem>
          </>
        )}
      </ActionMenu>
    </div>
  )
}

function loadExpanded() {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(expandedStorageKey) ?? '[]') as string[])
  } catch {
    return new Set<string>()
  }
}
