// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, type Document } from '../../api'
import { DocumentLocationControl } from './DocumentLocationControl'

afterEach(cleanup)

const draftDoc: Document = {
  document_id: 'doc-draft-1',
  title: 'My Project Plan',
  content_type: 'text/markdown',
  path: null,
  current_revision_id: 'rev-1',
  content: '# Plan',
  content_hash: 'hash-1',
  size_bytes: 6,
  materialization_state: 'none',
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

const fileDoc: Document = {
  ...draftDoc,
  document_id: 'doc-file-1',
  path: 'projects/spec.md',
  materialization_state: 'clean',
}

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('DocumentLocationControl', () => {
  it('renders a draft location pill and toggles the popover', async () => {
    vi.spyOn(api, 'listFolders').mockResolvedValue([
      {
        folder_id: 'f-1',
        path: 'projects',
        name: 'projects',
        category: null,
        metadata_version: 1,
        tags: [],
        document_count: 1,
        created_at: '2026-09-30T00:00:00Z',
        updated_at: '2026-09-30T00:00:00Z',
      },
    ])

    renderWithClient(<DocumentLocationControl document={draftDoc} saveState="saved" />)

    const trigger = screen.getByRole('button', { name: /Document location: Saved draft/i })
    expect(trigger).toBeDefined()
    expect(trigger.textContent).toContain('Saved draft')

    // Click trigger to open popover
    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: 'Draft location' })
    expect(dialog).toBeDefined()
    expect(screen.getByLabelText('Workspace folder')).toBeDefined()
    expect(screen.getByLabelText('Workspace filename')).toBeDefined()

    // Press Escape to close
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('renders a workspace file location pill with the path and allows moving', async () => {
    vi.spyOn(api, 'listFolders').mockResolvedValue([])
    const moveSpy = vi.spyOn(api, 'moveDocument').mockResolvedValue({
      ...fileDoc,
      path: 'archive/spec.md',
    })
    const onUpdated = vi.fn()

    renderWithClient(<DocumentLocationControl document={fileDoc} saveState="saved" onUpdated={onUpdated} />)

    const trigger = screen.getByRole('button', { name: /Document location: projects\/spec\.md/i })
    expect(trigger).toBeDefined()

    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Workspace location' })).toBeDefined()

    const submit = screen.getByRole('button', { name: /Move file/i })
    fireEvent.click(submit)

    await waitFor(() => {
      expect(moveSpy).toHaveBeenCalledWith(fileDoc, 'projects/spec.md')
      expect(onUpdated).toHaveBeenCalled()
    })
  })
})
