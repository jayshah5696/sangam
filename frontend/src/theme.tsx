import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { EditorMode } from './documentSessions'

export type ThemeId = 'river' | 'midnight' | 'parchment' | 'cobalt'

export type UiFontId = 'system' | 'inter' | 'plex' | 'serif'
export type MonoFontId = 'system' | 'sfmono' | 'jetbrains' | 'fira'
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

export const monoFonts: Array<{ id: MonoFontId; name: string; stack: string }> = [
  {
    id: 'system',
    name: 'System default',
    stack: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
  },
  {
    id: 'sfmono',
    name: 'SF Mono',
    stack: '"SF Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace',
  },
  {
    id: 'jetbrains',
    name: 'JetBrains Mono',
    stack: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
  },
  {
    id: 'fira',
    name: 'Fira Code',
    stack: '"Fira Code", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
  },
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
  monoFont: MonoFontId
  uiDensity: UiDensity
  editorSize: EditorSize
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
  monoFont: 'system',
  uiDensity: 'default',
  editorSize: 'default',
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

function loadPreferences(): WorkspacePreferences {
  const isNarrow = typeof window !== 'undefined' && window.innerWidth <= 900
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<WorkspacePreferences>
    return {
      ...defaults,
      ...stored,
      uiFont: oneOf(stored.uiFont, ['system', 'inter', 'plex', 'serif'] as const, defaults.uiFont),
      monoFont: oneOf(stored.monoFont, ['system', 'sfmono', 'jetbrains', 'fira'] as const, defaults.monoFont),
      uiDensity: oneOf(stored.uiDensity, ['compact', 'default', 'comfortable'] as const, defaults.uiDensity),
      editorSize: oneOf(stored.editorSize, ['small', 'default', 'large'] as const, defaults.editorSize),
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
  root.dataset.monoFont = preferences.monoFont
  root.dataset.uiDensity = preferences.uiDensity
  root.dataset.editorSize = preferences.editorSize
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(loadPreferences)

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme
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
