import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import {
  Activity,
  ArchiveRestore,
  FileText,
  Import,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { api, type DocumentSummary } from '../api'
import { FileExplorerPanel } from '../components/FileExplorer'
import { CommandPalette } from '../components/CommandPalette'
import { ResizeHandle } from '../components/ResizeHandle'
import { workspaceBasename } from '../workspaceTree'
import { useTheme } from '../theme'
import { useWorkbenchRecovery } from '../workbench'

type RouterContext = { queryClient: QueryClient }
type SidebarMode = 'files' | 'search'

export const Route = createRootRouteWithContext<RouterContext>()({ component: RootLayout })

function RootLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { preferences, updatePreferences } = useTheme()
  const layoutRecovery = useWorkbenchRecovery()
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('files')
  const isDocumentWorkspace = location.pathname === '/' || location.pathname.startsWith('/documents/')

  if (location.pathname.startsWith('/p/')) return <Outlet />

  const chooseSidebarMode = async (next: SidebarMode) => {
    setSidebarMode(next)
    if (!isDocumentWorkspace) await navigate({ to: '/' })
  }

  return (
    <div className={`workbench-shell ${preferences.leftVisible ? '' : 'sidebar-collapsed'}`}>
      {preferences.leftVisible ? (
        <>
          <PrimarySidebar
            mode={sidebarMode}
            onCollapse={() => updatePreferences({ leftVisible: false })}
            onMode={(next) => void chooseSidebarMode(next)}
            style={{ width: preferences.leftWidth }}
          />
          <ResizeHandle
            side="left"
            value={preferences.leftWidth}
            min={220}
            max={460}
            onChange={(leftWidth) => updatePreferences({ leftWidth })}
          />
        </>
      ) : (
        <button
          className="sidebar-reveal icon-button"
          aria-label="Show workspace sidebar"
          title="Show workspace sidebar"
          onClick={() => updatePreferences({ leftVisible: true })}
        >
          <PanelLeftOpen size={17} />
        </button>
      )}
      <div className="workbench-center">
        {layoutRecovery.recovered && (
          <div className="layout-recovery-notice" role="status">
            <span>The saved editor layout was invalid, so Sangam restored one clean group.</span>
            <button onClick={layoutRecovery.dismiss}>Dismiss</button>
          </div>
        )}
        <main className="workbench-main" aria-label="Workspace content">
          <Outlet />
        </main>
      </div>
      <CommandPalette
        onFiles={() => {
          setSidebarMode('files')
          if (!isDocumentWorkspace) void navigate({ to: '/' })
        }}
        onSearch={() => {
          setSidebarMode('search')
          if (!isDocumentWorkspace) void navigate({ to: '/' })
        }}
      />
    </div>
  )
}

function PrimarySidebar({
  mode,
  onCollapse,
  onMode,
  style,
}: {
  mode: SidebarMode
  onCollapse: () => void
  onMode: (mode: SidebarMode) => void
  style: CSSProperties
}) {
  return (
    <aside className="primary-sidebar ui-rail ui-rail--inverse" style={style}>
      <header className="sidebar-brandbar ui-rail-header">
        <Link to="/" className="sidebar-brand" aria-label="Sangam home">
          <img src="/sangam-mark.svg" alt="" />
          <span>
            <strong>Sangam</strong>
            <small>Documents, plainly.</small>
          </span>
        </Link>
        <button
          className="quiet-icon"
          aria-label="Hide workspace sidebar"
          title="Hide sidebar"
          onClick={onCollapse}
        >
          <PanelLeftClose size={16} />
        </button>
      </header>
      <div className="sidebar-mode-switch" role="tablist" aria-label="Workspace navigation">
        <button
          role="tab"
          aria-selected={mode === 'files'}
          className={mode === 'files' ? 'active' : ''}
          onClick={() => onMode('files')}
        >
          <FileText size={14} /> Files
        </button>
        <button
          role="tab"
          aria-selected={mode === 'search'}
          className={mode === 'search' ? 'active' : ''}
          onClick={() => onMode('search')}
        >
          <Search size={14} /> Search
        </button>
      </div>
      {mode === 'files' && <FileExplorerPanel onSearch={() => onMode('search')} />}
      {mode === 'search' && <SearchPanel />}
      <SidebarLinks />
    </aside>
  )
}

function SidebarLinks() {
  const links = [
    { to: '/activity' as const, label: 'Agent activity', icon: Activity },
    { to: '/reconciliation' as const, label: 'Workspace integrity', icon: ShieldCheck },
    { to: '/backups' as const, label: 'Backups', icon: ArchiveRestore },
    { to: '/karakeep' as const, label: 'Karakeep imports', icon: Import },
    { to: '/trash' as const, label: 'Trash', icon: Trash2 },
    { to: '/settings' as const, label: 'Settings', icon: Settings },
  ]
  return (
    <nav className="sidebar-footer-nav" aria-label="Workspace tools">
      {links.map(({ to, label, icon: Icon }) => (
        <Link key={to} to={to} activeProps={{ className: 'active' }}>
          <Icon size={14} />
          <span>{label}</span>
        </Link>
      ))}
    </nav>
  )
}

function SearchPanel() {
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<'relevance' | 'updated' | 'title' | 'path'>('relevance')
  const results = useQuery({
    queryKey: ['documents', 'search-panel', query, sort],
    queryFn: () => api.searchDocuments(query, undefined, sort),
  })
  return (
    <div className="sidebar-content search-panel">
      <label className="sidebar-search-input">
        <Search size={14} />
        <input
          autoFocus
          type="search"
          aria-label="Search documents"
          placeholder="Title, text, path, actor…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <label className="sidebar-sort">
        Sort
        <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
          <option value="relevance">Relevance</option>
          <option value="updated">Updated</option>
          <option value="title">Title</option>
          <option value="path">Path</option>
        </select>
      </label>
      <div className="sidebar-section-title">
        <span>Results</span>
        <small>{results.data?.length ?? 0}</small>
      </div>
      <div className="search-results">
        {results.data?.map((document) => (
          <DocumentLink key={document.document_id} document={document} showPath />
        ))}
        {results.data?.length === 0 && <p className="sidebar-message">No matching documents.</p>}
      </div>
    </div>
  )
}

function DocumentLink({ document, showPath = false }: { document: DocumentSummary; showPath?: boolean }) {
  const label = document.path ? workspaceBasename(document.path) : document.title
  return (
    <Link
      to="/documents/$documentId"
      params={{ documentId: document.document_id }}
      className="file-link"
      activeProps={{ className: 'file-link active' }}
    >
      <FileText size={13} />
      <span>{label}</span>
      {showPath && <small>{document.path ?? 'Draft'}</small>}
      {document.search_snippet && (
        <span className="search-snippet">{plainSnippet(document.search_snippet)}</span>
      )}
    </Link>
  )
}

function plainSnippet(value: string) {
  return value.replaceAll('[[', '').replaceAll(']]', '')
}
