import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, redirect } from '@tanstack/react-router'
import {
  Check,
  FolderTree,
  MonitorCog,
  Paintbrush,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  Tags,
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

export function WorkspaceSettings() {
  const { preferences, updatePreferences } = useTheme()
  const workbench = useWorkbench()
  const queryClient = useQueryClient()
  const tags = useQuery({ queryKey: ['tags'], queryFn: api.listTags })
  const folders = useQuery({ queryKey: ['folders'], queryFn: api.listFolders })
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

  return (
    <div className="settings-control-center simplified-settings">
      <div className="settings-content">
        <header className="settings-compact-header">
          <div>
            <p className="eyebrow">Sangam settings</p>
            <h1>Settings</h1>
          </div>
          <ScopeBadge scope="browser" />
        </header>

        <SettingsSection
          id="appearance"
          icon={Paintbrush}
          title="Appearance"
          description="Color and contrast for this browser."
          scope="browser"
        >
          <div className="theme-grid settings-theme-grid">
            {themes.map((theme) => (
              <button
                key={theme.id}
                className={preferences.theme === theme.id ? 'theme-card selected' : 'theme-card'}
                onClick={() => updatePreferences({ theme: theme.id })}
              >
                <span className="theme-swatches">
                  {theme.colors.map((color) => (
                    <i key={color} style={{ background: color }} />
                  ))}
                </span>
                <strong>
                  {theme.name}
                  {preferences.theme === theme.id && <Check size={13} />}
                </strong>
                <small>{theme.description}</small>
              </button>
            ))}
          </div>
        </SettingsSection>

        <AgentAccessSettings />

        <ChatModelSettings />

        <SettingsSection
          id="workbench"
          icon={MonitorCog}
          title="Workbench"
          description="Resize panels directly by dragging their edges. Editor groups persist in this browser."
          scope="browser"
        >
          <div className="settings-rows">
            <SettingRow label="Workspace sidebar" detail="Show files and search beside your document">
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
              label="Editor groups"
              detail="Return to a single editor and clear the current split arrangement"
            >
              <button className="secondary-action" onClick={workbench.resetLayout}>
                <RotateCcw size={14} />
                Reset layout
              </button>
            </SettingRow>
          </div>
        </SettingsSection>

        <SettingsSection
          id="organization"
          icon={FolderTree}
          title="Files & organization"
          description="Tags, categories, and folder metadata belong to the shared workspace."
          scope="workspace"
        >
          <div className="settings-subsection">
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
              <button disabled={createTag.isPending}>Add tag</button>
            </form>
            <div className="tag-library">
              {tags.data?.map((tag) => (
                <span className="library-tag" key={tag.tag_id}>
                  <i style={{ background: tag.color }} />
                  {tag.name}
                </span>
              ))}
            </div>
          </div>
          <div className="settings-subsection">
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
                <p className="small-muted">Create a folder from Files to organize it here.</p>
              )}
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          id="maintenance"
          icon={SearchCheck}
          title="Maintenance"
          description="Rebuild derived search data from the canonical workspace."
          scope="workspace"
        >
          <div className="maintenance-row">
            <div>
              <SearchCheck size={17} />
              <span>
                <strong>Search index</strong>
                <small>Rebuild full-text search from canonical workspace data.</small>
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
            <p className="operation-result success">
              <Check size={14} />
              Indexed {reindex.data} documents.
            </p>
          )}
          {reindex.isError && (
            <p className="operation-result error-text">
              Search index could not be rebuilt: {reindex.error.message}
            </p>
          )}
        </SettingsSection>
      </div>
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
  scope: 'browser' | 'workspace'
  children: React.ReactNode
}) {
  return (
    <section className="settings-panel" id={id}>
      <header>
        <Icon size={18} />
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <ScopeBadge scope={scope} />
      </header>
      <div className="settings-panel-body">{children}</div>
    </section>
  )
}

function ScopeBadge({ scope }: { scope: 'browser' | 'workspace' }) {
  return (
    <span className={`scope-badge ${scope}`}>
      {scope === 'browser' ? 'This browser' : 'Shared workspace'}
    </span>
  )
}

function SettingRow({
  label,
  detail,
  children,
}: {
  label: string
  detail: string
  children: React.ReactNode
}) {
  return (
    <div className="setting-row">
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
