// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  baseThemeColors,
  contrastRatio,
  themeContrastChecks,
  themeIds,
  themeMode,
  themes,
  ThemeProvider,
  useTheme,
} from './theme'

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
  clear() {
    this.data.clear()
  }
}

beforeEach(() => {
  Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
})

afterEach(() => {
  cleanup()
})

function Probe() {
  const { preferences, updatePreferences } = useTheme()
  return (
    <button type="button" onClick={() => updatePreferences({ uiDensity: 'compact', uiFont: 'serif' })}>
      {preferences.uiFont}:{preferences.uiDensity}:{preferences.editorSize}
    </button>
  )
}

describe('workspace typography preferences', () => {
  it('applies typography defaults to the document element', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(document.documentElement.dataset.uiFont).toBe('system')
    expect(document.documentElement.dataset.uiDensity).toBe('default')
    expect(document.documentElement.dataset.editorSize).toBe('default')
  })

  it('falls back to defaults when stored typography values are invalid', () => {
    window.localStorage.setItem(
      'sangam.workspace-preferences.v1',
      JSON.stringify({
        uiFont: 'comic-sans',
        monoFont: 42,
        uiDensity: 'huge',
        editorSize: 'giant',
        theme: 'custom:ghost',
        customThemes: [{ id: 'ghost', name: 'Ghost', base: 'nope', colors: { accent: 'red' } }],
      }),
    )
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(document.documentElement.dataset.uiFont).toBe('system')
    expect(document.documentElement.dataset.uiDensity).toBe('default')
    expect(document.documentElement.dataset.editorSize).toBe('default')
    expect(document.documentElement.dataset.theme).toBe('midnight')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
  })

  it('applies an active custom theme with color overrides', () => {
    window.localStorage.setItem(
      'sangam.workspace-preferences.v1',
      JSON.stringify({
        theme: 'custom:sunset',
        customThemes: [{ id: 'sunset', name: 'Sunset', base: 'cobalt', colors: { accent: '#ff8800' } }],
      }),
    )
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    expect(document.documentElement.dataset.theme).toBe('cobalt')
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ff8800')
    expect(document.documentElement.style.getPropertyValue('--accent-soft')).toBe('rgba(255, 136, 0, 0.16)')
    expect(document.documentElement.style.getPropertyValue('--accent-text')).toBe('#f7f8f8')
  })

  it('persists updates and re-applies the data attributes', () => {
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    )
    act(() => {
      document.querySelector('button')!.click()
    })
    expect(document.documentElement.dataset.uiFont).toBe('serif')
    expect(document.documentElement.dataset.uiDensity).toBe('compact')
    // SAFETY: JSON.parse of stored preferences payload in localStorage produces key-value map
    const stored = JSON.parse(
      window.localStorage.getItem('sangam.workspace-preferences.v1') ?? '{}',
    ) as Record<string, string>
    expect(stored.uiFont).toBe('serif')
    expect(stored.uiDensity).toBe('compact')
  })
})

describe('sidebar footer navigation preferences', () => {
  function SidebarProbe() {
    const { preferences, updatePreferences } = useTheme()
    return (
      <div>
        <span data-testid="projects">{String(preferences.sidebarFooterTools.projects)}</span>
        <span data-testid="trash">{String(preferences.sidebarFooterTools.trash)}</span>
        <button
          type="button"
          onClick={() =>
            updatePreferences({
              sidebarFooterTools: {
                ...preferences.sidebarFooterTools,
                projects: false,
              },
            })
          }
        >
          Toggle Projects
        </button>
      </div>
    )
  }

  it('initializes with all sidebar footer tools enabled by default', () => {
    const { getByTestId } = render(
      <ThemeProvider>
        <SidebarProbe />
      </ThemeProvider>,
    )
    expect(getByTestId('projects').textContent).toBe('true')
    expect(getByTestId('trash').textContent).toBe('true')
  })

  it('restores custom sidebar footer tool visibility from storage', () => {
    window.localStorage.setItem(
      'sangam.workspace-preferences.v1',
      JSON.stringify({
        sidebarFooterTools: {
          projects: false,
          trash: false,
        },
      }),
    )
    const { getByTestId } = render(
      <ThemeProvider>
        <SidebarProbe />
      </ThemeProvider>,
    )
    expect(getByTestId('projects').textContent).toBe('false')
    expect(getByTestId('trash').textContent).toBe('false')
  })

  it('persists updated sidebar footer tool visibility', () => {
    const { getByRole, getByTestId } = render(
      <ThemeProvider>
        <SidebarProbe />
      </ThemeProvider>,
    )
    act(() => {
      getByRole('button', { name: 'Toggle Projects' }).click()
    })
    expect(getByTestId('projects').textContent).toBe('false')
    const stored = JSON.parse(window.localStorage.getItem('sangam.workspace-preferences.v1') ?? '{}')
    expect(stored.sidebarFooterTools.projects).toBe(false)
    expect(stored.sidebarFooterTools.trash).toBe(true)
  })
})

describe('theme palettes', () => {
  it('keeps text, muted text, and sidebar text readable in every new palette', () => {
    const added = themes.filter((theme) => theme.id.includes('-'))
    expect(added).toHaveLength(12)
    for (const theme of added) {
      for (const check of themeContrastChecks(baseThemeColors[theme.id])) {
        expect(check.ratio, `${theme.id}: ${check.label}`).toBeGreaterThanOrEqual(check.minimum)
      }
    }
  })

  it('defines a picker entry and base colors for every theme id', () => {
    expect(themes.map((theme) => theme.id).sort()).toEqual([...themeIds].sort())
  })

  it('measures WCAG contrast and reports theme brightness', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0)
    expect(themeMode({ theme: 'moss-dark', customThemes: [] })).toBe('dark')
    expect(
      themeMode({ theme: 'custom:x', customThemes: [{ id: 'x', name: 'X', base: 'plum-dark', colors: {} }] }),
    ).toBe('dark')
    expect(themeMode({ theme: 'river', customThemes: [] })).toBe('light')
  })
})
