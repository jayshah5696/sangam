import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
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
import { api, type Document, type Folder as WorkspaceFolder } from '../api'
import { useWorkbench } from '../workbench'

type ExplorerFolder = {
  type: 'folder'
  id: string
  name: string
  path: string
  documentCount: number
  children: ExplorerNode[]
  virtual?: boolean
}

type ExplorerDocument = {
  type: 'document'
  id: string
  name: string
  path: string | null
  document: Document
}

type ExplorerNode = ExplorerFolder | ExplorerDocument
type CreateMode = { kind: 'file' | 'folder'; parentPath: string } | null

const expandedStorageKey = 'sangam.explorer.expanded.v1'

export function FileExplorerPanel({ onSearch }: { onSearch: () => void }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const workbench = useWorkbench()
  const documents = useQuery({ queryKey: ['documents', 'explorer'], queryFn: api.listDocuments })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.listFolders })
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [createMode, setCreateMode] = useState<CreateMode>(null)
  const [createName, setCreateName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const treeRef = useRef<HTMLElement>(null)
  const tree = useMemo(() => buildTree(documents.data ?? [], folders.data ?? []), [documents.data, folders.data])
  const flatNodes = useMemo(() => flattenVisible(tree, expanded), [tree, expanded])
  const selected = flatNodes.find((node) => node.id === selectedId)
  const selectedFolderPath = selected?.type === 'folder' ? selected.path : selected?.path?.includes('/') ? selected.path.slice(0, selected.path.lastIndexOf('/')) : ''

  useEffect(() => localStorage.setItem(expandedStorageKey, JSON.stringify([...expanded])), [expanded])

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['documents'] }),
      queryClient.invalidateQueries({ queryKey: ['folders'] }),
    ])
  }

  const create = useMutation({
    mutationFn: async ({ mode, name }: { mode: Exclude<CreateMode, null>; name: string }) => {
      if (mode.kind === 'folder') return { folder: await api.createFolder(joinPath(mode.parentPath, name)) }
      const filename = name.toLowerCase().endsWith('.md') ? name : `${name}.md`
      const title = name.replace(/\.md$/i, '').trim() || 'Untitled document'
      const created = await api.createDocument(title)
      const materialized = await api.materializeDocument(created, joinPath(mode.parentPath, filename))
      return { document: materialized }
    },
    onSuccess: async (result) => {
      setCreateMode(null)
      setCreateName('')
      setError(null)
      await refresh()
      if (result.folder) setExpanded((current) => new Set(current).add(result.folder!.path))
      if (result.document) {
        workbench.openDocument(result.document.document_id, result.document.title, workbench.activeGroupId)
        await navigate({ to: '/documents/$documentId', params: { documentId: result.document.document_id } })
      }
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'The item could not be created.'),
  })

  const rename = useMutation({
    mutationFn: async ({ node, value }: { node: ExplorerDocument; value: string }) => {
      if (node.document.path) {
        const parent = node.document.path.includes('/') ? node.document.path.slice(0, node.document.path.lastIndexOf('/')) : ''
        const filename = value.toLowerCase().endsWith('.md') ? value : `${value}.md`
        return api.moveDocument(node.document, joinPath(parent, filename))
      }
      return api.updateDocument(node.document, node.document.content, value)
    },
    onSuccess: async () => { setRenamingId(null); setError(null); await refresh() },
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'The document could not be renamed.'),
  })

  const duplicate = useMutation({
    mutationFn: (document: Document) => api.duplicateDocument(document),
    onSuccess: async (created) => {
      await refresh()
      workbench.openDocument(created.document_id, created.title, workbench.activeGroupId)
      await navigate({ to: '/documents/$documentId', params: { documentId: created.document_id } })
    },
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'The document could not be duplicated.'),
  })

  const remove = useMutation({
    mutationFn: (document: Document) => api.deleteDocument(document),
    onSuccess: refresh,
    onError: (cause) => setError(cause instanceof Error ? cause.message : 'The document could not be moved to trash.'),
  })

  const move = useMutation({
    mutationFn: ({ document, folderPath }: { document: Document; folderPath: string }) => {
      if (!document.path) throw new Error('Save this draft to the workspace before moving it.')
      const filename = document.path.split('/').at(-1)!
      return api.moveDocument(document, joinPath(folderPath, filename))
    },
    onMutate: async ({ document, folderPath }) => {
      await queryClient.cancelQueries({ queryKey: ['documents', 'explorer'] })
      const previous = queryClient.getQueryData<Document[]>(['documents', 'explorer'])
      const filename = document.path?.split('/').at(-1)
      if (filename) queryClient.setQueryData<Document[]>(['documents', 'explorer'], (current) => current?.map((candidate) => candidate.document_id === document.document_id ? { ...candidate, path: joinPath(folderPath, filename) } : candidate))
      return { previous }
    },
    onError: (cause, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(['documents', 'explorer'], context.previous)
      setError(cause instanceof Error ? cause.message : 'The document could not be moved.')
    },
    onSettled: refresh,
  })

  const openDocument = async (node: ExplorerDocument, toSide = false) => {
    if (toSide) workbench.splitGroup(workbench.activeGroupId, 'horizontal', node.document.document_id)
    else workbench.openDocument(node.document.document_id, node.document.title, workbench.activeGroupId)
    await navigate({ to: '/documents/$documentId', params: { documentId: node.document.document_id } })
  }

  const startRename = (node: ExplorerDocument) => {
    setRenamingId(node.id)
    setRenameValue(node.name.replace(/\.md$/i, ''))
  }

  const onTreeKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const rows = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[data-tree-row]') ?? [])
    const current = rows.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const next = current < 0 ? (direction > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, current + direction))
      event.preventDefault(); rows[next]?.focus(); return
    }
    const nodeId = (document.activeElement as HTMLElement | null)?.dataset.nodeId
    const node = flatNodes.find((candidate) => candidate.id === nodeId)
    if (!node) return
    if (event.key === 'ArrowRight' && node.type === 'folder') { event.preventDefault(); setExpanded((currentSet) => new Set(currentSet).add(node.path)); return }
    if (event.key === 'ArrowLeft' && node.type === 'folder') { event.preventDefault(); setExpanded((currentSet) => { const next = new Set(currentSet); next.delete(node.path); return next }); return }
    if (event.key === 'Enter' && node.type === 'document') { event.preventDefault(); void openDocument(node); return }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
      const query = event.key.toLowerCase()
      const match = flatNodes.slice(current + 1).concat(flatNodes.slice(0, current + 1)).find((candidate) => candidate.name.toLowerCase().startsWith(query))
      treeRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(match?.id ?? '')}"]`)?.focus()
    }
  }

  const dropDocument = (event: DragEvent, folderPath: string) => {
    event.preventDefault()
    const documentId = event.dataTransfer.getData('application/x-sangam-document')
    const document = documents.data?.find((candidate) => candidate.document_id === documentId)
    if (document) move.mutate({ document, folderPath })
  }

  return (
    <div className="sidebar-content file-explorer-panel">
      <div className="sidebar-actions">
        <button onClick={() => setCreateMode({ kind: 'file', parentPath: selectedFolderPath ?? '' })}><FilePlus2 size={14} /> New file</button>
        <button aria-label="New folder" title="New folder" onClick={() => setCreateMode({ kind: 'folder', parentPath: selectedFolderPath ?? '' })}><FolderPlus size={15} /></button>
      </div>
      {createMode && <form className="sidebar-inline-form explorer-create" onSubmit={(event) => { event.preventDefault(); if (createName.trim()) create.mutate({ mode: createMode, name: createName.trim() }) }}><span>{createMode.parentPath || 'workspace'} /</span><input autoFocus aria-label={`New ${createMode.kind} name`} placeholder={createMode.kind === 'file' ? 'note.md' : 'folder'} value={createName} onChange={(event) => setCreateName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setCreateMode(null) }} /><button disabled={create.isPending}>Create</button></form>}
      <button className="sidebar-search-trigger" onClick={onSearch}><Search size={14} /><span>Search workspace</span><kbd>⌘K</kbd></button>
      <div className="sidebar-section-title"><span>Workspace</span><small>{documents.data?.length ?? 0}</small></div>
      {error && <div className="explorer-error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
      {documents.isLoading && <p className="sidebar-message">Loading files…</p>}
      {documents.isError && <p className="sidebar-message error-text">Files could not be loaded.</p>}
      <nav ref={treeRef} role="tree" aria-label="Files" className="explorer-tree" onKeyDown={onTreeKeyDown} onDragOver={(event) => event.preventDefault()} onDrop={(event) => dropDocument(event, '')}>
        {tree.map((node) => <ExplorerNodeView key={node.id} node={node} level={1} expanded={expanded} selectedId={selectedId} renamingId={renamingId} renameValue={renameValue} onSelect={setSelectedId} onToggle={(path) => setExpanded((current) => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next })} onOpen={(target) => void openDocument(target)} onOpenToSide={(target) => void openDocument(target, true)} onStartRename={startRename} onRenameValue={setRenameValue} onCommitRename={(target) => { if (renameValue.trim()) rename.mutate({ node: target, value: renameValue.trim() }) }} onCancelRename={() => setRenamingId(null)} onCreate={(kind, parentPath) => setCreateMode({ kind, parentPath })} onDuplicate={(target) => duplicate.mutate(target.document)} onTrash={(target) => { if (window.confirm(`Move “${target.document.title}” to trash?`)) remove.mutate(target.document) }} onDropDocument={dropDocument} />)}
        {tree.length === 0 && <p className="sidebar-message">No documents yet.</p>}
      </nav>
    </div>
  )
}

