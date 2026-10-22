import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { z } from 'zod'
import type { EditorMode } from './documentSessions'

export const themeIds = [
  'midnight',
  'river',
  'parchment',
  'cobalt',
  'indigo-dark',
  'indigo-light',
  'moss-dark',
  'moss-light',
  'ember-dark',
  'ember-light',
  'lagoon-dark',
  'lagoon-light',
  'plum-dark',
  'plum-light',
  'brass-dark',
  'brass-light',
] as const

export type ThemeId = (typeof themeIds)[number]
export type ThemeMode = 'dark' | 'light'

export type UiFontId = 'system' | 'inter' | 'geist' | 'plex' | 'serif'
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
    id: 'geist',
    name: 'Geist',
    stack:
      'Geist, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
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

export type InspectorTab = 'properties' | 'research' | 'outline' | 'history' | 'chat' | 'comments'

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

export const baseThemeColors = {
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
  'indigo-dark': {
    appBg: '#0b0c12',
    surface: '#151722',
    surfaceSoft: '#1e2130',
    text: '#f4f5fb',
    muted: '#8d93ad',
    line: 'rgba(255, 255, 255, 0.09)',
    sidebar: '#10111a',
    sidebarText: '#f4f5fb',
    accent: '#9a99ff',
  },
  'indigo-light': {
    appBg: '#f5f5f9',
    surface: '#ffffff',
    surfaceSoft: '#e9e9f2',
    text: '#16172a',
    muted: '#5d6082',
    line: '#d1d1d8',
    sidebar: '#1c1d2e',
    sidebarText: '#f6f6f7',
    accent: '#4b49d4',
  },
  'moss-dark': {
    appBg: '#0a0d0b',
    surface: '#141a16',
    surfaceSoft: '#1d2620',
    text: '#f2f7f3',
    muted: '#85998b',
    line: 'rgba(255, 255, 255, 0.09)',
    sidebar: '#0e1210',
    sidebarText: '#f2f7f3',
    accent: '#6fd0a6',
  },
  'moss-light': {
    appBg: '#f2f4ee',
    surface: '#fcfdf9',
    surfaceSoft: '#e4e8dd',
    text: '#1a211c',
    muted: '#5a685f',
    line: '#cfd2cc',
    sidebar: '#1d2a23',
    sidebarText: '#f6f6f6',
    accent: '#2b7458',
  },
  'ember-dark': {
    appBg: '#0d0a09',
    surface: '#1a1412',
    surfaceSoft: '#261d19',
    text: '#f9f3ef',
    muted: '#9c8a80',
    line: 'rgba(255, 255, 255, 0.09)',
    sidebar: '#120e0c',
    sidebarText: '#f9f3ef',
    accent: '#f0997a',
  },
  'ember-light': {
    appBg: '#f7f1ea',
    surface: '#fffcf8',
    surfaceSoft: '#ede2d5',
    text: '#2a1f18',
    muted: '#725d4c',
    line: '#d6cfc8',
    sidebar: '#2e211a',
    sidebarText: '#f7f6f6',
    accent: '#b4491f',
  },
  'lagoon-dark': {
    appBg: '#080c0d',
    surface: '#121a1c',
    surfaceSoft: '#1a2629',
    text: '#f0f8f9',
    muted: '#82a0a4',
    line: 'rgba(255, 255, 255, 0.09)',
    sidebar: '#0c1214',
    sidebarText: '#f0f8f9',
    accent: '#58cfdb',
  },
  'lagoon-light': {
    appBg: '#eff5f5',
    surface: '#fbfefe',
    surfaceSoft: '#dde9ea',
    text: '#142022',
    muted: '#50676b',
    line: '#ccd3d3',
    sidebar: '#14282b',
    sidebarText: '#f6f6f7',
    accent: '#0f7480',
  },
  'plum-dark': {
    appBg: '#0c090c',
    surface: '#191319',
    surfaceSoft: '#251c25',
    text: '#faf3fa',
    muted: '#9d86a0',
    line: 'rgba(255, 255, 255, 0.09)',
    sidebar: '#110c11',
    sidebarText: '#faf3fa',
    accent: '#e090d8',
  },
  'plum-light': {
    appBg: '#f7f2f7',
    surface: '#fffcff',
    surfaceSoft: '#ece2ec',
    text: '#251925',
    muted: '#715a73',
    line: '#d5cfd5',
    sidebar: '#2a1a2b',
    sidebarText: '#f6f6f7',
    accent: '#94308c',
  },
  'brass-dark': {
    appBg: '#0c0b08',
    surface: '#191710',
    surfaceSoft: '#252218',
    text: '#f9f6ec',
    muted: '#9b9374',
    line: 'rgba(255, 255, 255, 0.09)',
    sidebar: '#110f0a',
    sidebarText: '#f9f6ec',
    accent: '#e8c15a',
  },
  'brass-light': {
    appBg: '#f6f2e6',
    surface: '#fffdf5',
    surfaceSoft: '#ebe4cf',
    text: '#28220f',
    muted: '#6a613c',
    line: '#d5d1c4',
    sidebar: '#2b2412',
    sidebarText: '#f7f6f6',
    accent: '#8a6200',
  },
} satisfies Record<ThemeId, Record<ThemeColorKey, string>>

