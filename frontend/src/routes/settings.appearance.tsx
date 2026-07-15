import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  ArchiveRestore,
  Check,
  FileKey,
  FolderTree,
  Info,
  Keyboard,
  MonitorCog,
  Paintbrush,
  PanelLeft,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  ShieldCheck,
  Tags,
  Trash2,
} from 'lucide-react'
import { api, type Folder, type Tag } from '../api'
import { themes, useTheme } from '../theme'
import { useWorkbench } from '../workbench'

export const Route = createFileRoute('/settings/appearance')({ component: WorkspaceSettings })

const sections = [
  ['appearance', 'Appearance', Paintbrush],
  ['editor', 'Editor', FileKey],
  ['workbench', 'Workbench', MonitorCog],
  ['organization', 'Files & organization', FolderTree],
  ['recovery', 'Data & recovery', ArchiveRestore],
  ['keyboard', 'Keyboard', Keyboard],
  ['about', 'About', Info],
] as const

function WorkspaceSettings() {
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
    <div className="settings-control-center">
      <nav className="settings-nav" aria-label="Settings sections">
        <div className="settings-nav-title"><strong>Settings</strong><span>Configuration & maintenance</span></div>
        {sections.map(([id, label, Icon]) => <a key={id} href={`#${id}`}><Icon size={14} />{label}</a>)}
      </nav>

      <div className="settings-content">
        <header className="settings-compact-header"><div><p className="eyebrow">Sangam settings</p><h1>Workspace controls</h1></div><ScopeBadge scope="browser" /></header>

        <SettingsSection id="appearance" icon={Paintbrush} title="Appearance" description="Color and contrast for this browser." scope="browser">
          <div className="theme-grid settings-theme-grid">
            {themes.map((theme) => (
              <button key={theme.id} className={preferences.theme === theme.id ? 'theme-card selected' : 'theme-card'} onClick={() => updatePreferences({ theme: theme.id })}>
                <span className="theme-swatches">{theme.colors.map((color) => <i key={color} style={{ background: color }} />)}</span>
                <strong>{theme.name}{preferences.theme === theme.id && <Check size={13} />}</strong>
                <small>{theme.description}</small>
              </button>
            ))}
          </div>
        </SettingsSection>

        <SettingsSection id="editor" icon={FileKey} title="Editor" description="Document editing follows Markdown and keeps unsaved buffers in this browser." scope="browser">
          <div className="settings-rows">
            <SettingRow label="Format" detail="Markdown with live preview, links, diagrams, math, and revisions"><span className="setting-value">Markdown</span></SettingRow>
            <SettingRow label="Autosave" detail="Changes are saved after a short pause; local buffers survive reload"><span className="setting-value">On</span></SettingRow>
            <SettingRow label="Revision comparison" detail="Choose any two revisions from the document inspector"><span className="setting-value">Side by side</span></SettingRow>
          </div>
        </SettingsSection>

        <SettingsSection id="workbench" icon={MonitorCog} title="Workbench" description="Resize panels directly by dragging their edges. Editor groups persist in this browser." scope="browser">
          <div className="settings-rows">
            <SettingRow label="Workspace sidebar" detail="Files, search, integrity, backups, and trash">
              <label className="compact-switch"><input type="checkbox" checked={preferences.leftVisible} onChange={(event) => updatePreferences({ leftVisible: event.target.checked })} /><span>{preferences.leftVisible ? 'Visible' : 'Hidden'}</span></label>
            </SettingRow>
            <SettingRow label="Editor groups" detail="Return to a single editor and clear the current split arrangement">
              <button className="secondary-action" onClick={workbench.resetLayout}><RotateCcw size={14} />Reset layout</button>
            </SettingRow>
            <SettingRow label="Panel sizing" detail="Drag sidebar and inspector edges in the workbench"><span className="setting-value"><PanelLeft size={13} />Direct resize</span></SettingRow>
          </div>
        </SettingsSection>

        <SettingsSection id="organization" icon={FolderTree} title="Files & organization" description="Tags, categories, and folder metadata belong to the shared workspace." scope="workspace">
          <div className="settings-subsection">
            <div className="settings-subtitle"><div><Tags size={15} /><strong>Tags</strong></div><span>{tags.data?.length ?? 0}</span></div>
            <form className="tag-creator compact-creator" onSubmit={(event) => { event.preventDefault(); if (tagName.trim()) createTag.mutate() }}>
              <input aria-label="Tag color" type="color" value={tagColor} onChange={(event) => setTagColor(event.target.value)} />
              <input aria-label="Tag name" placeholder="New tag name" value={tagName} onChange={(event) => setTagName(event.target.value)} />
              <button disabled={createTag.isPending}>Add tag</button>
            </form>
            <div className="tag-library">{tags.data?.map((tag) => <span className="library-tag" key={tag.tag_id}><i style={{ background: tag.color }} />{tag.name}</span>)}</div>
          </div>
          <div className="settings-subsection">
            <div className="settings-subtitle"><div><FolderTree size={15} /><strong>Folder metadata</strong></div><span>{folders.data?.length ?? 0}</span></div>
            <div className="folder-settings-list">
              {folders.data?.map((folder) => <FolderSettings key={`${folder.folder_id}:${folder.metadata_version}`} folder={folder} tags={tags.data ?? []} />)}
              {folders.data?.length === 0 && <p className="small-muted">Create a folder from Files to organize it here.</p>}
            </div>
          </div>
        </SettingsSection>

        <SettingsSection id="recovery" icon={ArchiveRestore} title="Data & recovery" description="Workspace-wide operations are explicit, inspectable, and kept out of everyday editing." scope="workspace">
          <div className="operation-grid">
            <OperationCard icon={ShieldCheck} title="Reconciliation" text="Scan for files changed outside Sangam and resolve conflicts." to="/reconciliation" action="Review integrity" />
            <OperationCard icon={ArchiveRestore} title="Backups" text="Create and verify recovery sets for content, identity, and history." to="/backups" action="Manage backups" />
            <OperationCard icon={Trash2} title="Trash" text="Restore deleted documents without losing identity or revisions." to="/trash" action="Open trash" />
          </div>
          <div className="maintenance-row">
            <div><SearchCheck size={17} /><span><strong>Search index</strong><small>Rebuild full-text search from canonical workspace data.</small></span></div>
            <button className="secondary-action" disabled={reindex.isPending} onClick={() => reindex.mutate()}><RefreshCw size={14} className={reindex.isPending ? 'spin' : ''} />{reindex.isPending ? 'Rebuilding…' : 'Rebuild index'}</button>
          </div>
          {reindex.isSuccess && <p className="operation-result success"><Check size={14} />Indexed {reindex.data} documents.</p>}
          {reindex.isError && <p className="operation-result error-text">Search index could not be rebuilt: {reindex.error.message}</p>}
        </SettingsSection>

        <SettingsSection id="keyboard" icon={Keyboard} title="Keyboard" description="Small, predictable shortcuts for common workbench actions." scope="browser">
          <div className="shortcut-list"><Shortcut keys="⌘ K" action="Open command palette" /><Shortcut keys="⌘ N" action="New document (outside text fields)" /><Shortcut keys="Esc" action="Close command palette or menu" /></div>
        </SettingsSection>

        <SettingsSection id="about" icon={Info} title="About" description="Local-first knowledge work with stable document identity." scope="workspace">
          <div className="settings-rows"><SettingRow label="Sangam" detail="Workspace application"><span className="setting-value">v0.1.0</span></SettingRow><SettingRow label="Storage model" detail="SQLite is canonical for identity and revisions; Markdown files are materialized content"><span className="setting-value">Local first</span></SettingRow></div>
        </SettingsSection>
      </div>
    </div>
  )
}

