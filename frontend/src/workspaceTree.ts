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
    folderByTreePath.set(path, folder)
    paths.push(`${path}/`)
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

  const draftsRootPath = drafts.length ? availableDraftsRoot(occupiedRootNames) : null
  if (draftsRootPath) {
    const usedDraftPaths = new Set<string>()
    for (const document of drafts) {
      const path = uniqueDraftPath(draftsRootPath, document.title, usedDraftPaths)
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
