import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useIsFetching, useQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import {
  CloudOff,
  FileText,
  FolderKanban,
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
import { api } from '../api'
import { FileExplorerPanel } from '../components/FileExplorer'
import { CommandPalette } from '../components/CommandPalette'
import { SettingsRouteSidebar, SettingsSidebar, type SettingsCategory } from '../components/SettingsSidebar'
import { ResizeHandle } from '../components/ResizeHandle'
import { activateTabFromKeyboard } from '../components/tabKeyboard'
import { WorkspaceSearch } from '../components/search/WorkspaceSearch'
import { OPEN_SEARCH_EVENT } from '../savedViews'
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
  const isActivity = location.pathname.startsWith('/activity')
  const isOperations = ['/reconciliation', '/backups', '/karakeep'].includes(location.pathname)
  const usesSettingsRail = isSettings || isActivity || isOperations
  const settingsCategory = isActivity ? 'agents' : isOperations ? 'operations' : undefined
  const locationKey = location.state.__TSR_key ?? location.href
  const sidebarVisible = narrowSidebar ? mobileSidebarLocationKey === locationKey : preferences.leftVisible

  useEffect(() => {
    if (mobileSidebarLocationKey === null || mobileSidebarLocationKey === locationKey) return
    const frame = window.requestAnimationFrame(() => setMobileSidebarLocationKey(null))
    return () => window.cancelAnimationFrame(frame)
  }, [locationKey, mobileSidebarLocationKey])

  useEffect(() => {
    if (usesSettingsRail || location.pathname.startsWith('/p/')) return
    sessionStorage.setItem('sangam.settings-return-to', location.href)
  }, [location.href, location.pathname, usesSettingsRail])

  const returnFromSettings = useCallback(() => {
    const returnTo = sessionStorage.getItem('sangam.settings-return-to')
    void navigate({ href: returnTo?.startsWith('/') ? returnTo : '/', replace: true })
  }, [navigate])

  useEffect(() => {
    if (!usesSettingsRail) return
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
  }, [returnFromSettings, usesSettingsRail])

  useEffect(() => {
    const open = () => {
      setSidebarMode('search')
      if (narrowSidebar) setMobileSidebarLocationKey(locationKey)
      else updatePreferences({ leftVisible: true })
    }
    window.addEventListener(OPEN_SEARCH_EVENT, open)
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, open)
  }, [locationKey, narrowSidebar, updatePreferences])

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
              aria-label={usesSettingsRail ? 'Close settings sidebar' : 'Close workspace sidebar'}
              onClick={hideSidebar}
            />
          )}
          <PrimarySidebar
            mode={sidebarMode}
            modal={narrowSidebar}
            onCollapse={hideSidebar}
            onMode={(next) => void chooseSidebarMode(next)}
            settings={usesSettingsRail}
            settingsCategory={settingsCategory}
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
          aria-label={usesSettingsRail ? 'Show settings sidebar' : 'Show workspace sidebar'}
          title={usesSettingsRail ? 'Show settings sidebar' : 'Show workspace sidebar'}
          onClick={showSidebar}
        >
          <PanelLeftOpen size="var(--icon-control)" />
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
  settingsCategory,
  onSettingsBack,
  style,
}: {
  mode: SidebarMode
  modal: boolean
  onCollapse: () => void
  onMode: (mode: SidebarMode) => void
  settings: boolean
  settingsCategory?: SettingsCategory
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
          <PanelLeftClose size="var(--icon-control)" />
        </button>
      </header>
      {settings ? (
        settingsCategory ? (
          <SettingsSidebar activeCategory={settingsCategory} onBack={onSettingsBack} />
        ) : (
          <SettingsRouteSidebar onBack={onSettingsBack} />
        )
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
              <FileText size="var(--icon-inline)" /> Files
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
              <Search size="var(--icon-inline)" /> Search
            </button>
          </div>
          {mode === 'files' && (
            <div
              className="sidebar-tab-panel"
              id="workspace-panel"
              role="tabpanel"
              aria-labelledby="workspace-tab-files"
            >
              <FileExplorerPanel />
            </div>
          )}
          {mode === 'search' && (
            <div
              className="sidebar-tab-panel"
              id="workspace-panel"
              role="tabpanel"
              aria-labelledby="workspace-tab-search"
            >
              <WorkspaceSearch />
            </div>
          )}
          <SidebarLinks onNavigate={modal ? onCollapse : undefined} />
        </>
      )}
    </aside>
  )
}

// Visible labels keep destinations recognizable without hovering. Each
// accessible name contains its visible label so voice control matches both.
function SidebarLinks({ onNavigate }: { onNavigate?: () => void }) {
  const links = [
    { to: '/projects' as const, label: 'Projects', short: 'Projects', icon: FolderKanban },
    { to: '/chat' as const, label: 'Workspace chat', short: 'Chat', icon: MessageSquareText },
    { to: '/review' as const, label: 'Review changes', short: 'Review', icon: ShieldAlert },
    { to: '/publications' as const, label: 'Publications', short: 'Publications', icon: Globe2 },
    { to: '/trash' as const, label: 'Trash', short: 'Trash', icon: Trash2 },
    { to: '/settings' as const, label: 'Settings', short: 'Settings', icon: Settings },
  ]
  return (
    <div className="sidebar-footer">
      <nav className="sidebar-footer-nav" aria-label="Workspace tools">
        {links.map(({ to, label, short, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            aria-label={label === short ? undefined : label}
            title={label === short ? undefined : label}
            activeProps={{ className: 'active', 'aria-current': 'page' }}
            onClick={onNavigate}
          >
            <Icon size="var(--icon-inline)" aria-hidden="true" />
            <span>{short}</span>
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
          <CloudOff size="var(--icon-inline)" />
          <span>Offline</span>
        </>
      ) : conflicts.isError ? (
        <button type="button" onClick={() => void conflicts.refetch()}>
          <CloudOff size="var(--icon-inline)" />
          <span>Server unavailable · Retry</span>
        </button>
      ) : conflictCount ? (
        <Link to="/reconciliation" aria-label={`${conflictCount} unresolved workspace conflicts`}>
          <ShieldAlert size="var(--icon-inline)" />
          <span>
            {conflictCount} unresolved {conflictCount === 1 ? 'conflict' : 'conflicts'}
          </span>
        </Link>
      ) : (
        <>
          <RefreshCw className="spin" size="var(--icon-inline)" />
          <span>Refreshing {fetching}</span>
        </>
      )}
    </div>
  )
}
