// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@openai/chatkit-react', () => ({
  ChatKit: () => null,
  useChatKit: () => ({ control: {} }),
}))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {} }))
vi.mock('../theme', () => ({ useTheme: () => ({ preferences: { theme: 'river' } }) }))
vi.mock('./RevisionMergeView', () => ({ RevisionMergeView: () => null }))

import { ChatContextBanner, hasMountedChatInterface, SelectionChip } from './ChatPanel'
import type { Document } from '../api'

afterEach(cleanup)

describe('ChatContextBanner', () => {
  const mockDocument: Document = {
    document_id: 'doc-12345678-abcd',
    title: 'Research Brief',
    path: 'research/brief.md',
    content: '# Content',
    content_type: 'text/markdown',
    current_revision_id: '8f2ac41d99999999',
    content_hash: 'hash123',
    size_bytes: 100,
    materialization_state: 'clean',
    file_hash: null,
    deleted: false,
    created_by: 'jay',
    created_at: '2026-08-16T12:00:00Z',
    updated_at: '2026-08-16T12:00:00Z',
    updated_by: 'jay',
    updated_by_name: 'Jay',
    revision_summary: null,
    category: null,
    metadata_version: 1,
    trust_level: 'untrusted',
    trust_version: 1,
    tags: [],
    pdf_page_count: null,
    pdf_extraction_status: null,
    pdf_extraction_error: null,
    supersedes_document_id: null,
  }

  it('renders document title and revision hash snippet', () => {
    render(<ChatContextBanner document={mockDocument} selectedText="" />)
    expect(screen.getByText('Research Brief')).toBeTruthy()
    expect(screen.getByText(/rev 8f2ac41d…9999/)).toBeTruthy()
  })

  it('displays selected character count when text is selected', () => {
    render(<ChatContextBanner document={mockDocument} selectedText="Selected text snippet" />)
    expect(screen.getByText(/21 chars selected/)).toBeTruthy()
  })
})

describe('hasMountedChatInterface', () => {
  it('does not accept an empty ChatKit shadow root as usable', () => {
    const host = document.createElement('openai-chatkit')
    const root = host.attachShadow({ mode: 'open' })
    root.innerHTML = '<style>:host { display: block; }</style>'
    expect(hasMountedChatInterface(host)).toBe(false)
  })

  it.each(['<iframe></iframe>', '<div class="ck-wrapper"></div>', '<textarea></textarea>'])(
    'accepts mounted ChatKit UI: %s',
    (markup) => {
      const host = document.createElement('openai-chatkit')
      host.attachShadow({ mode: 'open' }).innerHTML = markup
      expect(hasMountedChatInterface(host)).toBe(true)
    },
  )
})

describe('SelectionChip', () => {
  it('renders nothing when there is no selection', () => {
    const { container } = render(<SelectionChip selectedText="" />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the exact character count and the sent text for a small selection', () => {
    render(<SelectionChip selectedText={'# Beta\nhello'} />)
    expect(screen.getByText('Using selection: 12 chars')).toBeTruthy()
    expect(document.querySelector('.chat-selection-chip-preview')?.textContent).toBe('# Beta\nhello')
    expect(screen.queryByText(/truncated/)).toBeNull()
  })

  it('announces truncation and only previews the first 20,000 characters', () => {
    const long = 'x'.repeat(25_000)
    render(<SelectionChip selectedText={long} />)
    expect(screen.getByText('Using selection: 20,000 of 25,000 chars (truncated)')).toBeTruthy()
    const preview = document.querySelector('.chat-selection-chip-preview')
    expect(preview?.textContent?.length).toBe(20_000)
    expect(screen.getByText(/Only the first 20,000 characters are sent/)).toBeTruthy()
  })
})