export type CustomTheme = {
  id: string
  name: string
  base: ThemeId
  colors: Partial<Record<ThemeColorKey, string>>
}

export interface ResolvedThemeColors {
  appBg: string
  surface: string
  surfaceSoft: string
  text: string
  muted: string
  line: string
  sidebar: string
  sidebarText: string
  accent: string
}

export const customThemeIdPrefix = 'custom:'

export function customThemeRef(id: string): `${typeof customThemeIdPrefix}${string}` {
  return `${customThemeIdPrefix}${id}`
}

export function isValidColorValue(value: string): boolean {
  return (
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ||
    /^rgba?\(([\d.]+\s*,\s*){2}[\d.]+(?:\s*,\s*[\d.]+)?\)$/.test(value)
  )
}

export function isValidAccentHex(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
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

export function resolveCustomThemeColors(custom: CustomTheme): ResolvedThemeColors {
  const base = baseThemeColors[custom.base]
  return { ...base, ...custom.colors }
}

export function themeMode(preferences: ThemePreference): ThemeMode {
  const custom = activeCustomTheme(preferences)
  const id = custom ? custom.base : preferences.theme
  return themes.find((theme) => theme.id === id)?.mode ?? 'light'
}

function parseRgb(value: string): [number, number, number] | null {
  if (value.startsWith('#')) {
    const full = value.length === 4 ? value.replace(/[0-9a-f]/gi, (c) => c + c) : value
    const channels = [1, 3, 5].map((i) => Number.parseInt(full.slice(i, i + 2), 16))
    return channels.every(Number.isFinite) ? [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0] : null
  }
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(value)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [lr = 0, lg = 0, lb = 0] = [r, g, b].map((channel) => {
    const raw = channel / 255
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb
}

/** WCAG 2 contrast ratio, 1 (none) to 21 (black on white). Alpha is ignored. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseRgb(foreground)
  const bg = parseRgb(background)
  if (!fg || !bg) return null
  const [a, b] = [relativeLuminance(fg), relativeLuminance(bg)]
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b]
    .map((v) =>
      Math.round(Math.min(255, Math.max(0, v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`
}

function mixHex(from: string, to: string, amount: number): string {
  const a = parseRgb(from) ?? [0, 0, 0]
  const b = parseRgb(to) ?? [0, 0, 0]
  return toHex([a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount])
}

/** Moves `color` toward `target` until it reaches `minimum` contrast on `background`. */
function reachContrast(color: string, background: string, target: string, minimum: number): string {
  let next = color
  for (let step = 0; step < 25; step += 1) {
    if ((contrastRatio(next, background) ?? 0) >= minimum) return next
    next = mixHex(next, target, 0.06)
  }
  return target
}

export function themeModeOf(background: string): ThemeMode {
  const rgb = parseRgb(background)
  return rgb && relativeLuminance(rgb) < 0.2 ? 'dark' : 'light'
}

/**
 * Builds a full palette from two picks. The background decides dark or light.
 * Text, muted text, and the accent are moved just far enough to stay readable.
 */
export type DerivedTheme = { base: ThemeId; colors: ResolvedThemeColors }

export function deriveThemeColors(background: string, accent: string): DerivedTheme {
  const mode = themeModeOf(background)
  const dark = mode === 'dark'
  const surface = dark ? mixHex(background, '#ffffff', 0.05) : mixHex(background, '#ffffff', 0.65)
  const surfaceSoft = dark ? mixHex(background, '#ffffff', 0.1) : mixHex(background, '#000000', 0.05)
  const text = dark ? mixHex('#f7f8f8', background, 0.04) : mixHex('#15181c', background, 0.06)
  const toward = dark ? '#ffffff' : '#000000'
  const sidebar = dark ? mixHex(background, '#000000', 0.3) : mixHex('#101418', accent, 0.18)
  return {
    base: dark ? 'midnight' : 'river',
    colors: {
      appBg: background,
      surface,
      surfaceSoft,
      text,
      muted: reachContrast(mixHex(text, background, 0.45), surfaceSoft, text, 4.5),
      line: dark ? 'rgba(255, 255, 255, 0.09)' : mixHex(background, '#000000', 0.14),
      sidebar,
      sidebarText: mixHex('#f7f8f8', sidebar, 0.04),
      accent: reachContrast(accent, surface, toward, 4.5),
    },
  }
}

export type ContrastCheck = {
  id: string
  label: string
  foreground: string
  background: string
  minimum: number
  ratio: number | null
}

/** The places where two theme colors meet, each with the contrast it must reach. */
export function themeContrastChecks(colors: ResolvedThemeColors): ContrastCheck[] {
  const rules = [
    {
      id: 'text',
      label: 'Text on background',
      foreground: colors.text,
      background: colors.appBg,
      minimum: 4.5,
    },
    {
      id: 'surface',
      label: 'Text on surface',
      foreground: colors.text,
      background: colors.surface,
      minimum: 4.5,
    },
    {
      id: 'muted',
      label: 'Muted text on raised surface',
      foreground: colors.muted,
      background: colors.surfaceSoft,
      minimum: 4.5,
    },
    {
      id: 'accent',
      label: 'Accent on surface',
      foreground: colors.accent,
      background: colors.surface,
      minimum: 3,
    },
    {
      id: 'sidebar',
      label: 'Sidebar text on sidebar',
      foreground: colors.sidebarText,
      background: colors.sidebar,
      minimum: 4.5,
    },
  ]
  return rules.map((rule) => ({ ...rule, ratio: contrastRatio(rule.foreground, rule.background) }))
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

export const themes: Array<{
  id: ThemeId
  family: string
  name: string
  description: string
  mode: ThemeMode
}> = [
  {
    id: 'midnight',
    family: 'Midnight',
    name: 'Midnight',
    description: 'Dark-native near-black workspace',
    mode: 'dark',
  },
  {
    id: 'river',
    family: 'River',
    name: 'River',
    description: 'Calm green and warm paper',
    mode: 'light',
  },
  {
    id: 'parchment',
    family: 'Parchment',
    name: 'Parchment',
    description: 'Editorial sepia and ink',
    mode: 'light',
  },
  {
    id: 'cobalt',
    family: 'Cobalt',
    name: 'Cobalt',
    description: 'Crisp blue and cool white',
    mode: 'light',
  },
  {
    id: 'indigo-dark',
    family: 'Indigo Ink',
    name: 'Indigo Ink Dark',
    description: 'Brand indigo with corrected link contrast',
    mode: 'dark',
  },
  {
    id: 'indigo-light',
    family: 'Indigo Ink',
    name: 'Indigo Ink Light',
    description: 'Brand indigo with corrected link contrast',
    mode: 'light',
  },
  {
    id: 'moss-dark',
    family: 'Moss',
    name: 'Moss Dark',
    description: 'Calm green on tinted neutrals',
    mode: 'dark',
  },
  {
    id: 'moss-light',
    family: 'Moss',
    name: 'Moss Light',
    description: 'Calm green on tinted neutrals',
    mode: 'light',
  },
  {
    id: 'ember-dark',
    family: 'Ember',
    name: 'Ember Dark',
    description: 'Warm terracotta, low glare',
    mode: 'dark',
  },
  {
    id: 'ember-light',
    family: 'Ember',
    name: 'Ember Light',
    description: 'Warm terracotta, low glare',
    mode: 'light',
  },
  {
    id: 'lagoon-dark',
    family: 'Lagoon',
    name: 'Lagoon Dark',
    description: 'Clear teal with cool neutrals',
    mode: 'dark',
  },
  {
    id: 'lagoon-light',
    family: 'Lagoon',
    name: 'Lagoon Light',
    description: 'Clear teal with cool neutrals',
    mode: 'light',
  },
  {
    id: 'plum-dark',
    family: 'Plum',
    name: 'Plum Dark',
    description: 'Magenta-violet with soft surfaces',
    mode: 'dark',
  },
  {
    id: 'plum-light',
    family: 'Plum',
    name: 'Plum Light',
    description: 'Magenta-violet with soft surfaces',
    mode: 'light',
  },
  {
    id: 'brass-dark',
    family: 'Brass',
    name: 'Brass Dark',
    description: 'Editorial amber and ink',
    mode: 'dark',
  },
  {
    id: 'brass-light',
    family: 'Brass',
    name: 'Brass Light',
    description: 'Editorial amber and ink',
    mode: 'light',
  },
]

export const sidebarFooterToolDefinitions = [
  { id: 'projects', label: 'Projects', detail: 'View and manage active projects' },
  { id: 'chat', label: 'Workspace chat', detail: 'Open AI-assisted document chat and generation' },
  { id: 'review', label: 'Review changes', detail: 'Inspect pending changes, proposals, and activity' },
  { id: 'publications', label: 'Publications', detail: 'View documents published to the web or exported' },
  { id: 'trash', label: 'Trash', detail: 'Browse deleted documents and restore retained files' },
  { id: 'settings', label: 'Settings', detail: 'Quick access to workspace preferences and configuration' },
] as const

export type SidebarFooterToolId = (typeof sidebarFooterToolDefinitions)[number]['id']

export type SidebarFooterToolsVisibility = Record<SidebarFooterToolId, boolean>

export const defaultSidebarFooterTools = {
  projects: true,
  chat: true,
  review: true,
  publications: true,
  trash: true,
  settings: true,
} satisfies SidebarFooterToolsVisibility

export type WorkspacePreferences = {
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
  sidebarFooterTools: SidebarFooterToolsVisibility
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
  rightVisible: false,
  rightTab: 'properties',
  editorMode: 'preview',
  sidebarFooterTools: defaultSidebarFooterTools,
}

const storageKey = 'sangam.workspace-preferences.v1'

const themeIdSchema = z.enum(themeIds)
const uiFontIdSchema = z.enum(['system', 'inter', 'plex', 'serif'])
const uiDensitySchema = z.enum(['compact', 'default', 'comfortable'])
const editorSizeSchema = z.enum(['small', 'default', 'large'])
const editorModeSchema = z.enum(['edit', 'split', 'preview'])
const inspectorTabSchema = z.enum(['properties', 'research', 'outline', 'history', 'chat'])

const rawCustomThemeSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().trim().min(1),
  base: themeIdSchema,
  colors: z.record(z.string(), z.string()).optional().default({}),
})

function parseCustomThemes(value: Array<z.input<typeof rawCustomThemeSchema>> | undefined): CustomTheme[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const parsed: CustomTheme[] = []
  for (const entry of value) {
    const result = rawCustomThemeSchema.safeParse(entry)
    if (!result.success || seen.has(result.data.id)) continue
    const colors: Partial<Record<ThemeColorKey, string>> = {}
    for (const role of themeColorRoles) {
      const color = result.data.colors[role.key]
      if (color && isValidColorValue(color)) {
        colors[role.key] = color
      }
    }
    seen.add(result.data.id)
    parsed.push({
      id: result.data.id,
      name: result.data.name,
      base: result.data.base,
      colors,
    })
  }
  return parsed
}

const rawStoredPreferencesSchema = z.object({
  theme: z.string().optional(),
  uiFont: uiFontIdSchema.optional(),
  uiDensity: uiDensitySchema.optional(),
  editorSize: editorSizeSchema.optional(),
  editorMode: editorModeSchema.optional(),
  leftWidth: z.number().optional(),
  rightWidth: z.number().optional(),
  leftVisible: z.boolean().optional(),
  rightVisible: z.boolean().optional(),
  rightTab: inspectorTabSchema.optional(),
  customThemes: z.array(rawCustomThemeSchema.passthrough()).optional(),
  sidebarFooterTools: z.record(z.string(), z.boolean()).optional(),
})

function loadPreferences(): WorkspacePreferences {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? '{}')
    const parsed = rawStoredPreferencesSchema.safeParse(raw)
    if (!parsed.success) {
      return { ...defaults, rightVisible: false }
    }
    const stored = parsed.data
    const customThemes = parseCustomThemes(stored.customThemes)
    const storedTheme = stored.theme ?? defaults.theme
    const themeIsValidCustom =
      storedTheme.startsWith(customThemeIdPrefix) &&
      customThemes.some((entry) => customThemeRef(entry.id) === storedTheme)
    const parsedTheme = themeIdSchema.safeParse(stored.theme)
    // SAFETY: themeIsValidCustom guarantees storedTheme starts with customThemeIdPrefix
    const customRef = storedTheme as `custom:${string}`
    const theme = themeIsValidCustom ? customRef : parsedTheme.success ? parsedTheme.data : defaults.theme

    const storedSidebarTools = stored.sidebarFooterTools ?? {}
    const sidebarFooterTools = {
      projects: storedSidebarTools.projects ?? defaultSidebarFooterTools.projects,
      chat: storedSidebarTools.chat ?? defaultSidebarFooterTools.chat,
      review: storedSidebarTools.review ?? defaultSidebarFooterTools.review,
      publications: storedSidebarTools.publications ?? defaultSidebarFooterTools.publications,
      trash: storedSidebarTools.trash ?? defaultSidebarFooterTools.trash,
      settings: storedSidebarTools.settings ?? defaultSidebarFooterTools.settings,
    } satisfies SidebarFooterToolsVisibility

    return {
      ...defaults,
      ...stored,
      theme,
      uiFont: stored.uiFont ?? defaults.uiFont,
      uiDensity: stored.uiDensity ?? defaults.uiDensity,
      editorSize: stored.editorSize ?? defaults.editorSize,
      editorMode: stored.editorMode ?? defaults.editorMode,
      customThemes,
      sidebarFooterTools,
      rightVisible: stored.rightVisible ?? false,
    }
  } catch {
    return { ...defaults, rightVisible: false }
  }
}

type ThemePreference = Pick<WorkspacePreferences, 'theme' | 'customThemes'>

export function activeCustomTheme(preferences: ThemePreference): CustomTheme | null {
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
    setPreferences((current) => ({
      ...current,
      ...patch,
      sidebarFooterTools: patch.sidebarFooterTools
        ? { ...current.sidebarFooterTools, ...patch.sidebarFooterTools }
        : current.sidebarFooterTools,
    }))
  }

  return <ThemeContext.Provider value={{ preferences, updatePreferences }}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside ThemeProvider')
  return context
}
