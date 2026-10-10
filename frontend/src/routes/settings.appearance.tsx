import { useEffect, useState } from 'react'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, getRouteApi, Link, redirect, useNavigate } from '@tanstack/react-router'
import {
  Check,
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
  deriveThemeColors,
  editorSizes,
  hexToRgba,
  isValidColorValue,
  readableTextColor,
  resolveCustomThemeColors,
  themeColorRoles,
  themeContrastChecks,
  themeIds,
  themeMode,
  themeModeOf,
  themes,
  uiDensities,
  uiFonts,
  useTheme,
  sidebarFooterToolDefinitions,
  type CustomTheme,
  type ResolvedThemeColors,
  type ThemeColorKey,
  type ThemeMode,
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
  const activeCustom = activeCustomTheme(preferences)
  const activeBase = themes.find((theme) => theme.id === (activeCustom?.base ?? preferences.theme))
  const activeThemeColors = activeCustom
    ? resolveCustomThemeColors(activeCustom)
    : baseThemeColors[activeBase?.id ?? 'midnight']
  const [modeFilter, setModeFilter] = useState<ThemeMode | null>(null)
  const shownMode = modeFilter ?? themeMode(preferences)
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
              <div className="theme-picker-toolbar">
                <div className="density-switch" role="group" aria-label="Theme brightness">
                  {(['dark', 'light'] as const).map((mode) => (
                    <button
                      type="button"
                      key={mode}
                      aria-pressed={shownMode === mode}
                      className={shownMode === mode ? 'density-option selected' : 'density-option'}
                      onClick={() => {
                        setModeFilter(mode)
                        const counterpart = themes.find(
                          (theme) => theme.family === activeBase?.family && theme.mode === mode,
                        )
                        if (counterpart && !activeCustom) updatePreferences({ theme: counterpart.id })
                      }}
                    >
                      {mode === 'dark' ? 'Dark' : 'Light'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="theme-grid settings-theme-grid">
                {themes
                  .filter((theme) => theme.mode === shownMode)
                  .map((theme) => (
                    <button
                      type="button"
                      key={theme.id}
                      className={preferences.theme === theme.id ? 'theme-card selected' : 'theme-card'}
                      aria-pressed={preferences.theme === theme.id}
                      aria-label={theme.name}
                      onClick={() => updatePreferences({ theme: theme.id })}
                    >
                      <CustomThemeWireframe colors={baseThemeColors[theme.id]} />
                      <strong>
                        {theme.family}
                        {preferences.theme === theme.id && <Check size="var(--icon-inline)" />}
                      </strong>
                    </button>
                  ))}
                {preferences.customThemes
                  .filter(
                    (custom) =>
                      themeMode({ theme: customThemeRef(custom.id), customThemes: [custom] }) === shownMode,
                  )
                  .map((custom) => {
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
                      </button>
                    )
                  })}
              </div>
              <ThemeContrastReport colors={activeThemeColors} />
            </SettingsSection>
          )}

          {activeCategory === 'appearance' && (
            <SettingsSection
              id="create-theme"
              icon={Palette}
              title="Create theme"
              description="Pick a background and an accent. The rest is derived and kept readable."
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
                    onChange={(event) => {
                      const font = uiFonts.find((f) => f.id === event.target.value)
                      if (font) updatePreferences({ uiFont: font.id })
                    }}
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
                        onClick={() => updatePreferences({ uiDensity: density.id })}
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
                    onChange={(event) => {
                      const size = editorSizes.find((s) => s.id === event.target.value)
                      if (size) updatePreferences({ editorSize: size.id })
                    }}
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

              <section className="settings-subsection" id="sidebar-tools" tabIndex={-1}>
                <div className="settings-subtitle">
                  <div>
                    <Wrench size="var(--icon-control)" />
                    <strong>Sidebar footer navigation</strong>
                  </div>
                  <span>
                    {Object.values(preferences.sidebarFooterTools).filter(Boolean).length} of{' '}
                    {sidebarFooterToolDefinitions.length} visible
                  </span>
                </div>
                <div className="settings-rows">
                  {sidebarFooterToolDefinitions.map(({ id, label, detail }) => {
                    const isVisible = preferences.sidebarFooterTools?.[id] ?? true
                    return (
                      <SettingRow key={id} id={`sidebar-tool-${id}`} label={label} detail={detail}>
                        <label className="compact-switch">
                          <input
                            type="checkbox"
                            aria-label={`Toggle ${label} visibility`}
                            checked={isVisible}
                            onChange={(event) =>
                              updatePreferences({
                                sidebarFooterTools: {
                                  ...preferences.sidebarFooterTools,
                                  [id]: event.target.checked,
                                },
                              })
                            }
                          />
                          <span>{isVisible ? 'Visible' : 'Hidden'}</span>
                        </label>
                      </SettingRow>
                    )
                  })}
                </div>
              </section>
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
          {activeCategory === 'agents' && <AgentAccessSettings />}

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

const fineTuneRoles = themeColorRoles.filter(
  (role) => role.key !== 'line' && role.key !== 'appBg' && role.key !== 'accent',
)

const importedThemeSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  name: z.string().trim().optional(),
  base: z.enum(themeIds).optional().default('midnight'),
  colors: z.record(z.string(), z.string()).optional().default({}),
})

function CreateThemeSection() {
  const { preferences, updatePreferences } = useTheme()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [importJson, setImportJson] = useState('')
  const [importError, setImportError] = useState('')
  const [copied, setCopied] = useState(false)
  const editing = preferences.customThemes.find((theme) => theme.id === editingId) ?? null
  const active = activeCustomTheme(preferences)

  const patchTheme = (id: string, patch: Partial<CustomTheme>) => {
    updatePreferences({
      customThemes: preferences.customThemes.map((theme) =>
        theme.id === id ? { ...theme, ...patch } : theme,
      ),
    })
  }

  // Background and accent are the only required picks. Everything else follows from them.
  const setCorePick = (theme: CustomTheme, key: 'appBg' | 'accent', value: string) => {
    const current = resolveCustomThemeColors(theme)
    const next = deriveThemeColors(
      key === 'appBg' ? value : current.appBg,
      key === 'accent' ? value : current.accent,
    )
    patchTheme(theme.id, { base: next.base, colors: next.colors })
  }

  const setFineTuneColor = (theme: CustomTheme, key: ThemeColorKey, value: string) => {
    patchTheme(theme.id, { colors: { ...theme.colors, [key]: value } })
  }

  const createTheme = () => {
    const id = `theme-${Date.now().toString(36)}`
    // Start from the theme in use, so tuning what you already run is an edit, not a rebuild.
    const seed = active
      ? resolveCustomThemeColors(active)
      : baseThemeColors[themes.find((t) => t.id === preferences.theme)?.id ?? 'midnight']
    const derived = deriveThemeColors(seed.appBg, seed.accent)
    const theme: CustomTheme = { id, name: 'My theme', base: derived.base, colors: derived.colors }
    updatePreferences({ customThemes: [...preferences.customThemes, theme], theme: customThemeRef(id) })
    setEditingId(id)
  }

  const deleteTheme = (id: string) => {
    const remaining = preferences.customThemes.filter((theme) => theme.id !== id)
    updatePreferences({
      customThemes: remaining,
      theme: preferences.theme === customThemeRef(id) ? 'midnight' : preferences.theme,
    })
    if (editingId === id) setEditingId(null)
  }

  const importTheme = () => {
    setImportError('')
    try {
      const result = importedThemeSchema.safeParse(JSON.parse(importJson))
      if (!result.success) {
        setImportError('That is not valid theme JSON.')
        return
      }
      const parsed = result.data
      const colors: Partial<Record<ThemeColorKey, string>> = {}
      for (const role of themeColorRoles) {
        const color = parsed.colors[role.key]
        if (color && isValidColorValue(color)) colors[role.key] = color
      }
      let id = parsed.id ?? ''
      if (!id || preferences.customThemes.some((theme) => theme.id === id)) {
        id = `theme-${Date.now().toString(36)}`
      }
      const theme: CustomTheme = {
        id,
        name: parsed.name && parsed.name.trim() ? parsed.name : 'Imported theme',
        base: parsed.base,
        colors,
      }
      updatePreferences({
        customThemes: [...preferences.customThemes, theme],
        theme: customThemeRef(id),
      })
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

  if (editing) {
    const colors = resolveCustomThemeColors(editing)
    return (
      <div className="theme-studio">
        <label className="settings-field">
          <span>Name</span>
          <input
            aria-label="Theme name"
            className="theme-name-input"
            value={editing.name}
            onChange={(event) => patchTheme(editing.id, { name: event.target.value })}
          />
        </label>
        <div className="theme-core-picks">
          {(
            [
              ['appBg', 'Background'],
              ['accent', 'Accent'],
            ] as const
          ).map(([key, label]) => (
            <label className="theme-core-pick" key={key}>
              <input
                aria-label={label}
                type="color"
                value={colors[key]}
                onChange={(event) => setCorePick(editing, key, event.target.value)}
              />
              <span>
                <strong>{label}</strong>
                <code>{colors[key]}</code>
              </span>
            </label>
          ))}
        </div>
        <p className="setting-value">
          {themeModeOf(colors.appBg) === 'dark' ? 'Dark' : 'Light'} theme. Everything else is derived and kept
          readable. Changes apply live.
        </p>
        <details className="theme-fine-tune">
          <summary>Fine-tune other colors</summary>
          <p className="setting-value">Changing background or accent again regenerates these.</p>
          <div className="theme-studio-colors">
            {fineTuneRoles.map((role) => (
              <label className="settings-field theme-color-row" key={role.key}>
                <span>{role.label}</span>
                <span className="accent-input">
                  <input
                    aria-label={role.label}
                    type="color"
                    value={colors[role.key]}
                    onChange={(event) => setFineTuneColor(editing, role.key, event.target.value)}
                  />
                  <code>{colors[role.key]}</code>
                </span>
              </label>
            ))}
          </div>
        </details>
        <div className="theme-builder-actions">
          <button type="button" className="secondary-action" onClick={() => setEditingId(null)}>
            Done
          </button>
          <button type="button" className="secondary-action" onClick={() => void exportTheme(editing)}>
            {copied ? <Check size="var(--icon-inline)" /> : null}
            {copied ? 'Copied JSON' : 'Export JSON'}
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
    )
  }

  return (
    <div className="theme-studio">
      <div className="theme-builder-actions">
        <button type="button" className="secondary-action" onClick={createTheme}>
          <Plus size="var(--icon-inline)" />
          New theme
        </button>
        {active && (
          <button type="button" className="secondary-action" onClick={() => setEditingId(active.id)}>
            Edit {active.name}
          </button>
        )}
      </div>
      <details className="theme-import">
        <summary>Import theme JSON</summary>
        <textarea
          aria-label="Theme JSON"
          value={importJson}
          placeholder='{"name":"My theme","base":"midnight","colors":{"accent":"#ff8800"}}'
          onChange={(event) => setImportJson(event.target.value)}
        />
        {importError && (
          <p className="error-text" role="alert">
            {importError}
          </p>
        )}
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
  )
}

function CustomThemeWireframe({ colors }: { colors: Record<ThemeColorKey, string> }) {
  const ink = readableTextColor(colors.surface)
  return (
    <span className="theme-wireframe" aria-hidden="true" style={{ background: colors.surface, color: ink }}>
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

function ThemeContrastReport({ colors }: { colors: ResolvedThemeColors }) {
  const checks = themeContrastChecks(colors)
  const failing = checks.filter((check) => check.ratio === null || check.ratio < check.minimum)
  return (
    <details className="theme-contrast">
      <summary>
        {failing.length === 0
          ? 'Contrast: all readability checks pass'
          : `Contrast: ${failing.length} of ${checks.length} checks are low`}
      </summary>
      <ul>
        {checks.map((check) => {
          const pass = check.ratio !== null && check.ratio >= check.minimum
          return (
            <li key={check.id}>
              <span
                className="theme-contrast-sample"
                aria-hidden="true"
                style={{ color: check.foreground, background: check.background }}
              >
                Aa
              </span>
              <span className="theme-contrast-label">{check.label}</span>
              <code>{check.ratio === null ? 'n/a' : `${check.ratio.toFixed(1)}:1`}</code>
              <span className={pass ? 'theme-contrast-badge pass' : 'theme-contrast-badge low'}>
                {pass ? 'Pass' : `Below ${check.minimum}:1`}
              </span>
            </li>
          )
        })}
      </ul>
    </details>
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
