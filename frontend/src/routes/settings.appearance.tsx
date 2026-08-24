import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, getRouteApi, Link, redirect, useNavigate } from '@tanstack/react-router'
import {
  Check,
  Activity,
  Archive,
  FolderTree,
  MonitorCog,
  Paintbrush,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Tags,
  Wrench,
} from 'lucide-react'
import { api, type Folder, type Tag } from '../api'
import { AgentAccessSettings } from '../components/AgentAccessSettings'
import { ChatModelSettings } from '../components/ChatModelSettings'
import { settingsCategories } from '../components/SettingsSidebar'
import { themes, useTheme } from '../theme'
import { useWorkbench } from '../workbench'

export const Route = createFileRoute('/settings/appearance')({
  beforeLoad: () => {
    throw redirect({ to: '/settings' })
  },
})

const settingsRoute = getRouteApi('/settings')

export function WorkspaceSettings() {
  const { category: activeCategory, destination } = settingsRoute.useSearch()
  const navigate = useNavigate({ from: '/settings' })
  const { preferences, updatePreferences } = useTheme()
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const tags = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.listFolders })
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.health() })
  const htmlJavascript = useQuery({
    queryKey: ['html-javascript-settings'],
    queryFn: api.getHtmlJavascriptSettings,
  })
  const updateHtmlJavascript = useMutation({
    mutationFn: (enabled: boolean) => api.updateHtmlJavascriptSettings(htmlJavascript.data!, enabled),
    onSuccess: (next) => {
      queryClient.setQueryData(['html-javascript-settings'], next)
      void queryClient.invalidateQueries({ queryKey: ['trusted-preview'] })
      void queryClient.invalidateQueries({ queryKey: ['publication-content'] })
    },
  })
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

  const [pendingDestination, setPendingDestination] = useState<string | null>(destination ?? null)
  const activeDefinition = settingsCategories.find((item) => item.id === activeCategory)!

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

  return (
    <div className="settings-control-center">
      <div className="settings-content">
        <header className="settings-compact-header">
          <div>
            <p className="settings-breadcrumb">Settings / {activeDefinition.label}</p>
            <h1>{activeDefinition.label}</h1>
            <p>{activeDefinition.description}</p>
          </div>
          <ScopeBadge scope={activeCategory === 'appearance' ? 'browser' : 'workspace'} />
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
                      {preferences.theme === theme.id && <Check size="var(--icon-inline)" />}
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
              title="Workbench controls"
              description="Configure local layout and the workspace HTML execution policy."
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
                    <RotateCcw size="var(--icon-inline)" />
                    Reset layout
                  </button>
                </SettingRow>
                <SettingRow
                  id="html-javascript"
                  label="HTML JavaScript"
                  detail="Run saved HTML scripts in Sangam's isolated runtime"
                >
                  <label className="compact-switch">
                    <input
                      type="checkbox"
                      aria-label="Enable HTML JavaScript"
                      checked={htmlJavascript.data?.enabled ?? false}
                      disabled={!htmlJavascript.data || updateHtmlJavascript.isPending}
                      onChange={(event) => updateHtmlJavascript.mutate(event.target.checked)}
                    />
                    <span>{htmlJavascript.data?.enabled ? 'Enabled' : 'Disabled'}</span>
                  </label>
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
                    <Tags size="var(--icon-control)" />
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
                    <FolderTree size="var(--icon-control)" />
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
          {activeCategory === 'agents' && (
            <>
              <AgentAccessSettings />
              <SettingsDestination
                id="agent-activity"
                icon={Activity}
                title="Agent activity"
                description="Review accepted, denied, conflicted, and failed agent operations."
                to="/activity"
                action="Review activity"
              />
            </>
          )}

          {activeCategory === 'operations' && (
            <SettingsSection
              id="operations"
              icon={Wrench}
              title="Workspace operations"
              description="Perform derived data index rebuilding and inspect server status."
            >
              <div className="settings-rows">
                <SettingsDestination
                  id="workspace-integrity"
                  icon={ShieldCheck}
                  title="Workspace integrity"
                  description="Review unresolved differences between canonical data and materialized files."
                  to="/reconciliation"
                  action="Review conflicts"
                />
                <SettingsDestination
                  id="workspace-backups"
                  icon={Archive}
                  title="Backups"
                  description="Create, verify, and remove workspace recovery sets."
                  to="/backups"
                  action="Manage backups"
                />
                {health.data?.karakeep_configured && (
                  <SettingsDestination
                    id="karakeep-imports"
                    icon={Archive}
                    title="Karakeep imports"
                    description="Import archived sources while preserving provenance."
                    to="/karakeep"
                    action="Manage imports"
                  />
                )}
                <div className="maintenance-row" id="maintenance" tabIndex={-1}>
                  <div>
                    <RefreshCw size="var(--icon-control)" />
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
                    <RefreshCw size="var(--icon-inline)" className={reindex.isPending ? 'spin' : ''} />
                    {reindex.isPending ? 'Rebuilding…' : 'Rebuild index'}
                  </button>
                </div>
                {reindex.isSuccess && (
                  <p className="operation-result success" role="status">
                    <Check size="var(--icon-inline)" />
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
                    <Wrench size="var(--icon-control)" />
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
                    <RefreshCw size="var(--icon-inline)" className={health.isFetching ? 'spin' : ''} />
                    {health.isFetching ? 'Refreshing…' : 'Refresh server status'}
                  </button>
                </div>
                {health.isSuccess && (
                  <p className="operation-result success" role="status">
                    <Check size="var(--icon-inline)" />
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

function SettingsDestination({
  id,
  icon: Icon,
  title,
  description,
  to,
  action,
}: {
  id: string
  icon: typeof Paintbrush
  title: string
  description: string
  to: '/activity' | '/reconciliation' | '/backups' | '/karakeep'
  action: string
}) {
  return (
    <div className="maintenance-row" id={id} tabIndex={-1}>
      <div>
        <Icon size="var(--icon-control)" />
        <span>
          <strong>{title}</strong>
          <small>{description}</small>
        </span>
      </div>
      <Link className="secondary-action" to={to}>
        {action}
      </Link>
    </div>
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
        <Icon size="var(--icon-section)" />
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
