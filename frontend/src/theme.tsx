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

export type CustomTheme = { base: ThemeId; accent: string }

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

export function isValidAccentHex(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
}

export function applyCustomTheme(root: HTMLElement, custom: CustomTheme | null) {
  if (custom) {
    root.dataset.theme = custom.base
    root.style.setProperty('--accent', custom.accent)
    root.style.setProperty('--accent-soft', hexToRgba(custom.accent, 0.16))
    root.style.setProperty('--accent-text', readableTextColor(custom.accent))
  } else {
    root.style.removeProperty('--accent')
    root.style.removeProperty('--accent-soft')
    root.style.removeProperty('--accent-text')
  }
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
  theme: ThemeId
  uiFont: UiFontId
  uiDensity: UiDensity
  editorSize: EditorSize
  customTheme: CustomTheme | null
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
  customTheme: null,
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

function parseCustomTheme(value: unknown): CustomTheme | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { base?: unknown; accent?: unknown }
  if (!candidate.base || !isValidAccentHex(candidate.accent)) return null
  if (!['river', 'midnight', 'parchment', 'cobalt'].includes(String(candidate.base))) return null
  return { base: candidate.base as ThemeId, accent: candidate.accent }
}

function loadPreferences(): WorkspacePreferences {
  const isNarrow = typeof window !== 'undefined' && window.innerWidth <= 900
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<WorkspacePreferences>
    return {
      ...defaults,
      ...stored,
      uiFont: oneOf(stored.uiFont, ['system', 'inter', 'plex', 'serif'] as const, defaults.uiFont),
      uiDensity: oneOf(stored.uiDensity, ['compact', 'default', 'comfortable'] as const, defaults.uiDensity),
      editorSize: oneOf(stored.editorSize, ['small', 'default', 'large'] as const, defaults.editorSize),
      customTheme: parseCustomTheme(stored.customTheme),
      rightVisible: isNarrow ? false : (stored.rightVisible ?? true),
      editorMode: ['edit', 'split', 'preview'].includes(String(stored.editorMode))
        ? (stored.editorMode as EditorMode)
        : defaults.editorMode,
    }
  } catch {
    return { ...defaults, rightVisible: isNarrow ? false : true }
  }
}

export function applyTypographyAttributes(preferences: WorkspacePreferences) {
  const root = document.documentElement
  root.dataset.uiFont = preferences.uiFont
  root.dataset.uiDensity = preferences.uiDensity
  root.dataset.editorSize = preferences.editorSize
  root.dataset.theme = preferences.customTheme ? preferences.customTheme.base : preferences.theme
  applyCustomTheme(root, preferences.customTheme)
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
