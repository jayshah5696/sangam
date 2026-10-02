import { describe, expect, it } from 'vitest'
import { captureKindForFile, inboxPath, linkNoteContent, parseCaptureText, textNoteTitle } from './capture'

describe('captureKindForFile', () => {
  it('recognizes each supported file by type or extension', () => {
    expect(captureKindForFile({ name: 'paper.PDF', type: '' })).toBe('pdf')
    expect(captureKindForFile({ name: 'shot.png', type: 'image/png' })).toBe('image')
    expect(captureKindForFile({ name: 'notes.md', type: '' })).toBe('markdown')
    expect(captureKindForFile({ name: 'notes.txt', type: 'text/plain' })).toBe('markdown')
    expect(captureKindForFile({ name: 'page.html', type: 'text/html' })).toBe('html')
  })

  it('rejects files Sangam cannot keep', () => {
    expect(captureKindForFile({ name: 'logo.svg', type: 'image/svg+xml' })).toBeNull()
    expect(captureKindForFile({ name: 'archive.zip', type: 'application/zip' })).toBeNull()
  })
})

describe('parseCaptureText', () => {
  it('treats a lone URL as a link', () => {
    expect(parseCaptureText('  https://example.com/a?b=1 \n')).toEqual({
      kind: 'link',
      url: 'https://example.com/a?b=1',
    })
  })

  it('treats anything else as text, including URLs inside prose', () => {
    expect(parseCaptureText('read https://example.com later')).toEqual({
      kind: 'text',
      text: 'read https://example.com later',
    })
    expect(parseCaptureText('   ')).toBeNull()
  })

  it('does not accept non-web schemes as links', () => {
    expect(parseCaptureText('javascript:alert(1)')).toEqual({ kind: 'text', text: 'javascript:alert(1)' })
  })
})

describe('inboxPath', () => {
  it('builds a dated, slugged, collision-resistant path in the Inbox folder', () => {
    expect(inboxPath('Benchmark: Results (v2)!', 'pdf', new Date('2026-10-01T12:00:00Z'), 'k3x9')).toBe(
      'inbox/2026-10-01-benchmark-results-v2-k3x9.pdf',
    )
  })

  it('falls back to a generic name', () => {
    expect(inboxPath('***', 'md', new Date('2026-10-01T12:00:00Z'), 'a1b2')).toBe(
      'inbox/2026-10-01-capture-a1b2.md',
    )
  })
})

describe('notes', () => {
  it('titles a text capture from its first line', () => {
    expect(textNoteTitle('# Meeting notes\nbody')).toBe('Meeting notes')
    expect(textNoteTitle('\n\n')).toBe('Captured note')
    expect(textNoteTitle('x'.repeat(200))).toHaveLength(80)
  })

  it('records where a link came from and when', () => {
    expect(linkNoteContent('https://example.com/post', new Date('2026-10-01T12:00:00Z'))).toBe(
      '# example.com/post\n\n> Source: <https://example.com/post>\n> Captured: 2026-10-01\n\n',
    )
  })
})
