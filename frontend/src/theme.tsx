import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type ThemeId = 'river' | 'midnight' | 'parchment' | 'cobalt'

export type InspectorTab = 'properties' | 'outline' | 'history' | 'chat'

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
  leftWidth: number
  rightWidth: number
  leftVisible: boolean
  rightVisible: boolean
  rightTab: InspectorTab
}

type ThemeContextValue = {
  preferences: WorkspacePreferences
  updatePreferences: (patch: Partial<WorkspacePreferences>) => void
}

const defaults: WorkspacePreferences = {
  theme: 'midnight',
  leftWidth: 282,
  rightWidth: 320,
  leftVisible: true,
  rightVisible: true,
  rightTab: 'properties',
}

const ThemeContext = createContext<ThemeContextValue | null>(null)
const storageKey = 'sangam.workspace-preferences.v1'

function loadPreferences(): WorkspacePreferences {
  const isNarrow = typeof window !== 'undefined' && window.innerWidth <= 900
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<WorkspacePreferences>
    return { ...defaults, ...stored, rightVisible: isNarrow ? false : (stored.rightVisible ?? true) }
  } catch {
    return { ...defaults, rightVisible: isNarrow ? false : true }
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(loadPreferences)

  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme
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
