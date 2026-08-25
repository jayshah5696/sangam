import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { EditorMode } from './documentSessions'

export type ThemeId = 'river' | 'midnight' | 'parchment' | 'cobalt'

export type UiFontId = 'system' | 'inter' | 'plex' | 'serif'
export type UiDensity = 'compact' | 'default' | 'comfortable'
export type EditorSize = 'small' | 'default' | 'large'

export const uiFonts: Array<{ id: UiFontId; name: string; stack: string }> = [
  {
    id: 'system',
    name: 'System default',
    stack: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  { id: 'inter', name: 'Inter', stack: 'Inter, ui-sans-serif, system-ui, -apple-system, sans-serif' },
  {
    id: 'plex',
    name: 'IBM Plex Sans',
    stack: '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  },
  { id: 'serif', name: 'Serif', stack: 'Georgia, "Times New Roman", serif' },
]

export const uiDensities: Array<{ id: UiDensity; name: string }> = [
  { id: 'compact', name: 'Compact' },
  { id: 'default', name: 'Default' },
  { id: 'comfortable', name: 'Comfortable' },
]

export const editorSizes: Array<{ id: EditorSize; name: string }> = [
  { id: 'small', name: 'Small' },
  { id: 'default', name: 'Default' },
  { id: 'large', name: 'Large' },
]

export type InspectorTab = 'properties' | 'research' | 'outline' | 'history' | 'chat'

export const themeColorRoles = [
  { key: 'appBg', label: 'App background', token: '--app-bg' },
  { key: 'surface', label: 'Surface', token: '--surface' },
  { key: 'surfaceSoft', label: 'Raised surface', token: '--surface-soft' },
  { key: 'text', label: 'Text', token: '--text' },
  { key: 'muted', label: 'Muted text', token: '--muted' },
  { key: 'line', label: 'Borders', token: '--line' },
  { key: 'sidebar', label: 'Sidebar', token: '--sidebar' },
  { key: 'sidebarText', label: 'Sidebar text', token: '--sidebar-text' },
  { key: 'accent', label: 'Accent', token: '--accent' },
] as const

export type ThemeColorKey = (typeof themeColorRoles)[number]['key']

export const baseThemeColors: Record<ThemeId, Record<ThemeColorKey, string>> = {
  midnight: {
    appBg: '#08090a',
    surface: '#191a1b',
    surfaceSoft: '#23252a',
    text: '#f7f8f8',
    muted: '#8a8f98',
    line: 'rgba(255, 255, 255, 0.08)',
    sidebar: '#0f1011',
    sidebarText: '#f7f8f8',
    accent: '#5b59dc',
  },
  river: {
    appBg: '#f3f0e7',
    surface: '#fffdf8',
    surfaceSoft: '#ebe7dc',
    text: '#20241f',
    muted: '#5d665f',
    line: '#d5d0c5',
    sidebar: '#1d2b25',
    sidebarText: '#f7f3e9',
    accent: '#327a62',
  },
  parchment: {
    appBg: '#f1e5cc',
    surface: '#fff8e8',
    surfaceSoft: '#e7d7ba',
    text: '#3d3024',
    muted: '#6d5c48',
    line: '#cfb995',
    sidebar: '#4a3728',
    sidebarText: '#fff4dc',
    accent: '#b85c38',
  },
  cobalt: {
    appBg: '#edf4fb',
    surface: '#ffffff',
    surfaceSoft: '#dfeaf5',
    text: '#102a43',
    muted: '#566b81',
    line: '#c8d9e9',
    sidebar: '#102a43',
    sidebarText: '#f4f9ff',
    accent: '#1769c2',
  },
}

export type CustomTheme = {
  id: string
  name: string
  base: ThemeId
  colors: Partial<Record<ThemeColorKey, string>>
}

export const customThemeIdPrefix = 'custom:'

export function customThemeRef(id: string): `${typeof customThemeIdPrefix}${string}` {
  return `${customThemeIdPrefix}${id}`
}

export function isValidColorValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ||
      /^rgba?\(([\d.]+\s*,\s*){2}[\d.]+(?:\s*,\s*[\d.]+)?\)$/.test(value))
  )
}

export function isValidAccentHex(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}

