import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { createRootRouteWithContext, Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import {
  ArchiveRestore,
  Files,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { api, type Document } from '../api'
import { FileExplorerPanel } from '../components/FileExplorer'
import { CommandPalette } from '../components/CommandPalette'
import { ResizeHandle } from '../components/ResizeHandle'
import { StatusBar } from '../components/StatusBar'
import { useTheme } from '../theme'

type RouterContext = { queryClient: QueryClient }
type Activity = 'files' | 'search' | 'reconciliation' | 'backups' | 'trash'

export const Route = createRootRouteWithContext<RouterContext>()({ component: RootLayout })

function RootLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { preferences, updatePreferences } = useTheme()
  const [workspaceActivity, setWorkspaceActivity] = useState<'files' | 'search'>('files')
  const routedActivity = activityForPath(location.pathname)
  const activity = routedActivity === 'files' ? workspaceActivity : routedActivity

  const chooseActivity = async (next: Activity) => {
    if (next === 'files' || next === 'search') {
      setWorkspaceActivity(next)
      if (routedActivity !== 'files') await navigate({ to: '/' })
    }
    if (next === 'reconciliation') await navigate({ to: '/reconciliation' })
    if (next === 'backups') await navigate({ to: '/backups' })
    if (next === 'trash') await navigate({ to: '/trash' })
  }

  return (
    <div className="workbench-shell">
      <ActivityBar
        active={activity}
        onActivity={(next) => void chooseActivity(next)}
        onSettings={() => void navigate({ to: '/settings/appearance' })}
      />
      {preferences.leftVisible ? (
        <>
          <PrimarySidebar
            activity={activity}
            onCollapse={() => updatePreferences({ leftVisible: false })}
            onActivity={(next) => {
              if (next === 'files' || next === 'search') setWorkspaceActivity(next)
            }}
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
          className="sidebar-reveal"
          aria-label="Show workspace sidebar"
          title="Show workspace sidebar"
          onClick={() => updatePreferences({ leftVisible: true })}
        >
          <PanelLeftOpen size={17} />
        </button>
      )}
      <div className="workbench-center">
        <main className="workbench-main" aria-label="Workspace content">
          <Outlet />
        </main>
        <StatusBar />
      </div>
      <CommandPalette
        onFiles={() => {
          setWorkspaceActivity('files')
          if (routedActivity !== 'files') void navigate({ to: '/' })
        }}
        onSearch={() => {
          setWorkspaceActivity('search')
          if (routedActivity !== 'files') void navigate({ to: '/' })
        }}
      />
    </div>
  )
}

function ActivityBar({
  active,
  onActivity,
  onSettings,
}: {
  active: Activity
  onActivity: (activity: Activity) => void
  onSettings: () => void
}) {
  const activities: Array<{ id: Activity; label: string; icon: typeof Files }> = [
    { id: 'files', label: 'Files', icon: Files },
    { id: 'search', label: 'Search', icon: Search },
    { id: 'reconciliation', label: 'Reconciliation', icon: ShieldCheck },
    { id: 'backups', label: 'Backups', icon: ArchiveRestore },
    { id: 'trash', label: 'Trash', icon: Trash2 },
  ]
  return (
    <aside className="activity-bar" aria-label="Workspace activities">
      <Link to="/" className="activity-mark" aria-label="Sangam home" title="Sangam">
        <img src="/sangam-mark.svg" alt="" />
      </Link>
      <nav>
        {activities.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={active === id ? 'activity-button active' : 'activity-button'}
            aria-label={label}
            aria-pressed={active === id}
            title={label}
            onClick={() => onActivity(id)}
          >
            <Icon size={20} strokeWidth={1.8} />
          </button>
        ))}
      </nav>
      <button
        className="activity-button activity-settings"
        aria-label="Settings"
        title="Settings"
        onClick={onSettings}
      >
        <Settings size={20} strokeWidth={1.8} />
      </button>
    </aside>
  )
}

function PrimarySidebar({
  activity,
  onCollapse,
  onActivity,
  style,
}: {
  activity: Activity
  onCollapse: () => void
  onActivity: (activity: Activity) => void
  style: CSSProperties
}) {
  return (
    <aside className="primary-sidebar" style={style}>
      <header className="sidebar-titlebar">
        <div>
          <strong>{activityTitle(activity)}</strong>
          <span>Sangam workspace</span>
        </div>
        <button
          className="quiet-icon"
          aria-label="Hide workspace sidebar"
          title="Hide sidebar"
          onClick={onCollapse}
        >
          <PanelLeftClose size={16} />
        </button>
      </header>
      {activity === 'files' && <FileExplorerPanel onSearch={() => onActivity('search')} />}
      {activity === 'search' && <SearchPanel />}
      {activity === 'reconciliation' && (
        <ActivitySummary
          icon={ShieldCheck}
          title="Workspace integrity"
          text="Scan and resolve changes made outside Sangam."
          href="/reconciliation"
          action="Open reconciliation"
        />
      )}
      {activity === 'backups' && (
        <ActivitySummary
          icon={ArchiveRestore}
          title="Recovery sets"
          text="Create, inspect, and verify database and workspace backups."
          href="/backups"
          action="Open backups"
        />
      )}
      {activity === 'trash' && (
        <ActivitySummary
          icon={Trash2}
          title="Recoverable deletion"
          text="Restore documents without losing stable identity or history."
          href="/trash"
          action="Open trash"
        />
      )}
    </aside>
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

function ActivitySummary({
  icon: Icon,
  title,
  text,
  href,
  action,
}: {
  icon: typeof ShieldCheck
  title: string
  text: string
  href: '/reconciliation' | '/backups' | '/trash'
  action: string
}) {
  return (
    <div className="activity-summary">
      <Icon size={24} />
      <h2>{title}</h2>
      <p>{text}</p>
      <Link to={href}>{action}</Link>
    </div>
  )
}

function DocumentLink({ document, showPath = false }: { document: Document; showPath?: boolean }) {
  const label = document.path?.split('/').at(-1) ?? document.title
  return (
    <Link
      to="/documents/$documentId"
      params={{ documentId: document.document_id }}
      className="file-link"
      activeProps={{ className: 'file-link active' }}
    >
      <Files size={13} />
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

function activityForPath(pathname: string): Activity {
  if (pathname.startsWith('/reconciliation')) return 'reconciliation'
  if (pathname.startsWith('/backups')) return 'backups'
  if (pathname.startsWith('/trash')) return 'trash'
  return 'files'
}

function activityTitle(activity: Activity) {
  return {
    files: 'Files',
    search: 'Search',
    reconciliation: 'Reconciliation',
    backups: 'Backups',
    trash: 'Trash',
  }[activity]
}
