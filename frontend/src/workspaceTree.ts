import type { FileTreeSortEntry } from '@pierre/trees'
import type { DocumentSummary, Folder as WorkspaceFolder } from './api'

export type WorkspaceTreeAdapter = {
  paths: string[]
  documentByTreePath: Map<string, DocumentSummary>
  folderByTreePath: Map<string, WorkspaceFolder>
  treePathByDocumentId: Map<string, string>
  draftsRootPath: string | null
}

/**
 * Pierre Trees is intentionally path-first, while Sangam documents are ID-first.
 * This adapter is the only place where the two models meet: the tree receives
 * presentation paths, and every document action resolves back to a stable ID.
 */
export function buildWorkspaceTreeAdapter(
  documents: DocumentSummary[],
  folders: WorkspaceFolder[],
): WorkspaceTreeAdapter {
  const paths: string[] = []
  const documentByTreePath = new Map<string, DocumentSummary>()
  const folderByTreePath = new Map<string, WorkspaceFolder>()
  const treePathByDocumentId = new Map<string, string>()
  const occupiedRootNames = new Set<string>()

  for (const folder of folders) {
    const path = normalizeWorkspacePath(folder.path)
    if (!path) continue
    occupiedRootNames.add(path.split('/')[0]!)
    const treePath = toTreeDirectoryPath(path)
    folderByTreePath.set(treePath, folder)
    paths.push(treePath)
  }

  const drafts = documents.filter((document) => !document.path)
  for (const document of documents) {
    if (!document.path) continue
    const path = normalizeWorkspacePath(document.path)
    occupiedRootNames.add(path.split('/')[0]!)
    documentByTreePath.set(path, document)
    treePathByDocumentId.set(document.document_id, path)
    paths.push(path)
  }

  const draftsRootName = drafts.length ? availableDraftsRoot(occupiedRootNames) : null
  const draftsRootPath = draftsRootName ? toTreeDirectoryPath(draftsRootName) : null
  if (draftsRootName) {
    const usedDraftPaths = new Set<string>()
    for (const document of drafts) {
      const path = uniqueDraftPath(draftsRootName, document.title, usedDraftPaths)
      usedDraftPaths.add(path)
      documentByTreePath.set(path, document)
      treePathByDocumentId.set(document.document_id, path)
      paths.push(path)
    }
  }

  return {
    paths: [...new Set(paths)],
    documentByTreePath,
    folderByTreePath,
    treePathByDocumentId,
    draftsRootPath,
  }
}

export function workspacePathFromTreePath(path: string | null) {
  return path ? normalizeWorkspacePath(path) : ''
}

export function toTreeDirectoryPath(path: string) {
  const normalized = normalizeWorkspacePath(path)
  return normalized ? `${normalized}/` : ''
}

export function joinWorkspacePath(parent: string, child: string) {
  return [normalizeWorkspacePath(parent), normalizeWorkspacePath(child)].filter(Boolean).join('/')
}

export function parentWorkspacePath(path: string) {
  const normalized = normalizeWorkspacePath(path)
  return normalized.includes('/') ? normalized.slice(0, normalized.lastIndexOf('/')) : ''
}

export function workspaceBasename(path: string) {
  const normalized = normalizeWorkspacePath(path)
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

export function ensureMarkdownExtension(name: string) {
  const normalized = name.trim()
  return normalized.toLowerCase().endsWith('.md') ? normalized : `${normalized}.md`
}

function normalizeWorkspacePath(path: string) {
  return path.replace(/^\/+|\/+$/g, '')
}

function availableDraftsRoot(occupiedRootNames: Set<string>) {
  const base = 'Drafts'
  let candidate = base
  let suffix = 2
  while (occupiedRootNames.has(candidate)) {
    candidate = `${base} (Sangam ${suffix})`
    suffix += 1
  }
  return candidate
}

function uniqueDraftPath(root: string, title: string, usedPaths: Set<string>) {
  const safeTitle = title.trim().replaceAll('/', '／') || 'Untitled document'
  let candidate = joinWorkspacePath(root, safeTitle)
  let suffix = 2
  while (usedPaths.has(candidate)) {
    candidate = joinWorkspacePath(root, `${safeTitle} (${suffix})`)
    suffix += 1
  }
  return candidate
}

type WorkspaceSortNode = Pick<FileTreeSortEntry, 'basename' | 'isDirectory' | 'path'>

function compareWorkspaceNames(left: string, right: string) {
  const insensitive = left.localeCompare(right, undefined, { sensitivity: 'base' })
  if (insensitive !== 0 || left === right) return insensitive
  return left < right ? -1 : 1
}

function compareWorkspaceHierarchy(
  left: FileTreeSortEntry,
  right: FileTreeSortEntry,
  compareSiblings: (left: WorkspaceSortNode, right: WorkspaceSortNode) => number,
) {
  const sharedDepth = Math.min(left.segments.length, right.segments.length)
  for (let depth = 0; depth < sharedDepth; depth += 1) {
    const leftSegment = left.segments[depth]!
    const rightSegment = right.segments[depth]!
    if (leftSegment === rightSegment) continue

    return compareSiblings(
      {
        basename: leftSegment,
        isDirectory: depth < left.segments.length - 1 || left.isDirectory,
        path: left.segments.slice(0, depth + 1).join('/'),
      },
      {
        basename: rightSegment,
        isDirectory: depth < right.segments.length - 1 || right.isDirectory,
        path: right.segments.slice(0, depth + 1).join('/'),
      },
    )
  }

  if (left.segments.length !== right.segments.length) {
    return left.segments.length < right.segments.length ? -1 : 1
  }
  if (left.isDirectory === right.isDirectory) return 0
  return left.isDirectory ? -1 : 1
}

/**
 * Builds a comparator that sorts siblings Z–A (reverse alphabetical),
 * with directories before documents while keeping each subtree contiguous.
 */
export function buildNameDescSortComparator(): (a: FileTreeSortEntry, b: FileTreeSortEntry) => number {
  return (left, right) =>
    compareWorkspaceHierarchy(left, right, (leftSibling, rightSibling) => {
      if (leftSibling.isDirectory !== rightSibling.isDirectory) {
        return leftSibling.isDirectory ? -1 : 1
      }
      return compareWorkspaceNames(rightSibling.basename, leftSibling.basename)
    })
}

/**
 * Builds a comparator that sorts siblings by updated_at DESC (newest first),
 * with directories before documents and a stable name tie-breaker. Pierre
 * sorts the complete path list, so the comparator must keep descendants next
 * to their parent instead of grouping all directories ahead of all files.
 */
export function buildModifiedSortComparator(
  timestamps: Map<string, string>,
): (a: FileTreeSortEntry, b: FileTreeSortEntry) => number {
  const timestampFor = (entry: WorkspaceSortNode): string => {
    if (!entry.isDirectory) return timestamps.get(entry.path) ?? ''
    let max = ''
    for (const [path, ts] of timestamps) {
      if (path.startsWith(entry.path + '/') && ts > max) max = ts
    }
    return max
  }
  return (left, right) =>
    compareWorkspaceHierarchy(left, right, (leftSibling, rightSibling) => {
      if (leftSibling.isDirectory !== rightSibling.isDirectory) {
        return leftSibling.isDirectory ? -1 : 1
      }
      const leftTimestamp = timestampFor(leftSibling)
      const rightTimestamp = timestampFor(rightSibling)
      if (leftTimestamp !== rightTimestamp) return rightTimestamp.localeCompare(leftTimestamp)
      return compareWorkspaceNames(leftSibling.basename, rightSibling.basename)
    })
}