function ExplorerNodeView({ node, level, expanded, selectedId, renamingId, renameValue, onSelect, onToggle, onOpen, onOpenToSide, onStartRename, onRenameValue, onCommitRename, onCancelRename, onCreate, onDuplicate, onTrash, onDropDocument }: {
  node: ExplorerNode
  level: number
  expanded: Set<string>
  selectedId: string | null
  renamingId: string | null
  renameValue: string
  onSelect: (id: string) => void
  onToggle: (path: string) => void
  onOpen: (node: ExplorerDocument) => void
  onOpenToSide: (node: ExplorerDocument) => void
  onStartRename: (node: ExplorerDocument) => void
  onRenameValue: (value: string) => void
  onCommitRename: (node: ExplorerDocument) => void
  onCancelRename: () => void
  onCreate: (kind: 'file' | 'folder', parentPath: string) => void
  onDuplicate: (node: ExplorerDocument) => void
  onTrash: (node: ExplorerDocument) => void
  onDropDocument: (event: DragEvent, folderPath: string) => void
}) {
  const isExpanded = node.type === 'folder' && expanded.has(node.path)
  if (node.type === 'folder') {
    return (
      <div role="treeitem" aria-level={level} aria-expanded={isExpanded} aria-selected={selectedId === node.id} className="explorer-branch">
        <div className={selectedId === node.id ? 'explorer-row selected' : 'explorer-row'} style={{ paddingLeft: 5 + (level - 1) * 13 }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.stopPropagation(); onDropDocument(event, node.virtual ? '' : node.path) }}>
          <button data-tree-row data-node-id={node.id} tabIndex={selectedId === node.id ? 0 : -1} className="explorer-label" onClick={() => { onSelect(node.id); onToggle(node.path) }}>
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{isExpanded ? <FolderOpen size={13} /> : <Folder size={13} />}<span>{node.name}</span><small>{node.documentCount}</small>
          </button>
          {!node.virtual && <details className="tree-menu"><summary aria-label={`Actions for ${node.name}`}><MoreHorizontal size={13} /></summary><div><button onClick={() => onCreate('file', node.path)}><FilePlus2 size={12} />New file</button><button onClick={() => onCreate('folder', node.path)}><FolderPlus size={12} />New folder</button></div></details>}
        </div>
        {isExpanded && <div role="group">{node.children.map((child) => <ExplorerNodeView key={child.id} node={child} level={level + 1} expanded={expanded} selectedId={selectedId} renamingId={renamingId} renameValue={renameValue} onSelect={onSelect} onToggle={onToggle} onOpen={onOpen} onOpenToSide={onOpenToSide} onStartRename={onStartRename} onRenameValue={onRenameValue} onCommitRename={onCommitRename} onCancelRename={onCancelRename} onCreate={onCreate} onDuplicate={onDuplicate} onTrash={onTrash} onDropDocument={onDropDocument} />)}</div>}
      </div>
    )
  }
  return (
    <div role="treeitem" aria-level={level} aria-selected={selectedId === node.id} className={selectedId === node.id ? 'explorer-row selected' : 'explorer-row'} style={{ paddingLeft: 20 + (level - 1) * 13 }} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-sangam-document', node.document.document_id) }}>
      {renamingId === node.id ? <form className="tree-rename" onSubmit={(event) => { event.preventDefault(); onCommitRename(node) }}><input autoFocus aria-label={`Rename ${node.name}`} value={renameValue} onChange={(event) => onRenameValue(event.target.value)} onBlur={() => onCommitRename(node)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onCancelRename() } }} /></form> : <button data-tree-row data-node-id={node.id} tabIndex={selectedId === node.id ? 0 : -1} className="explorer-label" onClick={() => { onSelect(node.id); onOpen(node) }} onDoubleClick={() => onStartRename(node)}><FileText size={13} /><span>{node.name}</span></button>}
      <details className="tree-menu"><summary aria-label={`Actions for ${node.name}`}><MoreHorizontal size={13} /></summary><div><button onClick={() => onOpenToSide(node)}><PanelRightOpen size={12} />Open to side</button><button onClick={() => onStartRename(node)}><Pencil size={12} />Rename</button><button onClick={() => onDuplicate(node)}><Copy size={12} />Duplicate</button><button className="danger" onClick={() => onTrash(node)}><Trash2 size={12} />Move to trash</button></div></details>
    </div>
  )
}

