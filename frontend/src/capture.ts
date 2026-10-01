/**
 * Classify and name incoming material for the single capture flow. Every
 * capture becomes an ordinary workspace file in the Inbox folder, so people can
 * bring material in first and organize it later with the location control.
 */

export const INBOX_FOLDER = 'inbox'

export type CaptureKind = 'pdf' | 'image' | 'markdown' | 'html'

export type CaptureText = { kind: 'link'; url: string } | { kind: 'text'; text: string }

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

export function captureKindForFile(file: { name: string; type: string }): CaptureKind | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (file.type === 'application/pdf' || extension === 'pdf') return 'pdf'
  if (IMAGE_TYPES.has(file.type) || (!file.type && IMAGE_EXTENSIONS.has(extension))) return 'image'
  if (file.type === 'text/html' || extension === 'html' || extension === 'htm') return 'html'
  if (
    ['md', 'markdown', 'txt'].includes(extension) ||
    file.type === 'text/markdown' ||
    file.type === 'text/plain'
  )
    return 'markdown'
  return null
}

export function parseCaptureText(raw: string): CaptureText | null {
  const text = raw.trim()
  if (!text) return null
  return /^https?:\/\/\S+$/i.test(text) && URL.canParse(text)
    ? { kind: 'link', url: text }
    : { kind: 'text', text }
}

function slug(value: string) {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

/** A dated Inbox path; `suffix` keeps two captures with the same title apart. */
export function inboxPath(
  title: string,
  extension: 'md' | 'html' | 'pdf',
  now: Date,
  suffix: string,
): string {
  const date = now.toISOString().slice(0, 10)
  return `${INBOX_FOLDER}/${date}-${slug(title) || 'capture'}-${suffix}.${extension}`
}

export function captureSuffix(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 4)
}

export function textNoteTitle(text: string): string {
  const firstLine =
    text
      .split('\n')
      .map((line) => line.replace(/^#+\s*/, '').trim())
      .find(Boolean) ?? ''
  return firstLine.slice(0, 80) || 'Captured note'
}

export function fileTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '').trim() || name
}

export function linkTitle(url: string): string {
  const parsed = new URL(url)
  return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`.replace(/\/$/, '')
}

/** A note that keeps where the link came from; Sangam does not fetch the page. */
export function linkNoteContent(url: string, now: Date): string {
  return `# ${linkTitle(url)}\n\n> Source: <${url}>\n> Captured: ${now.toISOString().slice(0, 10)}\n\n`
}
