import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, useNavigate } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { api, type Document, type Folder } from '../api'
import { ResizeHandle } from '../components/ResizeHandle'
import { themes, useTheme } from '../theme'

type RouterContext = { queryClient: QueryClient }

export const Route = createRootRouteWithContext<RouterContext>()({ component: RootLayout })

function RootLayout() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { preferences, updatePreferences } = useTheme()
  const [search, setSearch] = useState('')
  const [selectedTag, setSelectedTag] = useState<string | undefined>()
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderPath, setFolderPath] = useState('')
  const documents = useQuery({
    queryKey: ['documents', search, selectedTag],
    queryFn: () => api.searchDocuments(search, selectedTag),
  })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.listFolders })
  const tags = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const createDocument = useMutation({
    mutationFn: () => api.createDocument('Untitled document'),
    onSuccess: async (document) => {
      await queryClient.invalidateQueries({ queryKey: ['documents'] })
      await navigate({
        to: '/documents/$documentId',
        params: { documentId: document.document_id },
      })
    },
  })
  const createFolder = useMutation({
    mutationFn: () => api.createFolder(folderPath),
    onSuccess: async () => {
      setFolderPath('')
      setCreatingFolder(false)
      await queryClient.invalidateQueries({ queryKey: ['folders'] })
    },
  })

  if (!preferences.leftVisible) {
    return (
      <div className="app-shell sidebar-collapsed">
        <aside className="sidebar-rail">
          <Link to="/" className="rail-brand" aria-label="Sangam home">
            <img src="/sangam-mark.svg" alt="" />
          </Link>
          <button
            className="icon-button"
            aria-label="Open file sidebar"
            onClick={() => updatePreferences({ leftVisible: true })}
          >
            ☰
          </button>
          <Link to="/settings/appearance" className="rail-link" aria-label="Workspace settings">
            ⚙
          </Link>
        </aside>
        <main className="main-panel"><Outlet /></main>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" style={{ width: preferences.leftWidth }}>
        <div className="brand-row">
          <div className="brand-lockup">
            <Link to="/" className="brand-mark-link" aria-label="Sangam home">
              <img src="/sangam-mark.svg" alt="" />
            </Link>
            <div className="brand">
              <Link to="/" className="brand-link">Sangam</Link>
              <span>Documents, plainly.</span>
            </div>
          </div>
          <button
            className="icon-button sidebar-icon"
            aria-label="Collapse file sidebar"
            onClick={() => updatePreferences({ leftVisible: false })}
          >
            ‹
          </button>
        </div>
        <div className="create-actions">
          <button
            className="primary-button"
            onClick={() => createDocument.mutate()}
            disabled={createDocument.isPending}
          >
            {createDocument.isPending ? 'Creating…' : '+ New document'}
          </button>
          <button className="secondary-button" onClick={() => setCreatingFolder((open) => !open)}>
            + Folder
          </button>
        </div>
        {creatingFolder && (
          <form
            className="inline-form dark-form"
            onSubmit={(event) => {
              event.preventDefault()
              if (folderPath.trim()) createFolder.mutate()
            }}
          >
            <input
              aria-label="New folder path"
              placeholder="projects/research"
              value={folderPath}
              onChange={(event) => setFolderPath(event.target.value)}
            />
            <button disabled={createFolder.isPending}>Create</button>
          </form>
        )}
        <div className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            aria-label="Search documents"
            placeholder="Search title, text, path…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {tags.data && tags.data.length > 0 && (
          <div className="tag-filters" aria-label="Filter by tag">
            {tags.data.map((tag) => (
              <button
                key={tag.tag_id}
                className={selectedTag === tag.tag_id ? 'tag-filter active' : 'tag-filter'}
                onClick={() => setSelectedTag((current) => current === tag.tag_id ? undefined : tag.tag_id)}
              >
                <span style={{ background: tag.color }} />{tag.name}
              </button>
            ))}
          </div>
        )}
        <nav aria-label="Files" className="workspace-tree">
          <div className="section-heading">
            <p className="eyebrow">Workspace</p>
            <small>{documents.data?.length ?? 0}</small>
          </div>
          {documents.isLoading && <p className="muted">Loading…</p>}
          {documents.isError && <p className="error-text">Could not load files.</p>}
          {documents.data && (
            <FolderTree documents={documents.data} folders={folders.data ?? []} />
          )}
        </nav>
        <div className="sidebar-footer">
          <label>
            <span>Theme</span>
            <select
              aria-label="Theme"
              value={preferences.theme}
              onChange={(event) =>
                updatePreferences({ theme: event.target.value as typeof preferences.theme })
              }
            >
              {themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
            </select>
          </label>
          <Link to="/settings/appearance" className="settings-link">⚙ Workspace settings</Link>
        </div>
      </aside>
      <ResizeHandle
        side="left"
        value={preferences.leftWidth}
        min={220}
        max={440}
        onChange={(leftWidth) => updatePreferences({ leftWidth })}
      />
      <main className="main-panel"><Outlet /></main>
    </div>
  )
}

function FolderTree({ documents, folders }: { documents: Document[]; folders: Folder[] }) {
  const drafts = documents.filter((document) => !document.path)
  const roots = folders.filter((folder) => !folder.path.includes('/'))
  const knownPaths = new Set(folders.map((folder) => folder.path))
  const rootDocuments = documents.filter((document) => {
    if (!document.path) return false
    const parent = document.path.includes('/') ? document.path.slice(0, document.path.lastIndexOf('/')) : ''
    return !parent || !knownPaths.has(parent)
  })
  return (
    <div className="folder-tree">
      {drafts.length > 0 && (
        <details open className="folder-node">
          <summary><span>◇</span> Drafts <small>{drafts.length}</small></summary>
          <div className="folder-contents">{drafts.map((document) => <DocumentLink key={document.document_id} document={document} />)}</div>
        </details>
      )}
      {roots.map((folder) => (
        <FolderNode key={folder.folder_id} folder={folder} allFolders={folders} documents={documents} />
      ))}
      {rootDocuments.map((document) => <DocumentLink key={document.document_id} document={document} />)}
      {documents.length === 0 && <p className="muted">No matching documents.</p>}
    </div>
  )
}

function FolderNode({ folder, allFolders, documents }: { folder: Folder; allFolders: Folder[]; documents: Document[] }) {
  const children = allFolders.filter((candidate) => {
    const parent = candidate.path.includes('/') ? candidate.path.slice(0, candidate.path.lastIndexOf('/')) : ''
    return parent === folder.path
  })
  const directDocuments = documents.filter((document) => {
    if (!document.path?.includes('/')) return false
    return document.path.slice(0, document.path.lastIndexOf('/')) === folder.path
  })
  return (
    <details open className="folder-node">
      <summary>
        <span>▾</span> {folder.name}
        <small>{folder.document_count}</small>
      </summary>
      <div className="folder-contents">
        {folder.category && <span className="folder-category">{folder.category}</span>}
        {directDocuments.map((document) => <DocumentLink key={document.document_id} document={document} />)}
        {children.map((child) => (
          <FolderNode key={child.folder_id} folder={child} allFolders={allFolders} documents={documents} />
        ))}
      </div>
    </details>
  )
}

function DocumentLink({ document }: { document: Document }) {
  const label = document.path?.split('/').at(-1) ?? document.title
  return (
    <Link
      to="/documents/$documentId"
      params={{ documentId: document.document_id }}
      className="file-link"
      activeProps={{ className: 'file-link active' }}
    >
      <span>▤ {label}</span>
      {!document.path && <small>draft</small>}
    </Link>
  )
}