function buildTree(documents: Document[], folders: WorkspaceFolder[]): ExplorerNode[] {
  const folderNodes = new Map<string, ExplorerFolder>()
  for (const folder of [...folders].sort((a, b) => a.path.localeCompare(b.path))) folderNodes.set(folder.path, { type: 'folder', id: `folder:${folder.folder_id}`, name: folder.name, path: folder.path, documentCount: folder.document_count, children: [] })
  const roots: ExplorerNode[] = []
  for (const folder of folderNodes.values()) {
    const parentPath = folder.path.includes('/') ? folder.path.slice(0, folder.path.lastIndexOf('/')) : ''
    const parent = folderNodes.get(parentPath)
    if (parent) parent.children.push(folder); else roots.push(folder)
  }
  const drafts: ExplorerDocument[] = []
  for (const document of documents) {
    const node: ExplorerDocument = { type: 'document', id: `document:${document.document_id}`, name: document.path?.split('/').at(-1) ?? document.title, path: document.path, document }
    if (!document.path) { drafts.push(node); continue }
    const parentPath = document.path.includes('/') ? document.path.slice(0, document.path.lastIndexOf('/')) : ''
    const parent = folderNodes.get(parentPath)
    if (parent) parent.children.push(node); else roots.push(node)
  }
  if (drafts.length) roots.unshift({ type: 'folder', id: 'folder:drafts', name: 'Drafts', path: '__drafts__', documentCount: drafts.length, children: drafts, virtual: true })
  const sort = (nodes: ExplorerNode[]) => nodes.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1).forEach((node) => { if (node.type === 'folder') sort(node.children) })
  sort(roots)
  return roots
}

function flattenVisible(nodes: ExplorerNode[], expanded: Set<string>): ExplorerNode[] {
  const result: ExplorerNode[] = []
  for (const node of nodes) { result.push(node); if (node.type === 'folder' && expanded.has(node.path)) result.push(...flattenVisible(node.children, expanded)) }
  return result
}

function joinPath(parent: string, child: string) {
  return [parent.replace(/^\/+|\/+$/g, ''), child.replace(/^\/+|\/+$/g, '')].filter(Boolean).join('/')
}

function loadExpanded() {
  try { return new Set<string>(JSON.parse(localStorage.getItem(expandedStorageKey) ?? '[]') as string[]) } catch { return new Set<string>() }
}
