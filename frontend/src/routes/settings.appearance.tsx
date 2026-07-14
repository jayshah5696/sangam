import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { api, type Folder, type Tag } from '../api'
import { themes, useTheme } from '../theme'

export const Route = createFileRoute('/settings/appearance')({ component: WorkspaceSettings })

function WorkspaceSettings() {
  const { preferences, updatePreferences } = useTheme()
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

  return (
    <div className="settings-page">
      <header className="settings-header">
        <p className="eyebrow">Workspace settings</p>
        <h1>Make Sangam yours.</h1>
        <p>Themes and panel layout stay in this browser. Tags, categories, and folders belong to the shared workspace.</p>
      </header>
      <section className="settings-section">
        <div className="settings-title"><div><p className="eyebrow">Appearance</p><h2>Theme</h2></div><span>{themes.length} built in</span></div>
        <div className="theme-grid">
          {themes.map((theme) => (
            <button
              key={theme.id}
              className={preferences.theme === theme.id ? 'theme-card selected' : 'theme-card'}
              onClick={() => updatePreferences({ theme: theme.id })}
            >
              <span className="theme-swatches">{theme.colors.map((color) => <i key={color} style={{ background: color }} />)}</span>
              <strong>{theme.name}</strong>
              <small>{theme.description}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-title"><div><p className="eyebrow">Layout</p><h2>Editable sidebars</h2></div></div>
        <div className="panel-controls">
          <label>
            <span>Left navigation <output>{preferences.leftWidth}px</output></span>
            <input type="range" min="220" max="440" value={preferences.leftWidth} onChange={(event) => updatePreferences({ leftWidth: Number(event.target.value) })} />
          </label>
          <label>
            <span>Right document panel <output>{preferences.rightWidth}px</output></span>
            <input type="range" min="270" max="460" value={preferences.rightWidth} onChange={(event) => updatePreferences({ rightWidth: Number(event.target.value) })} />
          </label>
          <label className="toggle-row"><input type="checkbox" checked={preferences.leftVisible} onChange={(event) => updatePreferences({ leftVisible: event.target.checked })} /> Show file navigation</label>
          <label className="toggle-row"><input type="checkbox" checked={preferences.rightVisible} onChange={(event) => updatePreferences({ rightVisible: event.target.checked })} /> Show document panel</label>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-title"><div><p className="eyebrow">Organization</p><h2>Tags</h2></div><span>{tags.data?.length ?? 0} tags</span></div>
        <form className="tag-creator" onSubmit={(event) => {
          event.preventDefault()
          if (tagName.trim()) createTag.mutate()
        }}>
          <input aria-label="Tag color" type="color" value={tagColor} onChange={(event) => setTagColor(event.target.value)} />
          <input aria-label="Tag name" placeholder="New tag name" value={tagName} onChange={(event) => setTagName(event.target.value)} />
          <button disabled={createTag.isPending}>Add tag</button>
        </form>
        <div className="tag-library">
          {tags.data?.map((tag) => <span className="library-tag" key={tag.tag_id}><i style={{ background: tag.color }} />{tag.name}</span>)}
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-title"><div><p className="eyebrow">Organization</p><h2>Folder categories</h2></div><span>{folders.data?.length ?? 0} folders</span></div>
        <div className="folder-settings-list">
          {folders.data?.map((folder) => (
            <FolderSettings key={`${folder.folder_id}:${folder.metadata_version}`} folder={folder} tags={tags.data ?? []} />
          ))}
          {folders.data?.length === 0 && <p className="small-muted">Create a folder from the left sidebar to organize it here.</p>}
        </div>
      </section>
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
    <article className="folder-setting">
      <div><strong>▾ {folder.path}</strong><small>{folder.document_count} documents</small></div>
      <input aria-label={`Category for ${folder.path}`} placeholder="Category" value={category} onChange={(event) => setCategory(event.target.value)} />
      <div className="compact-tags">
        {tags.map((tag) => (
          <label key={tag.tag_id}>
            <input type="checkbox" checked={selectedTags.includes(tag.tag_id)} onChange={() => setSelectedTags((current) => current.includes(tag.tag_id) ? current.filter((id) => id !== tag.tag_id) : [...current, tag.tag_id])} />
            <i style={{ background: tag.color }} />{tag.name}
          </label>
        ))}
      </div>
      <button onClick={() => update.mutate()} disabled={update.isPending}>Save</button>
    </article>
  )
}
