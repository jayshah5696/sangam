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
  Palette,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Tags,
  Trash2,
  Type,
  Wrench,
} from 'lucide-react'
import { api, type Folder, type Tag } from '../api'
import { AgentAccessSettings } from '../components/AgentAccessSettings'
import { ChatModelSettings } from '../components/ChatModelSettings'
import { settingsCategories } from '../components/SettingsSidebar'
import {
  activeCustomTheme,
  baseThemeColors,
  customThemeRef,
  editorSizes,
  hexToRgba,
  isValidColorValue,
  readableTextColor,
  resolveCustomThemeColors,
  themeColorRoles,
  themes,
  uiDensities,
  uiFonts,
  useTheme,
  type CustomTheme,
  type EditorSize,
  type ThemeColorKey,
  type ThemeId,
  type UiDensity,
  type UiFontId,
} from '../theme'
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
                {preferences.customThemes.map((custom) => {
                  const ref = customThemeRef(custom.id)
                  const selected = preferences.theme === ref
                  const colors = resolveCustomThemeColors(custom)
                  return (
                    <button
                      type="button"
                      key={ref}
                      className={selected ? 'theme-card selected' : 'theme-card'}
                      aria-pressed={selected}
                      onClick={() => updatePreferences({ theme: ref })}
                    >
                      <CustomThemeWireframe colors={colors} />
                      <strong>
                        {custom.name}
                        {selected && <Check size="var(--icon-inline)" />}
                      </strong>
                      <small>Custom theme · {custom.base}</small>
                    </button>
                  )
                })}
              </div>
            </SettingsSection>
          )}

          {activeCategory === 'appearance' && (
            <SettingsSection
              id="create-theme"
              icon={Palette}
              title="Create theme"
              description="Build a theme from a base palette, edit its colors with live preview on the real workspace, and share it as JSON."
            >
              <CreateThemeSection />
            </SettingsSection>
          )}

          {activeCategory === 'appearance' && (
            <SettingsSection
              id="typography"
              icon={Type}
              title="Typography"
              description="Choose interface fonts and text density. Preferences apply before first paint and stay in this browser."
            >
              <div className="settings-rows">
                <SettingRow
                  id="typography-ui-font"
                  label="Interface font"
                  detail="Application chrome, menus, and controls"
                >
                  <select
                    aria-label="Interface font"
                    className="settings-select"
                    value={preferences.uiFont}
                    onChange={(event) => updatePreferences({ uiFont: event.target.value as UiFontId })}
                  >
                    {uiFonts.map((font) => (
                      <option key={font.id} value={font.id} style={{ fontFamily: font.stack }}>
                        {font.name}
                      </option>
                    ))}
                  </select>
                </SettingRow>
                <SettingRow
                  id="typography-density"
                  label="Interface density"
                  detail="Scales labels, controls, and panel text together"
                >
                  <div className="density-switch" role="group" aria-label="Interface density">
                    {uiDensities.map((density) => (
                      <button
                        type="button"
                        key={density.id}
                        aria-pressed={preferences.uiDensity === density.id}
                        className={
                          preferences.uiDensity === density.id ? 'density-option selected' : 'density-option'
                        }
                        onClick={() => updatePreferences({ uiDensity: density.id as UiDensity })}
                      >
                        {density.name}
                      </button>
                    ))}
                  </div>
                </SettingRow>
                <SettingRow
                  id="typography-editor-size"
                  label="Editor text size"
                  detail="Editable document content only"
                >
                  <select
                    aria-label="Editor text size"
                    className="settings-select"
                    value={preferences.editorSize}
                    onChange={(event) => updatePreferences({ editorSize: event.target.value as EditorSize })}
                  >
                    {editorSizes.map((size) => (
                      <option key={size.id} value={size.id}>
                        {size.name}
                      </option>
                    ))}
                  </select>
                </SettingRow>
                <SettingRow
                  id="typography-reset"
                  label="Reset typography"
                  detail="Return fonts, density, and editor size to their defaults"
                >
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() =>
                      updatePreferences({
                        uiFont: 'system',
                        uiDensity: 'default',
                        editorSize: 'default',
                      })
                    }
                  >
                    <RotateCcw size="var(--icon-inline)" />
                    Reset
                  </button>
                </SettingRow>
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

const studioEditableRoles = themeColorRoles.filter((role) => role.key !== 'line')

function CreateThemeSection() {
  const { preferences, updatePreferences } = useTheme()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [importJson, setImportJson] = useState('')
  const [importError, setImportError] = useState('')
  const [copied, setCopied] = useState(false)
  const editing = preferences.customThemes.find((theme) => theme.id === editingId) ?? null

  const patchTheme = (id: string, patch: Partial<CustomTheme>) => {
    updatePreferences({
      customThemes: preferences.customThemes.map((theme) =>
        theme.id === id ? { ...theme, ...patch } : theme,
      ),
    })
  }

  const setColor = (id: string, key: ThemeColorKey, value: string) => {
    const current = preferences.customThemes.find((theme) => theme.id === id)
    if (!current) return
    patchTheme(id, { colors: { ...current.colors, [key]: value } })
  }

  const createTheme = () => {
    const id = `theme-${Date.now().toString(36)}`
    const theme: CustomTheme = {
      id,
      name: 'My theme',
      base: activeCustomTheme(preferences)?.base ?? (preferences.theme as ThemeId),
      colors: {},
    }
    updatePreferences({ customThemes: [...preferences.customThemes, theme], theme: customThemeRef(id) })
    setEditingId(id)
  }

  const deleteTheme = (id: string) => {
    const remaining = preferences.customThemes.filter((theme) => theme.id !== id)
    updatePreferences({
      customThemes: remaining,
      theme:
        preferences.theme === customThemeRef(id)
          ? (activeCustomTheme(preferences)?.base ?? 'midnight')
          : preferences.theme,
    })
    if (editingId === id) setEditingId(null)
  }

  const importTheme = () => {
    setImportError('')
    try {
      const parsed = JSON.parse(importJson) as Record<string, unknown>
      const colors: Partial<Record<ThemeColorKey, string>> = {}
      const rawColors = (parsed.colors ?? {}) as Record<string, unknown>
      for (const role of themeColorRoles) {
        const color = rawColors[role.key]
        if (isValidColorValue(color)) colors[role.key] = color
      }
      const base = ['river', 'midnight', 'parchment', 'cobalt'].includes(String(parsed.base))
        ? (parsed.base as ThemeId)
        : 'midnight'
      let id = typeof parsed.id === 'string' && /^[a-z0-9-]+$/.test(parsed.id) ? parsed.id : ''
      if (!id || preferences.customThemes.some((theme) => theme.id === id)) {
        id = `theme-${Date.now().toString(36)}`
      }
      const theme: CustomTheme = {
        id,
        name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : 'Imported theme',
        base,
        colors,
      }
      updatePreferences({
        customThemes: [...preferences.customThemes, theme],
        theme: customThemeRef(id),
      })
      setEditingId(id)
      setImportJson('')
    } catch {
      setImportError('That is not valid theme JSON.')
    }
  }

  const exportTheme = async (theme: CustomTheme) => {
    await navigator.clipboard.writeText(JSON.stringify(theme, null, 2))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="theme-studio">
      {!editing && (
        <div className="theme-studio-empty">
          <p>
            Build a theme from a base palette, edit its color roles with live preview, and share it as JSON.
          </p>
          <div className="theme-builder-actions">
            <button type="button" className="secondary-action" onClick={createTheme}>
              <Plus size="var(--icon-inline)" />
              New theme
            </button>
          </div>
          <details className="theme-import">
            <summary>Import theme JSON</summary>
            <textarea
              aria-label="Theme JSON"
              value={importJson}
              placeholder='{"id":"my-theme","name":"My theme","base":"midnight","colors":{"accent":"#ff8800"}}'
              onChange={(event) => setImportJson(event.target.value)}
            />
            {importError && <p className="error-text">{importError}</p>}
            <button
              type="button"
              className="secondary-action"
              disabled={!importJson.trim()}
              onClick={importTheme}
            >
              Import
            </button>
          </details>
        </div>
      )}
      {editing && (
        <div className="theme-studio-editor">
          <div className="theme-studio-row">
            <label className="settings-field">
              <span>Name</span>
              <input
                aria-label="Theme name"
                value={editing.name}
                onChange={(event) => patchTheme(editing.id, { name: event.target.value })}
              />
            </label>
            <label className="settings-field">
              <span>Base palette</span>
              <select
                aria-label="Base palette"
                className="settings-select"
                value={editing.base}
                onChange={(event) => patchTheme(editing.id, { base: event.target.value as ThemeId })}
              >
                {themes.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="theme-studio-colors">
            {studioEditableRoles.map((role) => {
              const value = editing.colors[role.key] ?? baseThemeColors[editing.base][role.key]
              return (
                <label className="settings-field theme-color-row" key={role.key}>
                  <span>{role.label}</span>
                  <span className="accent-input">
                    <input
                      aria-label={role.label}
                      type="color"
                      value={value}
                      onChange={(event) => setColor(editing.id, role.key, event.target.value)}
                    />
                    <code>{value}</code>
                  </span>
                </label>
              )
            })}
          </div>
          <p className="setting-value">
            Changes apply live across the workspace. Unset roles follow the base palette.
          </p>
          <div className="theme-builder-actions">
            {preferences.theme !== customThemeRef(editing.id) && (
              <button
                type="button"
                className="secondary-action"
                onClick={() => updatePreferences({ theme: customThemeRef(editing.id) })}
              >
                Use this theme
              </button>
            )}
            {preferences.theme === customThemeRef(editing.id) && (
              <span className="setting-value">
                <Check size="var(--icon-inline)" /> Active
              </span>
            )}
            <button type="button" className="secondary-action" onClick={() => void exportTheme(editing)}>
              {copied ? <Check size="var(--icon-inline)" /> : null}
              {copied ? 'Copied JSON' : 'Export JSON'}
            </button>
            <button type="button" className="secondary-action" onClick={() => setEditingId(null)}>
              Done
            </button>
            <button
              type="button"
              className="secondary-action danger-action"
              onClick={() => deleteTheme(editing.id)}
            >
              <Trash2 size="var(--icon-inline)" />
              Delete
            </button>
          </div>
        </div>
      )}
      {preferences.customThemes.length > 0 && !editing && (
        <ul className="theme-studio-list">
          {preferences.customThemes.map((theme) => (
            <li key={theme.id}>
              <strong>{theme.name}</strong>
              <span className="setting-value">
                {preferences.theme === customThemeRef(theme.id) ? 'Active' : theme.base}
              </span>
              <button
                type="button"
                className="secondary-action"
                onClick={() => {
                  setEditingId(theme.id)
                  if (preferences.theme !== customThemeRef(theme.id)) {
                    updatePreferences({ theme: customThemeRef(theme.id) })
                  }
                }}
              >
                Edit
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CustomThemeWireframe({ colors }: { colors: Record<ThemeColorKey, string> }) {
  const ink = readableTextColor(colors.surface)
  return (
    <span className="theme-wireframe" aria-hidden="true" style={{ background: colors.surface }}>
      <i className="theme-wireframe-sidebar" style={{ background: colors.sidebar }}>
        <b style={{ background: hexToRgba(colors.sidebarText, 0.4) }} />
        <b style={{ background: hexToRgba(colors.sidebarText, 0.25) }} />
        <b style={{ background: hexToRgba(colors.sidebarText, 0.25) }} />
      </i>
      <i className="theme-wireframe-editor">
        <b style={{ background: hexToRgba(ink, 0.8), width: '72%', height: '7px' }} />
        <b style={{ background: hexToRgba(ink, 0.3) }} />
        <b style={{ background: hexToRgba(ink, 0.3) }} />
        <b style={{ background: hexToRgba(ink, 0.3) }} />
      </i>
      <i className="theme-wireframe-inspector">
        <b style={{ background: hexToRgba(ink, 0.25) }} />
        <b style={{ background: hexToRgba(ink, 0.25) }} />
        <b style={{ background: colors.accent }} />
      </i>
      <i
        className="theme-wireframe-focus"
        style={{ borderColor: colors.accent, background: hexToRgba(colors.accent, 0.18) }}
      />
    </span>
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
