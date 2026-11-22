import { McpUiHostContextSchema, type McpUiHostContext } from '@modelcontextprotocol/ext-apps'

const roles = [
  ['--surface', '--color-background-primary'],
  ['--app-bg', '--color-background-secondary'],
  ['--surface-soft', '--color-background-tertiary'],
  ['--text', '--color-text-primary'],
  ['--muted', '--color-text-secondary'],
  ['--line', '--color-border-primary'],
  ['--accent', '--color-text-info'],
  ['--accent-soft', '--color-background-info'],
  ['--font-ui', '--font-sans'],
  ['--font-mono', '--font-mono'],
] as const

export function hostAppearance() {
  const style = getComputedStyle(document.documentElement)
  return McpUiHostContextSchema.parse({
    theme: style.colorScheme === 'dark' ? 'dark' : 'light',
    displayMode: 'inline',
    styles: {
      variables: Object.fromEntries(
        roles.map(([token, host]) => [host, style.getPropertyValue(token).trim()]),
      ),
    },
  })
}

export function applyHostAppearance(context: McpUiHostContext | undefined) {
  if (!context) return
  const root = document.documentElement
  if (context.theme) root.dataset.theme = context.theme === 'dark' ? 'midnight' : 'river'
  for (const [token, host] of roles) {
    const value = context.styles?.variables?.[host]
    if (value) root.style.setProperty(token, value)
    else root.style.removeProperty(token)
  }
}
