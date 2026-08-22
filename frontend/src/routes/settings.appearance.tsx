import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, getRouteApi, redirect, useNavigate } from '@tanstack/react-router'
import {
  Check,
  Cpu,
  FolderTree,
  MonitorCog,
  Paintbrush,
  RefreshCw,
  RotateCcw,
  Search,
  SearchCheck,
  ShieldCheck,
  Tags,
  Wrench,
} from 'lucide-react'
import { api, type Folder, type Tag } from '../api'
import { AgentAccessSettings } from '../components/AgentAccessSettings'
import { ChatModelSettings } from '../components/ChatModelSettings'
import { themes, useTheme } from '../theme'
import { useWorkbench } from '../workbench'

export const Route = createFileRoute('/settings/appearance')({
  beforeLoad: () => {
    throw redirect({ to: '/settings' })
  },
})

type SettingsCategory = 'appearance' | 'workbench' | 'organization' | 'models' | 'agents' | 'operations'

const settingsRoute = getRouteApi('/settings')

const settingsCategories: Array<{
  id: SettingsCategory
  label: string
  description: string
  icon: typeof Paintbrush
}> = [
  { id: 'appearance', label: 'Appearance', description: 'Theme and contrast', icon: Paintbrush },
  { id: 'workbench', label: 'Workbench', description: 'Panels and editor groups', icon: MonitorCog },
  { id: 'organization', label: 'Organization', description: 'Tags and folder metadata', icon: FolderTree },
  { id: 'models', label: 'AI & models', description: 'Connections and model policy', icon: Cpu },
  { id: 'agents', label: 'Agents & access', description: 'Scoped workspace tokens', icon: ShieldCheck },
  { id: 'operations', label: 'Operations', description: 'Derived data and recovery', icon: Wrench },
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

export function WorkspaceSettings() {
  const { category: activeCategory, destination } = settingsRoute.useSearch()
  const navigate = useNavigate({ from: '/settings' })
  const { preferences, updatePreferences } = useTheme()
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const tags = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.listFolders })
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.health() })
  const [tagName, setTagName] = useState('')
  const [tagColor, setTagColor] = useState('#327a62')
  const createTag = useMutation({
    mutationFn: () => api.createTag(tagName, tagColor),
    onSuccess: async () => {
      setTagName('')
      await queryClient.invalidateQueries({ queryKey: ['tags'] })
    },
  })
  const reindex = useMutation({ mutationFn: api.rebuildSearch })

  const [settingsQuery, setSettingsQuery] = useState('')
  const [selectedSearchIndex, setSelectedSearchIndex] = useState(0)
  const [pendingDestination, setPendingDestination] = useState<string | null>(destination ?? null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const normalizedQuery = settingsQuery.trim().toLowerCase()
  const searchResults = normalizedQuery
    ? settingsSearchIndex.filter((item) =>
        `${item.label} ${item.description} ${item.keywords}`.toLowerCase().includes(normalizedQuery),
      )
    : []
  const activeDefinition = settingsCategories.find((item) => item.id === activeCategory)!

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

  useEffect(() => {
    const targetId = pendingDestination ?? destination
    if (!targetId) return
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(targetId)
      target?.focus({ preventScroll: true })
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      target?.classList.add('settings-destination-pulse')
      window.setTimeout(() => target?.classList.remove('settings-destination-pulse'), 1200)
      setPendingDestination(null)
      if (destination) {
        void navigate({ search: { category: activeCategory }, replace: true })
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [activeCategory, destination, navigate, pendingDestination])

  const openDestination = (category: SettingsCategory, id?: string) => {
    setSettingsQuery('')
    const target = id ?? category
    setPendingDestination(target)
    void navigate({
      search: { category, destination: id },
    })
  }

  return (
    <div className="settings-control-center">
      <aside className="settings-nav ui-rail" aria-label="Settings navigation">
        <div className="settings-nav-title ui-rail-header">
          <strong>Settings</strong>
          <span>Workspace and local preferences</span>
        </div>
        <label className="settings-search">
          <Search size={14} />
          <input
            ref={searchInputRef}
            type="search"
            value={settingsQuery}
            onChange={(event) => {
              setSettingsQuery(event.target.value)
              setSelectedSearchIndex(0)
            }}
            onKeyDown={(event) => {
              if (!searchResults.length) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const direction = event.key === 'ArrowDown' ? 1 : -1
                setSelectedSearchIndex(
                  (current) => (current + direction + searchResults.length) % searchResults.length,
                )
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                const result = searchResults[selectedSearchIndex]
                if (result) openDestination(result.category, result.id)
              }
            }}
            placeholder="Search settings"
            aria-label="Search settings"
            aria-controls={normalizedQuery ? 'settings-search-results' : undefined}
            aria-activedescendant={
              searchResults[selectedSearchIndex]?.id
                ? `settings-result-${searchResults[selectedSearchIndex]!.id}`
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
                aria-selected={index === selectedSearchIndex}
                key={item.id}
                onMouseMove={() => setSelectedSearchIndex(index)}
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
        <p className="settings-nav-footnote">
          <kbd>⌘K</kbd> opens the workspace switchboard.
        </p>
      </aside>

      <div className="settings-content">
        <header className="settings-compact-header">
          <div>
            <p className="settings-breadcrumb">Settings / {activeDefinition.label}</p>
            <h1>{activeDefinition.label}</h1>
            <p>{activeDefinition.description}</p>
          </div>
          <ScopeBadge
            scope={
              activeCategory === 'appearance' || activeCategory === 'workbench' ? 'browser' : 'workspace'
            }
          />
        </header>

        <main className="settings-main-pane" aria-label={`${activeDefinition.label} settings`}>
          {activeCategory === 'appearance' && (
            <SettingsSection
              id="appearance"
              icon={Paintbrush}
              title="Theme"
              description="Preview the complete Sangam workbench before changing its colors."
            >
              <div className="theme-grid settings-theme-grid">
                {themes.map((theme) => (
                  <button
                    type="button"
                    key={theme.id}
                    className={preferences.theme === theme.id ? 'theme-card selected' : 'theme-card'}
                    aria-pressed={preferences.theme === theme.id}
                    onClick={() => updatePreferences({ theme: theme.id })}
                  >
                    <ThemeWireframe themeId={theme.id} />
                    <strong>
                      {theme.name}
                      {preferences.theme === theme.id && <Check size={14} />}
                    </strong>
                    <small>{theme.description}</small>
                  </button>
                ))}
              </div>
            </SettingsSection>
          )}

          {activeCategory === 'workbench' && (
            <SettingsSection
              id="workbench"
              icon={MonitorCog}
              title="Workbench layout"
              description="Panel visibility and editor groups are stored in this browser."
            >
              <div className="settings-rows">
                <SettingRow
                  id="workspace-sidebar"
                  label="Workspace sidebar"
                  detail="Show files and search beside the active document"
                >
                  <label className="compact-switch">
                    <input
                      type="checkbox"
                      checked={preferences.leftVisible}
                      onChange={(event) => updatePreferences({ leftVisible: event.target.checked })}
                    />
                    <span>{preferences.leftVisible ? 'Visible' : 'Hidden'}</span>
                  </label>
                </SettingRow>
                <SettingRow
                  id="editor-groups"
                  label="Editor groups"
                  detail="Return to one editor and clear the current split arrangement"
                >
                  <button type="button" className="secondary-action" onClick={workbench.resetLayout}>
                    <RotateCcw size={14} />
                    Reset layout
                  </button>
                </SettingRow>
              </div>
            </SettingsSection>
          )}

          {activeCategory === 'organization' && (
            <SettingsSection
              id="organization"
              icon={FolderTree}
              title="Files and organization"
              description="Tags, categories, and folder metadata belong to the shared workspace."
            >
              <section className="settings-subsection" id="tag-settings" tabIndex={-1}>
                <div className="settings-subtitle">
                  <div>
                    <Tags size={15} />
                    <strong>Tags</strong>
                  </div>
                  <span>{tags.data?.length ?? 0}</span>
                </div>
                <form
                  className="tag-creator compact-creator"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (tagName.trim()) createTag.mutate()
                  }}
                >
                  <input
                    aria-label="Tag color"
                    type="color"
                    value={tagColor}
                    onChange={(event) => setTagColor(event.target.value)}
                  />
                  <input
                    aria-label="Tag name"
                    placeholder="New tag name"
                    value={tagName}
                    onChange={(event) => setTagName(event.target.value)}
                  />
                  <button disabled={createTag.isPending}>
                    {createTag.isPending ? 'Adding…' : 'Add tag'}
                  </button>
                </form>
                <div className="tag-library">
                  {tags.data?.map((tag) => (
                    <span className="library-tag" key={tag.tag_id}>
                      <i style={{ background: tag.color }} />
                      {tag.name}
                    </span>
                  ))}
                </div>
              </section>
              <section className="settings-subsection" id="folder-settings" tabIndex={-1}>
                <div className="settings-subtitle">
                  <div>
                    <FolderTree size={15} />
                    <strong>Folder metadata</strong>
                  </div>
                  <span>{folders.data?.length ?? 0}</span>
                </div>
                <div className="folder-settings-list">
                  {folders.data?.map((folder) => (
                    <FolderSettings
                      key={`${folder.folder_id}:${folder.metadata_version}`}
                      folder={folder}
                      tags={tags.data ?? []}
                    />
                  ))}
                  {folders.data?.length === 0 && (
                    <p className="settings-empty-row">Create a folder from Files to organize it here.</p>
                  )}
                </div>
              </section>
            </SettingsSection>
          )}

          {activeCategory === 'models' && <ChatModelSettings />}
          {activeCategory === 'agents' && <AgentAccessSettings />}

          {activeCategory === 'operations' && (
            <SettingsSection
              id="operations"
              icon={Wrench}
              title="Workspace operations"
              description="Perform derived data index rebuilding and inspect server status."
            >
              <div className="settings-rows">
                <div className="maintenance-row" id="maintenance" tabIndex={-1}>
                  <div>
                    <SearchCheck size={17} />
                    <span>
                      <strong>Full-text search index</strong>
                      <small>Rebuild search index from canonical workspace documents.</small>
                    </span>
                  </div>
                  <button
                    className="secondary-action"
                    disabled={reindex.isPending}
                    onClick={() => reindex.mutate()}
                  >
                    <RefreshCw size={14} className={reindex.isPending ? 'spin' : ''} />
                    {reindex.isPending ? 'Rebuilding…' : 'Rebuild index'}
                  </button>
                </div>
                {reindex.isSuccess && (
                  <p className="operation-result success" role="status">
                    <Check size={14} />
                    Indexed {reindex.data} documents.
                  </p>
                )}
                {reindex.isError && (
                  <p className="operation-result error-text" role="alert">
                    Search index could not be rebuilt: {reindex.error.message}
                  </p>
                )}

                <div className="maintenance-row" id="app-version" tabIndex={-1}>
                  <div>
                    <Wrench size={17} />
                    <span>
                      <strong>
                        {health.data ? `Sangam Server v${health.data.version}` : 'Sangam Server'}
                      </strong>
                      <small>
                        {health.data
                          ? `Self-hosted release · System status: ${health.data.status}`
                          : health.isError
                            ? 'Server status is unavailable.'
                            : 'Loading installed version and server status…'}
                      </small>
                    </span>
                  </div>
                  <button
                    className="secondary-action"
                    disabled={health.isFetching}
                    onClick={() => void health.refetch()}
                  >
                    <RefreshCw size={14} className={health.isFetching ? 'spin' : ''} />
                    {health.isFetching ? 'Refreshing…' : 'Refresh server status'}
                  </button>
                </div>
                {health.isSuccess && (
                  <p className="operation-result success" role="status">
                    <Check size={14} />
                    Server is healthy. Running Sangam v{health.data.version}.
                  </p>
                )}
                {health.isError && (
                  <p className="operation-result error-text" role="alert">
                    Server status could not be refreshed.
                  </p>
                )}
              </div>
            </SettingsSection>
          )}
        </main>
      </div>
    </div>
  )
}

