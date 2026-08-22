import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import {
  CloudOff,
  FileText,
  Globe2,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShieldAlert,
  Trash2,
  RefreshCw,
} from 'lucide-react'
import { api, type DocumentSummary } from '../api'
import { FileExplorerPanel } from '../components/FileExplorer'
import { CommandPalette } from '../components/CommandPalette'
import { SettingsSidebar } from '../components/SettingsSidebar'
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
  const isSettings = location.pathname.startsWith('/settings')
  const locationKey = location.state.__TSR_key ?? location.href
  const sidebarVisible = narrowSidebar ? mobileSidebarLocationKey === locationKey : preferences.leftVisible

  useEffect(() => {
    if (mobileSidebarLocationKey === null || mobileSidebarLocationKey === locationKey) return
    const frame = window.requestAnimationFrame(() => setMobileSidebarLocationKey(null))
    return () => window.cancelAnimationFrame(frame)
  }, [locationKey, mobileSidebarLocationKey])

  useEffect(() => {
    if (isSettings || location.pathname.startsWith('/p/')) return
    sessionStorage.setItem('sangam.settings-return-to', location.href)
  }, [isSettings, location.href, location.pathname])

  const returnFromSettings = useCallback(() => {
    const returnTo = sessionStorage.getItem('sangam.settings-return-to')
    void navigate({ href: returnTo?.startsWith('/') ? returnTo : '/', replace: true })
  }, [navigate])

  useEffect(() => {
    if (!isSettings) return
    const exitSettings = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"], [role="listbox"]')) {
        return
      }
      event.preventDefault()
      returnFromSettings()
    }
    window.addEventListener('keydown', exitSettings)
    return () => window.removeEventListener('keydown', exitSettings)
  }, [isSettings, returnFromSettings])

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
            <button
              className="sidebar-backdrop"
              aria-label={isSettings ? 'Close settings sidebar' : 'Close workspace sidebar'}
              onClick={hideSidebar}
            />
          )}
          <PrimarySidebar
            mode={sidebarMode}
            modal={narrowSidebar}
            onCollapse={hideSidebar}
            onMode={(next) => void chooseSidebarMode(next)}
            settings={isSettings}
            onSettingsBack={returnFromSettings}
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
          aria-label={isSettings ? 'Show settings sidebar' : 'Show workspace sidebar'}
          title={isSettings ? 'Show settings sidebar' : 'Show workspace sidebar'}
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
  settings,
  onSettingsBack,
  style,
}: {
  mode: SidebarMode
  modal: boolean
  onCollapse: () => void
  onMode: (mode: SidebarMode) => void
  settings: boolean
  onSettingsBack: () => void
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
        if (settings) return
        event.preventDefault()
        event.stopPropagation()
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
  }, [modal, settings])

  return (
    <aside
      ref={sidebarRef}
      className="primary-sidebar ui-rail ui-rail--inverse"
      style={style}
      aria-label={settings ? 'Settings sidebar' : 'Workspace sidebar'}
      aria-modal={modal || undefined}
      role={modal ? 'dialog' : undefined}
    >
      <header className="sidebar-brandbar ui-rail-header">
        <Link to="/" className="sidebar-brand" aria-label="Sangam home">
          <img src="/sangam-mark.svg" alt="" />
          <span>
            <strong>Sangam</strong>
            <small>{settings ? 'Settings' : 'Documents, plainly.'}</small>
          </span>
        </Link>
        <button
          className="quiet-icon"
          aria-label={settings ? 'Hide settings sidebar' : 'Hide workspace sidebar'}
          title="Hide sidebar"
          onClick={onCollapse}
        >
          <PanelLeftClose size={16} />
        </button>
      </header>
      {settings ? (
        <SettingsSidebar onBack={onSettingsBack} />
      ) : (
        <>
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
          <SidebarLinks onNavigate={modal ? onCollapse : undefined} />
        </>
      )}
    </aside>
  )
}

function SidebarLinks({ onNavigate }: { onNavigate?: () => void }) {
  const links = [
    { to: '/chat' as const, label: 'Workspace chat', icon: MessageSquareText },
    { to: '/publications' as const, label: 'Publications', icon: Globe2 },
    { to: '/trash' as const, label: 'Trash', icon: Trash2 },
    { to: '/settings' as const, label: 'Settings', icon: Settings },
  ]
  return (
    <div className="sidebar-footer">
      <nav className="sidebar-footer-nav" aria-label="Workspace tools">
        {links.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            aria-label={label}
            data-tooltip={label}
            activeProps={{ className: 'active' }}
            onClick={onNavigate}
          >
            <Icon size={16} />
          </Link>
        ))}
      </nav>
      <WorkspaceFreshness />
    </div>
  )
}

function WorkspaceFreshness() {
  const fetching = useIsFetching()
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const conflicts = useQuery({
    queryKey: ['reconciliation'],
    queryFn: api.reconciliation,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  })
  const conflictCount = conflicts.data?.conflicts.length ?? 0
  if (online && !conflicts.isError && fetching === 0 && conflictCount === 0) return null

  const statusClass = !online
    ? 'offline'
    : conflicts.isError
      ? 'unavailable'
      : conflictCount
        ? 'conflict'
        : ''

  return (
    <div className={`workspace-freshness ${statusClass}`} role="status" aria-live="polite">
      {!online ? (
        <>
          <CloudOff size={13} />
          <span>Offline</span>
        </>
      ) : conflicts.isError ? (
        <button type="button" onClick={() => void conflicts.refetch()}>
          <CloudOff size={13} />
          <span>Server unavailable · Retry</span>
        </button>
      ) : conflictCount ? (
        <Link to="/reconciliation" aria-label={`${conflictCount} unresolved workspace conflicts`}>
          <ShieldAlert size={13} />
          <span>
            {conflictCount} unresolved {conflictCount === 1 ? 'conflict' : 'conflicts'}
          </span>
        </Link>
      ) : (
        <>
          <RefreshCw className="spin" size={13} />
          <span>Refreshing {fetching}</span>
        </>
      )}
    </div>
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
