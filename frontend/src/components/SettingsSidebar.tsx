import { useEffect, useRef, useState } from 'react'
import { getRouteApi, useNavigate } from '@tanstack/react-router'
import {
  ArrowLeft,
  Cpu,
  FolderTree,
  MonitorCog,
  Paintbrush,
  Search,
  SearchCheck,
  ShieldCheck,
  Wrench,
} from 'lucide-react'

export type SettingsCategory =
  'appearance' | 'workbench' | 'organization' | 'models' | 'agents' | 'operations'

export const settingsCategories: Array<{
  id: SettingsCategory
  label: string
  description: string
  icon: typeof Paintbrush
}> = [
  { id: 'appearance', label: 'Appearance', description: 'Theme and contrast', icon: Paintbrush },
  { id: 'workbench', label: 'Workbench', description: 'Panels and editor groups', icon: MonitorCog },
  { id: 'organization', label: 'Organization', description: 'Tags and folder metadata', icon: FolderTree },
  { id: 'models', label: 'AI & models', description: 'Connections and model policy', icon: Cpu },
  { id: 'agents', label: 'Agents & access', description: 'Tokens and activity', icon: ShieldCheck },
  { id: 'operations', label: 'Operations', description: 'Integrity and recovery', icon: Wrench },
]

const settingsSearchIndex: Array<{
  id: string
  category: SettingsCategory
  label: string
  description: string
  keywords: string
}> = [
  {
    id: 'appearance',
    category: 'appearance',
    label: 'Theme',
    description: 'Color and contrast for this browser',
    keywords: 'appearance river midnight parchment cobalt',
  },
  {
    id: 'workspace-sidebar',
    category: 'workbench',
    label: 'Workspace sidebar',
    description: 'Show files and search beside the document',
    keywords: 'left panel rail visible hidden',
  },
  {
    id: 'editor-groups',
    category: 'workbench',
    label: 'Editor groups',
    description: 'Reset the current split arrangement',
    keywords: 'split layout reset tabs',
  },
  {
    id: 'html-javascript',
    category: 'workbench',
    label: 'HTML JavaScript',
    description: 'Run saved HTML scripts in the isolated runtime',
    keywords: 'html javascript scripts interactive preview sandbox',
  },
  {
    id: 'tag-settings',
    category: 'organization',
    label: 'Tags',
    description: 'Create shared workspace tags',
    keywords: 'taxonomy labels color',
  },
  {
    id: 'folder-settings',
    category: 'organization',
    label: 'Folder metadata',
    description: 'Set folder categories and tags',
    keywords: 'files category taxonomy',
  },
  {
    id: 'chat-models',
    category: 'models',
    label: 'AI connections and models',
    description: 'Configure providers and model policy',
    keywords: 'openrouter openai endpoint credential inference',
  },
  {
    id: 'agent-access',
    category: 'agents',
    label: 'Agent access',
    description: 'Issue scoped, expiring workspace tokens',
    keywords: 'capability token prefix read write publish revoke',
  },
  {
    id: 'agent-activity',
    category: 'agents',
    label: 'Agent activity',
    description: 'Review agent operations and outcomes',
    keywords: 'audit accepted denied conflicted failed',
  },
  {
    id: 'workspace-integrity',
    category: 'operations',
    label: 'Workspace integrity',
    description: 'Resolve external file changes and conflicts',
    keywords: 'reconciliation disk database conflict external changes',
  },
  {
    id: 'workspace-backups',
    category: 'operations',
    label: 'Backups',
    description: 'Create and verify recovery sets',
    keywords: 'backup recovery restore verify archive',
  },
  {
    id: 'maintenance',
    category: 'operations',
    label: 'Search index',
    description: 'Rebuild full-text search from canonical data',
    keywords: 'maintenance reindex fts recovery',
  },
  {
    id: 'app-version',
    category: 'operations',
    label: 'Server status',
    description: 'Installed Sangam server version and health',
    keywords: 'version status health refresh build',
  },
]

const settingsRoute = getRouteApi('/settings')

export function SettingsSidebar({ onBack }: { onBack: () => void }) {
  const { category: activeCategory } = settingsRoute.useSearch()
  const navigate = useNavigate({ from: '/settings' })
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const searchResults = normalizedQuery
    ? settingsSearchIndex.filter((item) =>
        `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(normalizedQuery),
      )
    : []

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const editable =
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      if (event.key !== '/' || editable) return
      event.preventDefault()
      searchInputRef.current?.focus()
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [])

  const openDestination = (category: SettingsCategory, destination?: string) => {
    setQuery('')
    setSelectedIndex(0)
    void navigate({ search: { category, destination: destination ?? category } })
  }

  return (
    <>
      <div className="settings-sidebar-body">
        <label className="settings-search">
          <Search size={14} />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={(event) => {
              if (!searchResults.length) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const direction = event.key === 'ArrowDown' ? 1 : -1
                setSelectedIndex(
                  (current) => (current + direction + searchResults.length) % searchResults.length,
                )
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                const result = searchResults[selectedIndex]
                if (result) openDestination(result.category, result.id)
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            aria-controls={normalizedQuery ? 'settings-search-results' : undefined}
            aria-activedescendant={
              searchResults[selectedIndex]?.id
                ? `settings-result-${searchResults[selectedIndex]!.id}`
                : undefined
            }
          />
          <kbd>/</kbd>
        </label>
        {normalizedQuery ? (
          <div
            id="settings-search-results"
            className="settings-search-results"
            role="listbox"
            aria-label="Settings search results"
          >
            {searchResults.map((item, index) => (
              <button
                type="button"
                role="option"
                id={`settings-result-${item.id}`}
                aria-selected={index === selectedIndex}
                key={item.id}
                onMouseMove={() => setSelectedIndex(index)}
                onClick={() => openDestination(item.category, item.id)}
              >
                <SearchCheck size={14} />
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.description}</small>
                </span>
              </button>
            ))}
            {searchResults.length === 0 && <p>No matching settings.</p>}
          </div>
        ) : (
          <nav className="settings-nav-items" aria-label="Settings pages">
            {settingsCategories.map(({ id, label, description, icon: Icon }) => (
              <button
                type="button"
                key={id}
                className={activeCategory === id ? 'active' : ''}
                aria-current={activeCategory === id ? 'page' : undefined}
                onClick={() => openDestination(id)}
              >
                <Icon size={15} />
                <span>
                  <strong>{label}</strong>
                  <small>{description}</small>
                </span>
              </button>
            ))}
          </nav>
        )}
      </div>
      <div className="settings-sidebar-footer">
        <button type="button" onClick={onBack}>
          <ArrowLeft size={15} />
          Back to workspace
        </button>
      </div>
    </>
  )
}