function ThemeWireframe({ themeId }: { themeId: string }) {
  return (
    <span className={`theme-wireframe theme-wireframe-${themeId}`} aria-hidden="true">
      <i className="theme-wireframe-sidebar">
        <b />
        <b />
        <b />
      </i>
      <i className="theme-wireframe-editor">
        <b />
        <b />
        <b />
        <b />
      </i>
      <i className="theme-wireframe-inspector">
        <b />
        <b />
        <b />
      </i>
      <i className="theme-wireframe-focus" />
    </span>
  )
}

function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  scope,
  children,
}: {
  id: string
  icon: typeof Paintbrush
  title: string
  description: string
  scope?: 'browser' | 'workspace'
  children: React.ReactNode
}) {
  return (
    <section className="settings-panel" id={id} tabIndex={-1}>
      <header>
        <Icon size={18} />
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        {scope && <ScopeBadge scope={scope} />}
      </header>
      <div className="settings-panel-body">{children}</div>
    </section>
  )
}

function ScopeBadge({ scope }: { scope: 'browser' | 'workspace' }) {
  return (
    <span
      className={`scope-badge ${scope}`}
      title={
        scope === 'browser'
          ? 'Settings apply only to this local browser profile'
          : 'Settings apply to all users sharing this workspace'
      }
    >
      {scope === 'browser' ? 'This browser' : 'Shared workspace'}
    </span>
  )
}

