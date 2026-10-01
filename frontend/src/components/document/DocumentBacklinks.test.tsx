// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type Document, type DocumentSummary } from '../../api'
import { DocumentBacklinks } from './DocumentBacklinks'

afterEach(cleanup)

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string
    params?: Record<string, string>
    children: React.ReactNode
    className?: string
  }) => {
    const href = params ? to.replace('$documentId', params.documentId ?? '') : to
    return (
      <a href={href} className={className}>
        {children}
      </a>
    )
  },
}))

const targetDoc: Document = {
  document_id: 'doc-target',
  title: 'Architecture Strategy',
  content_type: 'text/markdown',
  path: 'architecture/strategy.md',
  current_revision_id: 'rev-1',
  content: '# Strategy',
  content_hash: 'hash-1',
  size_bytes: 10,
  materialization_state: 'clean',
  file_hash: null,
  deleted: false,
  created_by: 'user-1',
  created_at: '2026-09-30T00:00:00Z',
  updated_at: '2026-09-30T00:00:00Z',
  updated_by: 'user-1',
  updated_by_name: 'User One',
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

const mockBacklink: DocumentSummary = {
  document_id: 'doc-source-1',
  title: 'Roadmap Q4',
  content_type: 'text/markdown',
  path: 'roadmap/q4.md',
  current_revision_id: 'rev-2',
  content_hash: 'hash-2',
  size_bytes: 40,
  materialization_state: 'clean',
  file_hash: null,
  deleted: false,
  created_by: 'user-2',
  created_at: '2026-09-30T00:00:00Z',
  updated_at: '2026-09-30T00:00:00Z',
  updated_by: 'user-2',
  updated_by_name: 'User Two',
  revision_summary: null,
  category: null,
  metadata_version: 1,
  trust_level: 'untrusted',
  trust_version: 1,
  tags: [],
  search_snippet: '… aligns with the [Architecture Strategy](sangam://document/doc-target) principles …',
  pdf_page_count: null,
  pdf_extraction_status: null,
  pdf_extraction_error: null,
  supersedes_document_id: null,
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('DocumentBacklinks', () => {
  it('renders backlinks list with count, title, path, and snippet', async () => {
    vi.spyOn(api, 'getBacklinks').mockResolvedValue([mockBacklink])

    renderWithClient(<DocumentBacklinks document={targetDoc} />)

    const title = await screen.findByText('Roadmap Q4')
    expect(title).toBeDefined()
    expect(screen.getByText('1')).toBeDefined()
    expect(screen.getByText('roadmap/q4.md')).toBeDefined()
    expect(screen.getByText(/aligns with the \[Architecture Strategy\]/i)).toBeDefined()

    const link = screen.getByRole('link', { name: /Roadmap Q4/i })
    expect(link.getAttribute('href')).toBe('/documents/doc-source-1')
  })

  it('renders helpful empty state when no backlinks exist', async () => {
    vi.spyOn(api, 'getBacklinks').mockResolvedValue([])

    renderWithClient(<DocumentBacklinks document={targetDoc} />)

    expect(await screen.findByText('No other documents link here yet.')).toBeDefined()
    expect(screen.getByText('0')).toBeDefined()
  })
})
