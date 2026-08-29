// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '../../api'
import { DocumentInspector } from './DocumentInspector'

const state = vi.hoisted(() => {
  // SAFETY: test query tracking state
  const queries = [] as Array<{ queryKey: unknown[]; enabled?: boolean }>
  return {
    queries,
    rightTab: 'properties',
    navigate: vi.fn(),
  }
})

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

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => state.navigate }))
vi.mock('../../useMediaQuery', () => ({ useMediaQuery: () => false }))
vi.mock('../ChatPanel', () => ({
  ChatPanel: ({ compact }: { compact?: boolean }) => (
    <div data-testid="document-chat" data-compact={String(compact)} />
  ),
}))

vi.mock('../../theme', () => ({
  useTheme: () => ({
    preferences: { rightTab: state.rightTab },
    updatePreferences: vi.fn(),
  }),
}))

vi.mock('../RevisionMergeView', () => ({ RevisionMergeView: () => null }))
vi.mock('../HtmlPreview', () => ({ HtmlPreview: () => null }))
vi.mock('../MarkdownPreview', () => ({ MarkdownPreview: () => null }))
vi.mock('../OneTimeSecret', () => ({ OneTimeSecret: () => null }))

const testDocument: Document = {
  document_id: 'document-1',
  title: 'Document',
  content_type: 'text/markdown',
  path: 'document.md',
  current_revision_id: 'revision-1',
  content: '# Heading',
  content_hash: 'hash',
  size_bytes: 9,
  materialization_state: 'clean',
  file_hash: null,
  deleted: false,
  created_by: 'user-1',
  created_at: '2026-08-20T12:00:00Z',
  updated_at: '2026-08-20T12:00:00Z',
  updated_by: 'user-1',
  updated_by_name: 'User One',
  revision_summary: null,
  tags: [],
  category: null,
  metadata_version: 1,
  trust_level: 'untrusted',
  trust_version: 1,
  pdf_page_count: null,
  pdf_extraction_status: null,
  pdf_extraction_error: null,
  supersedes_document_id: null,
}

beforeEach(() => {
  state.queries = []
  state.rightTab = 'properties'
  state.navigate.mockReset()
})

afterEach(cleanup)

describe('DocumentInspector', () => {
  it('loads only data needed by the active tab and exposes a complete tab relationship', () => {
    render(
      <DocumentInspector
        width={320}
        document={testDocument}
        content={testDocument.content}
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

  it('mounts compact document chat and can expand it to the full route', async () => {
    state.rightTab = 'chat'
    render(
      <DocumentInspector
        width={320}
        document={testDocument}
        content={testDocument.content}
        selectedText="Selected passage"
        onCollapse={vi.fn()}
        onUpdated={vi.fn()}
        onFocusEditor={vi.fn()}
      />,
    )

    expect((await screen.findByTestId('document-chat')).getAttribute('data-compact')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'Open full chat' }))
    expect(state.navigate).toHaveBeenCalledWith({
      to: '/chat',
      search: {
        document: 'document-1',
        revision: 'revision-1',
        returnTo: '/documents/document-1',
      },
      state: { sangamChatContext: { selectedText: 'Selected passage' } },
    })
    expect(screen.getByText('Document chat')).toBeTruthy()
  })

  it('uses modal semantics and Escape dismissal when rendered as a narrow sheet', () => {
    const onCollapse = vi.fn()
    render(
      <DocumentInspector
        width={320}
        document={testDocument}
        content={testDocument.content}
        selectedText=""
        onCollapse={onCollapse}
        onUpdated={vi.fn()}
        onFocusEditor={vi.fn()}
        modal
      />,
    )

    const sheet = screen.getByRole('dialog', { name: 'Document inspector' })
    expect(sheet.getAttribute('aria-modal')).toBe('true')
    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(onCollapse).toHaveBeenCalledTimes(1)
  })
})
