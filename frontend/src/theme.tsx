import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type ThemeId = 'river' | 'midnight' | 'parchment' | 'cobalt'

export const themes: Array<{ id: ThemeId; name: string; description: string; colors: string[] }> = [
  { id: 'river', name: 'River', description: 'Calm green and warm paper', colors: ['#202b26', '#f3f0e7', '#d8f0df'] },
  { id: 'midnight', name: 'Midnight', description: 'Deep navy for focused work', colors: ['#111827', '#182235', '#76a7ff'] },
  { id: 'parchment', name: 'Parchment', description: 'Editorial sepia and ink', colors: ['#4a3728', '#f1e5cc', '#b85c38'] },
  { id: 'cobalt', name: 'Cobalt', description: 'Crisp blue and cool white', colors: ['#102a43', '#edf4fb', '#2f80ed'] },
]

type WorkspacePreferences = {
  theme: ThemeId
  leftWidth: number
  rightWidth: number
  leftVisible: boolean
  rightVisible: boolean
}

type ThemeContextValue = {
  preferences: WorkspacePreferences
  updatePreferences: (patch: Partial<WorkspacePreferences>) => void
}

const defaults: WorkspacePreferences = {
  theme: 'river',
  leftWidth: 282,
  rightWidth: 320,
  leftVisible: true,
  rightVisible: true,
}

const ThemeContext = createContext<ThemeContextValue | null>(null)
const storageKey = 'sangam.workspace-preferences.v1'

function loadPreferences(): WorkspacePreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<WorkspacePreferences>
    return { ...defaults, ...stored }
  } catch {
    return defaults
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

  return (
    <ThemeContext.Provider value={{ preferences, updatePreferences }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside ThemeProvider')
  return context
}
