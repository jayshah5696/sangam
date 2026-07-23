import { useEffect, useRef, useState } from 'react'
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
import { activateTabFromKeyboard } from '../components/tabKeyboard'
import { workspaceBasename } from '../workspaceTree'
import { useTheme } from '../theme'
import { useWorkbenchRecovery } from '../workbench'
import { useMediaQuery } from '../useMediaQuery'

type RouterContext = { queryClient: QueryClient }
type SidebarMode = 'files' | 'search'

export const Route = createRootRouteWithContext<RouterContext>()({ component: RootLayout })

function RootLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { preferences, updatePreferences } = useTheme()
  const layoutRecovery = useWorkbenchRecovery()
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('files')
  const [mobileSidebarLocationKey, setMobileSidebarLocationKey] = useState<string | null>(null)
  const narrowSidebar = useMediaQuery('(max-width: 1100px)')
  const isDocumentWorkspace = location.pathname === '/' || location.pathname.startsWith('/documents/')
  const locationKey = location.state.__TSR_key ?? location.href
  const sidebarVisible = narrowSidebar ? mobileSidebarLocationKey === locationKey : preferences.leftVisible

  useEffect(() => {
    if (mobileSidebarLocationKey === null || mobileSidebarLocationKey === locationKey) return
    const frame = window.requestAnimationFrame(() => setMobileSidebarLocationKey(null))
    return () => window.cancelAnimationFrame(frame)
  }, [locationKey, mobileSidebarLocationKey])

  if (location.pathname.startsWith('/p/')) return <Outlet />

  const chooseSidebarMode = async (next: SidebarMode) => {
    setSidebarMode(next)
    if (!isDocumentWorkspace) await navigate({ to: '/' })
  }

  const showSidebar = () => {
    if (narrowSidebar) setMobileSidebarLocationKey(locationKey)
    else updatePreferences({ leftVisible: true })
  }

  const hideSidebar = () => {
    if (narrowSidebar) {
      setMobileSidebarLocationKey(null)
      window.requestAnimationFrame(() =>
        document.querySelector<HTMLButtonElement>('.sidebar-reveal')?.focus(),
      )
    } else updatePreferences({ leftVisible: false })
  }

  return (
    <div className={`workbench-shell ${sidebarVisible ? '' : 'sidebar-collapsed'}`}>
      {sidebarVisible ? (
        <>
          {narrowSidebar && (
            <button className="sidebar-backdrop" aria-label="Close workspace sidebar" onClick={hideSidebar} />
          )}
          <PrimarySidebar
            mode={sidebarMode}
            modal={narrowSidebar}
            onCollapse={hideSidebar}
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
          onClick={showSidebar}
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
          showSidebar()
          if (!isDocumentWorkspace) void navigate({ to: '/' })
        }}
        onSearch={() => {
          setSidebarMode('search')
          showSidebar()
          if (!isDocumentWorkspace) void navigate({ to: '/' })
        }}
      />
    </div>
  )
}

function PrimarySidebar({
  mode,
  modal,
  onCollapse,
  onMode,
  style,
}: {
  mode: SidebarMode
  modal: boolean
  onCollapse: () => void
  onMode: (mode: SidebarMode) => void
  style: CSSProperties
}) {
  const sidebarRef = useRef<HTMLElement>(null)
  const onCollapseRef = useRef(onCollapse)

  useEffect(() => {
    onCollapseRef.current = onCollapse
  }, [onCollapse])

  useEffect(() => {
    if (!modal) return
    const sidebar = sidebarRef.current
    if (!sidebar) return
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    sidebar.querySelector<HTMLElement>('button, a, input, select')?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCollapseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)',
        ),
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [modal])

  return (
    <aside
      ref={sidebarRef}
      className="primary-sidebar ui-rail ui-rail--inverse"
      style={style}
      aria-label="Workspace sidebar"
      aria-modal={modal || undefined}
      role={modal ? 'dialog' : undefined}
    >
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
          id="workspace-tab-files"
          aria-controls="workspace-panel"
          aria-selected={mode === 'files'}
          tabIndex={mode === 'files' ? 0 : -1}
          className={mode === 'files' ? 'active' : ''}
          onClick={() => onMode('files')}
          onKeyDown={activateTabFromKeyboard}
        >
          <FileText size={14} /> Files
        </button>
        <button
          role="tab"
          id="workspace-tab-search"
          aria-controls="workspace-panel"
          aria-selected={mode === 'search'}
          tabIndex={mode === 'search' ? 0 : -1}
          className={mode === 'search' ? 'active' : ''}
          onClick={() => onMode('search')}
          onKeyDown={activateTabFromKeyboard}
        >
          <Search size={14} /> Search
        </button>
      </div>
      {mode === 'files' && (
        <div
          className="sidebar-tab-panel"
          id="workspace-panel"
          role="tabpanel"
          aria-labelledby="workspace-tab-files"
        >
          <FileExplorerPanel onSearch={() => onMode('search')} />
        </div>
      )}
      {mode === 'search' && (
        <div
          className="sidebar-tab-panel"
          id="workspace-panel"
          role="tabpanel"
          aria-labelledby="workspace-tab-search"
        >
          <SearchPanel />
        </div>
      )}
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
