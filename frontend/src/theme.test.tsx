// @vitest-environment jsdom

import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ThemeProvider, useTheme } from './theme'

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