export function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value
  const r = Number.parseInt(full.slice(0, 2), 16)
  const g = Number.parseInt(full.slice(2, 4), 16)
  const b = Number.parseInt(full.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function readableTextColor(hex: string): string {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value
  const [r = 0, g = 0, b = 0] = [0, 2, 4].map((i) => {
    const raw = Number.parseInt(full.slice(i, i + 2), 16) / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance > 0.4 ? '#101318' : '#f7f8f8'
}

export function resolveCustomThemeColors(custom: CustomTheme): Record<ThemeColorKey, string> {
  return { ...baseThemeColors[custom.base], ...custom.colors }
}

const overrideTokens = [...themeColorRoles.map((role) => role.token), '--accent-soft', '--accent-text']

export function applyThemeColors(root: HTMLElement, custom: CustomTheme | null) {
  for (const token of overrideTokens) root.style.removeProperty(token)
  if (!custom) return
  const colors = resolveCustomThemeColors(custom)
  for (const role of themeColorRoles) {
    if (custom.colors[role.key]) root.style.setProperty(role.token, colors[role.key])
  }
  root.style.setProperty('--accent-soft', hexToRgba(colors.accent, 0.16))
  root.style.setProperty('--accent-text', readableTextColor(colors.accent))
}

export const themes: Array<{ id: ThemeId; name: string; description: string; colors: string[] }> = [
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Dark-native near-black workspace',
    colors: ['#08090a', '#191a1b', '#5b59dc'],
  },
  {
    id: 'river',
    name: 'River',
    description: 'Calm green and warm paper',
    colors: ['#202b26', '#f3f0e7', '#d8f0df'],
  },
  {
    id: 'parchment',
    name: 'Parchment',
    description: 'Editorial sepia and ink',
    colors: ['#4a3728', '#f1e5cc', '#b85c38'],
  },
  {
    id: 'cobalt',
    name: 'Cobalt',
    description: 'Crisp blue and cool white',
    colors: ['#102a43', '#edf4fb', '#1769c2'],
  },
]

type WorkspacePreferences = {
  theme: ThemeId | `${typeof customThemeIdPrefix}${string}`
  uiFont: UiFontId
  uiDensity: UiDensity
  editorSize: EditorSize
  customThemes: CustomTheme[]
  leftWidth: number
  rightWidth: number
  leftVisible: boolean
  rightVisible: boolean
  rightTab: InspectorTab
  editorMode: EditorMode
}

type ThemeContextValue = {
  preferences: WorkspacePreferences
  updatePreferences: (patch: Partial<WorkspacePreferences>) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

const defaults: WorkspacePreferences = {
  theme: 'midnight',
  uiFont: 'system',
  uiDensity: 'default',
  editorSize: 'default',
  customThemes: [],
  leftWidth: 282,
  rightWidth: 320,
  leftVisible: true,
  rightVisible: true,
  rightTab: 'properties',
  editorMode: 'preview',
}

const storageKey = 'sangam.workspace-preferences.v1'

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function parseCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const parsed: CustomTheme[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as { id?: unknown; name?: unknown; base?: unknown; colors?: unknown }
    if (typeof candidate.id !== 'string' || !/^[a-z0-9-]+$/.test(candidate.id)) continue
    if (seen.has(candidate.id)) continue
    if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) continue
    if (!['river', 'midnight', 'parchment', 'cobalt'].includes(String(candidate.base))) continue
    const colors: Partial<Record<ThemeColorKey, string>> = {}
    if (typeof candidate.colors === 'object' && candidate.colors !== null) {
      for (const role of themeColorRoles) {
        const color = (candidate.colors as Record<string, unknown>)[role.key]
        if (isValidColorValue(color)) colors[role.key] = color
      }
    }
    seen.add(candidate.id)
    parsed.push({ id: candidate.id, name: candidate.name, base: candidate.base as ThemeId, colors })
  }
  return parsed
}

function loadPreferences(): WorkspacePreferences {
  const isNarrow = typeof window !== 'undefined' && window.innerWidth <= 900
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<WorkspacePreferences>
    const customThemes = parseCustomThemes(stored.customThemes)
    const storedTheme = String(stored.theme ?? defaults.theme)
    const themeIsValidCustom =
      storedTheme.startsWith(customThemeIdPrefix) &&
      customThemes.some((entry) => customThemeRef(entry.id) === storedTheme)
    const theme = themeIsValidCustom
      ? (storedTheme as WorkspacePreferences['theme'])
      : oneOf(stored.theme, ['river', 'midnight', 'parchment', 'cobalt'] as const, defaults.theme)
    return {
      ...defaults,
      ...stored,
      theme,
      uiFont: oneOf(stored.uiFont, ['system', 'inter', 'plex', 'serif'] as const, defaults.uiFont),
      uiDensity: oneOf(stored.uiDensity, ['compact', 'default', 'comfortable'] as const, defaults.uiDensity),
      editorSize: oneOf(stored.editorSize, ['small', 'default', 'large'] as const, defaults.editorSize),
      customThemes,
      rightVisible: isNarrow ? false : (stored.rightVisible ?? true),
      editorMode: ['edit', 'split', 'preview'].includes(String(stored.editorMode))
        ? (stored.editorMode as EditorMode)
        : defaults.editorMode,
    }
  } catch {
    return { ...defaults, rightVisible: isNarrow ? false : true }
  }
}

export function activeCustomTheme(preferences: WorkspacePreferences): CustomTheme | null {
  if (!preferences.theme.startsWith(customThemeIdPrefix)) return null
  const id = preferences.theme.slice(customThemeIdPrefix.length)
  return preferences.customThemes.find((entry) => entry.id === id) ?? null
}

export function applyTypographyAttributes(preferences: WorkspacePreferences) {
  const root = document.documentElement
  const custom = activeCustomTheme(preferences)
  root.dataset.uiFont = preferences.uiFont
  root.dataset.uiDensity = preferences.uiDensity
  root.dataset.editorSize = preferences.editorSize
  root.dataset.theme = custom ? custom.base : preferences.theme
  applyThemeColors(root, custom)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(loadPreferences)

  useEffect(() => {
    applyTypographyAttributes(preferences)
    localStorage.setItem(storageKey, JSON.stringify(preferences))
  }, [preferences])

  const updatePreferences = (patch: Partial<WorkspacePreferences>) => {
    setPreferences((current) => ({ ...current, ...patch }))
  }

  return <ThemeContext.Provider value={{ preferences, updatePreferences }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside ThemeProvider')
  return context
}
