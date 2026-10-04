// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type Document, type DocumentSummary, type ProjectDetail } from '../../api'
import { DocumentSourcesAndNotes } from './DocumentSourcesAndNotes'

afterEach(cleanup)

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ project: 'proj_alpha' }),
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: React.ReactNode
    to: string
    params?: { documentId?: string }
    className?: string
  }) => (
    <a href={to.replace('$documentId', params?.documentId ?? '')} className={className}>
      {children}
    </a>
  ),
}))

const sampleDoc: Document = {
  document_id: 'doc_main',
  title: 'Main Synthesis Draft',
  content_type: 'text/markdown',
  path: 'synthesis.md',
  current_revision_id: 'rev_1',
  content: '# Synthesis\n',
  content_hash: 'hash_1',
  size_bytes: 10,
  materialization_state: 'clean',
  file_hash: null,
  deleted: false,
  created_by: 'user_1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  updated_by: 'user_1',
  updated_by_name: 'Author',
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
  document_id: 'doc_linking',
  title: 'Related Research Review',
  content_type: 'text/markdown',
  path: 'review.md',
  current_revision_id: 'rev_2',
  content_hash: 'hash_2',
  size_bytes: 50,
  materialization_state: 'clean',
  file_hash: null,
  deleted: false,
  created_by: 'user_2',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  updated_by: 'user_2',
  updated_by_name: 'Reviewer',
  revision_summary: null,
  category: null,
  metadata_version: 1,
  trust_level: 'untrusted',
  trust_version: 1,
  tags: [],
  search_snippet: '… refers to [Main Synthesis Draft](sangam://document/doc_main) …',
  pdf_page_count: null,
  pdf_extraction_status: null,
  pdf_extraction_error: null,
  supersedes_document_id: null,
}

const mockProject: ProjectDetail = {
  project_id: 'proj_alpha',
  name: 'Alpha Initiative',
  description: 'Primary project',
  brief_document_id: null,
  brief_document_title: null,
  active_thread_id: null,
  active_document_id: 'doc_main',
  version: 1,
  document_count: 3,
  thread_count: 0,
  annotation_count: 0,
  created_by: 'user_1',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  workbench_state_json: null,
  threads: [],
  annotations: [],
  documents: [
    {
      project_id: 'proj_alpha',
      document_id: 'doc_main',
      document_title: 'Main Synthesis Draft',
      document_path: 'synthesis.md',
      content_type: 'text/markdown',
      role: 'draft',
      current_revision_id: 'rev_1',
      source_updated: false,
      excerpt: '',
      updated_at: '2026-10-01T00:00:00Z',
      created_at: '2026-10-01T00:00:00Z',
    },
    {
      project_id: 'proj_alpha',
      document_id: 'doc_source_1',
      document_title: 'Primary Data Source',
      document_path: 'sources/data.pdf',
      content_type: 'application/pdf',
      role: 'source',
      current_revision_id: 'rev_s1',
      source_updated: false,
      notes: 'Contains core empirical measurements.',
      excerpt: 'Observed 15% increase in throughput.',
      updated_at: '2026-10-01T00:00:00Z',
      created_at: '2026-10-01T00:00:00Z',
    },
    {
      project_id: 'proj_alpha',
      document_id: 'doc_note_1',
      document_title: 'Methodology Outline',
      document_path: 'notes/methodology.md',
      content_type: 'text/markdown',
      role: 'note',
      current_revision_id: 'rev_n1',
      source_updated: false,
      notes: 'Initial protocol considerations.',
      excerpt: '',
      updated_at: '2026-10-01T00:00:00Z',
      created_at: '2026-10-01T00:00:00Z',
    },
  ],
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('DocumentSourcesAndNotes', () => {
  it('surfaces project sources, project notes, and related backlinks alongside the draft', async () => {
    vi.spyOn(api, 'getBacklinks').mockResolvedValue([mockBacklink])
    vi.spyOn(api, 'getProject').mockResolvedValue(mockProject)

    renderWithClient(<DocumentSourcesAndNotes document={sampleDoc} />)

    // Project Sources
    expect(await screen.findByText('Project Sources')).toBeDefined()
    expect(screen.getByText('Primary Data Source')).toBeDefined()
    expect(screen.getByText('Contains core empirical measurements.')).toBeDefined()

    // Project Notes
    expect(screen.getByText('Project Notes')).toBeDefined()
    expect(screen.getByText('Methodology Outline')).toBeDefined()
    expect(screen.getByText('Initial protocol considerations.')).toBeDefined()

    // Related Notes / Backlinks
    expect(screen.getByText('Related Notes')).toBeDefined()
    expect(screen.getByText('Related Research Review')).toBeDefined()
    expect(screen.getByText(/refers to \[Main Synthesis Draft\]/i)).toBeDefined()
  })
})
