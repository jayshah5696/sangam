// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '../../api'
import { ConflictRecoveryNotice } from './ConflictRecoveryNotice'

vi.mock('../RevisionMergeView', () => ({
  RevisionMergeView: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="comparison">{`${original} -> ${modified}`}</div>
  ),
}))

const document: Document = {
  document_id: 'doc-1',
  title: 'Conflict notes',
  content_type: 'text/markdown',
  path: 'notes.md',
  current_revision_id: 'rev-base',
  content: 'base',
  content_hash: 'hash',
  size_bytes: 4,
  materialization_state: 'clean',
  file_hash: 'hash',
  deleted: false,
  created_by: 'human:jay',
  created_at: '2026-07-22T10:00:00Z',
  updated_at: '2026-07-22T10:00:00Z',
  updated_by: 'human:jay',
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('ConflictRecoveryNotice', () => {
  it('preserves and exports the draft while requiring a second explicit discard action', async () => {
    const onDiscard = vi.fn()
    const onRebase = vi.fn()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const serverHead = {
      ...document,
      current_revision_id: 'rev-server',
      content: 'server version',
      updated_at: '2026-07-22T11:00:00Z',
    }
    render(
      <ConflictRecoveryNotice
        document={document}
        localContent="my local draft"
        baseRevisionId="rev-base"
        serverHead={serverHead}
        loading={false}
        error={false}
        retrying={false}
        onRefresh={vi.fn()}
        onRebaseAndRetry={onRebase}
        onDiscard={onDiscard}
      />,
    )

    expect(screen.getByText('Save conflict · local draft preserved')).toBeTruthy()
    expect(screen.getByTestId('comparison').textContent).toContain('server version -> my local draft')
    fireEvent.click(screen.getByRole('button', { name: 'Copy local draft' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('my local draft'))
    fireEvent.click(screen.getByRole('button', { name: 'Discard local draft…' }))
    expect(onDiscard).not.toHaveBeenCalled()
    expect(screen.getByText('Discard this local draft?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Keep local draft' }))
    expect(onDiscard).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Use local draft as next revision' }))
    expect(onRebase).toHaveBeenCalledOnce()
  })

  it('does not allow rebase or discard until the current server head is loaded', () => {
    render(
      <ConflictRecoveryNotice
        document={document}
        localContent="my local draft"
        baseRevisionId="rev-base"
        loading={false}
        error
        retrying={false}
        onRefresh={vi.fn()}
        onRebaseAndRetry={vi.fn()}
        onDiscard={vi.fn()}
      />,
    )
    expect(
      (screen.getByRole('button', { name: 'Use local draft as next revision' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect((screen.getByRole('button', { name: 'Discard local draft…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(
      (screen.getByRole('button', { name: 'Retry loading server head' }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})