function SettingRow({
  id,
  label,
  detail,
  children,
}: {
  id?: string
  label: string
  detail: string
  children: React.ReactNode
}) {
  return (
    <div className="setting-row" id={id} tabIndex={id ? -1 : undefined}>
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
      {children}
    </div>
  )
}

function FolderSettings({ folder, tags }: { folder: Folder; tags: Tag[] }) {
  const queryClient = useQueryClient()
  const [category, setCategory] = useState(folder.category ?? '')
  const [selectedTags, setSelectedTags] = useState(folder.tags.map((tag) => tag.tag_id))
  const update = useMutation({
    mutationFn: () => api.updateFolderMetadata(folder, category || null, selectedTags),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['folders'] }),
  })
  return (
    <article className="folder-setting compact-folder-setting">
      <div>
        <strong>▾ {folder.path}</strong>
        <small>{folder.document_count} documents</small>
      </div>
      <input
        aria-label={`Category for ${folder.path}`}
        placeholder="Category"
        value={category}
        onChange={(event) => setCategory(event.target.value)}
      />
      <div className="compact-tags">
        {tags.map((tag) => (
          <label key={tag.tag_id}>
            <input
              type="checkbox"
              checked={selectedTags.includes(tag.tag_id)}
              onChange={() =>
                setSelectedTags((current) =>
                  current.includes(tag.tag_id)
                    ? current.filter((id) => id !== tag.tag_id)
                    : [...current, tag.tag_id],
                )
              }
            />
            <i style={{ background: tag.color }} />
            {tag.name}
          </label>
        ))}
      </div>
      <button onClick={() => update.mutate()} disabled={update.isPending}>
        {update.isPending ? 'Saving…' : 'Save'}
      </button>
    </article>
  )
}
