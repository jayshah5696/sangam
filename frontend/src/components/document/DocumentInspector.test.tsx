// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '../../api'
import { DocumentInspector } from './DocumentInspector'

const state = vi.hoisted(() => ({
  queries: [] as Array<{ queryKey: unknown[]; enabled?: boolean }>,
}))

vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    state.queries.push(options)
    return { data: options.queryKey[0] === 'tags' ? [] : null, isLoading: false }
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

vi.mock('../../documentSessions', () => ({
  useDocumentSession: () => ({ saveState: 'saved' }),
  useDocumentSessions: () => ({ updateSession: vi.fn() }),
}))

vi.mock('../../theme', () => ({
  useTheme: () => ({
    preferences: { rightTab: 'properties' },
    updatePreferences: vi.fn(),
  }),
}))

vi.mock('../RevisionMergeView', () => ({ RevisionMergeView: () => null }))
vi.mock('../HtmlPreview', () => ({ HtmlPreview: () => null }))
vi.mock('../MarkdownPreview', () => ({ MarkdownPreview: () => null }))
vi.mock('../OneTimeSecret', () => ({ OneTimeSecret: () => null }))
vi.mock('../TrustedHtmlPreview', () => ({ TrustedHtmlPreview: () => null }))

const document = {
  document_id: 'document-1',
  title: 'Document',
  content_type: 'text/markdown',
  path: 'document.md',
  current_revision_id: 'revision-1',
  content: '# Heading',
  content_hash: 'hash',
  tags: [],
  category: null,
  metadata_version: 1,
  trust_level: 'untrusted',
} as unknown as Document

beforeEach(() => {
  state.queries = []
})

afterEach(cleanup)

describe('DocumentInspector', () => {
  it('loads only data needed by the active tab and exposes a complete tab relationship', () => {
    render(
      <DocumentInspector
        width={320}
        document={document}
        content={document.content}
        selectedText=""
        onCollapse={vi.fn()}
        onUpdated={vi.fn()}
        onFocusEditor={vi.fn()}
      />,
    )

    expect(state.queries.find(({ queryKey }) => queryKey[0] === 'history')?.enabled).toBe(false)
    expect(state.queries.find(({ queryKey }) => queryKey[0] === 'tags')?.enabled).toBe(true)
    expect(state.queries.find(({ queryKey }) => queryKey[0] === 'publication')?.enabled).toBe(true)

    const properties = screen.getByRole('tab', { name: 'properties' })
    const history = screen.getByRole('tab', { name: 'history' })
    expect(properties.getAttribute('tabindex')).toBe('0')
    expect(history.getAttribute('tabindex')).toBe('-1')
    expect(properties.getAttribute('aria-controls')).toBe('inspector-panel')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('inspector-tab-properties')
  })
})
