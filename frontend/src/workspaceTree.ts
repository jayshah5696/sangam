import type { Document, Folder as WorkspaceFolder } from './api'

export type ExplorerFolder = {
  type: 'folder'
  id: string
  name: string
  path: string
  documentCount: number
  children: ExplorerNode[]
  virtual?: boolean
}

export type ExplorerDocument = {
  type: 'document'
  id: string
  name: string
  path: string | null
  document: Document
}

export type ExplorerNode = ExplorerFolder | ExplorerDocument

export function buildWorkspaceTree(documents: Document[], folders: WorkspaceFolder[]): ExplorerNode[] {
  const folderNodes = new Map<string, ExplorerFolder>()
  for (const folder of [...folders].sort((a, b) => a.path.localeCompare(b.path))) {
    folderNodes.set(folder.path, {
      type: 'folder',
      id: `folder:${folder.folder_id}`,
      name: folder.name,
      path: folder.path,
      documentCount: folder.document_count,
      children: [],
    })
  }
  const roots: ExplorerNode[] = []
  for (const folder of folderNodes.values()) {
    const parentPath = parentPathOf(folder.path)
    const parent = folderNodes.get(parentPath)
    if (parent) parent.children.push(folder)
    else roots.push(folder)
  }
  const drafts: ExplorerDocument[] = []
  for (const document of documents) {
    const node: ExplorerDocument = {
      type: 'document',
      id: `document:${document.document_id}`,
      name: document.path?.split('/').at(-1) ?? document.title,
      path: document.path,
      document,
    }
    if (!document.path) {
      drafts.push(node)
      continue
    }
    const parent = folderNodes.get(parentPathOf(document.path))
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  if (drafts.length) {
    roots.unshift({
      type: 'folder',
      id: 'folder:drafts',
      name: 'Drafts',
      path: '__drafts__',
      documentCount: drafts.length,
      children: drafts,
      virtual: true,
    })
  }
  sortNodes(roots)
  return roots
}

export function flattenVisibleNodes(nodes: ExplorerNode[], expanded: Set<string>): ExplorerNode[] {
  const result: ExplorerNode[] = []
  for (const node of nodes) {
    result.push(node)
    if (node.type === 'folder' && expanded.has(node.path)) {
      result.push(...flattenVisibleNodes(node.children, expanded))
    }
  }
  return result
}

export function adjacentVisibleNodeId(
  nodes: ExplorerNode[],
  currentId: string | null,
  direction: 1 | -1,
): string | null {
  if (nodes.length === 0) return null
  const currentIndex = nodes.findIndex((node) => node.id === currentId)
  const nextIndex =
    currentIndex < 0
      ? direction > 0
        ? 0
        : nodes.length - 1
      : Math.max(0, Math.min(nodes.length - 1, currentIndex + direction))
  return nodes[nextIndex]?.id ?? null
}

export function parentNodeId(nodes: ExplorerNode[], childId: string): string | null {
  for (const node of nodes) {
    if (node.type !== 'folder') continue
    if (node.children.some((child) => child.id === childId)) return node.id
    const nested = parentNodeId(node.children, childId)
    if (nested) return nested
  }
  return null
}

export function typeaheadNodeId(
  nodes: ExplorerNode[],
  currentId: string | null,
  query: string,
): string | null {
  if (!query) return null
  const currentIndex = nodes.findIndex((node) => node.id === currentId)
  const candidates = nodes.slice(currentIndex + 1).concat(nodes.slice(0, currentIndex + 1))
  return candidates.find((node) => node.name.toLowerCase().startsWith(query.toLowerCase()))?.id ?? null
}

export function joinWorkspacePath(parent: string, child: string) {
  return [parent.replace(/^\/+|\/+$/g, ''), child.replace(/^\/+|\/+$/g, '')].filter(Boolean).join('/')
}

function parentPathOf(path: string) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
}

function sortNodes(nodes: ExplorerNode[]) {
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1))
  for (const node of nodes) if (node.type === 'folder') sortNodes(node.children)
}