function SettingsSection({ id, icon: Icon, title, description, scope, children }: { id: string; icon: typeof Paintbrush; title: string; description: string; scope: 'browser' | 'workspace'; children: React.ReactNode }) {
  return <section className="settings-panel" id={id}><header><Icon size={18} /><div><h2>{title}</h2><p>{description}</p></div><ScopeBadge scope={scope} /></header><div className="settings-panel-body">{children}</div></section>
}

function ScopeBadge({ scope }: { scope: 'browser' | 'workspace' }) {
  return <span className={`scope-badge ${scope}`}>{scope === 'browser' ? 'This browser' : 'Shared workspace'}</span>
}

function SettingRow({ label, detail, children }: { label: string; detail: string; children: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong><small>{detail}</small></div>{children}</div>
}

function OperationCard({ icon: Icon, title, text, to, action }: { icon: typeof ShieldCheck; title: string; text: string; to: '/reconciliation' | '/backups' | '/trash'; action: string }) {
  return <article className="operation-card"><Icon size={18} /><strong>{title}</strong><p>{text}</p><Link to={to}>{action} →</Link></article>
}

function Shortcut({ keys, action }: { keys: string; action: string }) {
  return <div><kbd>{keys}</kbd><span>{action}</span></div>
}

function FolderSettings({ folder, tags }: { folder: Folder; tags: Tag[] }) {
  const queryClient = useQueryClient()
  const [category, setCategory] = useState(folder.category ?? '')
  const [selectedTags, setSelectedTags] = useState(folder.tags.map((tag) => tag.tag_id))
  const update = useMutation({ mutationFn: () => api.updateFolderMetadata(folder, category || null, selectedTags), onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['folders'] }) })
  return (
    <article className="folder-setting compact-folder-setting">
      <div><strong>▾ {folder.path}</strong><small>{folder.document_count} documents</small></div>
      <input aria-label={`Category for ${folder.path}`} placeholder="Category" value={category} onChange={(event) => setCategory(event.target.value)} />
      <div className="compact-tags">{tags.map((tag) => <label key={tag.tag_id}><input type="checkbox" checked={selectedTags.includes(tag.tag_id)} onChange={() => setSelectedTags((current) => current.includes(tag.tag_id) ? current.filter((id) => id !== tag.tag_id) : [...current, tag.tag_id])} /><i style={{ background: tag.color }} />{tag.name}</label>)}</div>
      <button onClick={() => update.mutate()} disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save'}</button>
    </article>
  )
}
