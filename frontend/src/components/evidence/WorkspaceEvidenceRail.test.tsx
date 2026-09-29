// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '../../api'
import { evidenceCitationForType, type EvidenceReference } from '../../evidenceCitation'
import { workspaceEvidenceStore } from '../../workspaceEvidenceState'
import { WorkspaceEvidenceRail } from './WorkspaceEvidenceRail'

const state = vi.hoisted(() => {
  // SAFETY: test insertion tracking array
  const inserted = [] as Array<{ documentId: string; text: string }>
  return {
    navigate: vi.fn(),
    inserted,
  }
})

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => state.navigate,
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown[] }) => {
    if (options.queryKey[0] === 'documents') {
      return {
        data: [
          {
            document_id: 'draft-1',
            title: 'Active Draft',
            content_type: 'text/markdown',
            path: 'draft.md',
          },
        ],
        isLoading: false,
      }
    }
    if (options.queryKey[0] === 'document') {
      const docId = options.queryKey[1]
      if (docId === 'doc-src-changed') {
        return {
          data: {
            document_id: 'doc-src-changed',
            title: 'Updated Source',
            current_revision_id: 'rev-head-new',
            content_type: 'text/markdown',
            content: 'Updated source content',
          },
        }
      }
      return {
        data: {
          document_id: docId,
          title: 'Source Document',
          current_revision_id: 'rev-original',
          content_type: 'text/markdown',
          content: 'Original content',
        },
      }
    }
    if (options.queryKey[0] === 'history') {
      return {
        data: [
          { revision_id: 'rev-pinned', content: 'Pinned revision content' },
          { revision_id: 'rev-head-new', content: 'Updated source content' },
        ],
      }
    }
    return { data: null, isLoading: false }
  },
}))

vi.mock('../../documentSessions', () => ({
  useDocumentSessions: () => ({
    getSession: () => ({ baseRevisionId: 'rev-draft-1', content: activeDraftDoc.content }),
    insertEvidence: async (documentId: string, reference: EvidenceReference) => {
      const text = evidenceCitationForType(reference, activeDraftDoc.content_type)
      state.inserted.push({ documentId, text })
      return true
    },
  }),
}))

vi.mock('../../theme', () => ({
  useTheme: () => ({
    preferences: { rightTab: 'research', rightVisible: true },
    updatePreferences: vi.fn(),
  }),
}))

const activeDraftDoc: Document = {
  document_id: 'draft-1',
  title: 'Active Draft',
  content_type: 'text/markdown',
  path: 'draft.md',
  current_revision_id: 'rev-draft-1',
  content: '# My Draft\n\nWorking notes.',
  content_hash: 'hash-1',
  size_bytes: 30,
  materialization_state: 'clean',
  file_hash: null,
  deleted: false,
  created_by: 'user-1',
  created_at: '2026-03-30T00:00:00Z',
  updated_at: '2026-03-30T00:00:00Z',
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

class MemoryStorage {
  data = new Map<string, string>()
  getItem(key: string) {
    return this.data.get(key) ?? null
  }
  setItem(key: string, value: string) {
    this.data.set(key, String(value))
  }
  removeItem(key: string) {
    this.data.delete(key)
  }
  clear() {
    this.data.clear()
  }
}

beforeEach(async () => {
  Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: { request: async (_name: string, callback: () => void) => callback() },
  })
  window.matchMedia = () => ({
    matches: false,
    media: '',
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  })
  await workspaceEvidenceStore.clearEvidence()
  state.inserted = []
  state.navigate.mockReset()
})

afterEach(cleanup)

describe('WorkspaceEvidenceRail', () => {
  it('displays empty message when no evidence is kept in workspace', () => {
    render(<WorkspaceEvidenceRail document={activeDraftDoc} />)
    expect(screen.getByText(/No evidence kept yet/i)).toBeTruthy()
  })

  it('renders kept evidence and inserts it into the draft at cursor', async () => {
    await workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'source-doc-1',
      sourceTitle: 'Consensus Algorithms',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-pinned-1',
      selectedText: 'Raft divides time into terms of arbitrary length.',
    })

    render(<WorkspaceEvidenceRail document={activeDraftDoc} />)

    expect(screen.getByText('Consensus Algorithms')).toBeTruthy()
    expect(screen.getByText('Raft divides time into terms of arbitrary length.')).toBeTruthy()

    const insertBtn = screen.getByRole('button', { name: /Insert at cursor/i })
    fireEvent.click(insertBtn)

    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0]?.documentId).toBe('draft-1')
    expect(state.inserted[0]?.text).toContain('> Raft divides time into terms of arbitrary length.')
    expect(state.inserted[0]?.text).toContain(
      '[Source: Consensus Algorithms](sangam://document/source-doc-1?revision=rev-pinned-1)',
    )
  })

  it('attaches and saves a claim statement to the evidence card', async () => {
    await workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'source-doc-2',
      sourceTitle: 'Scaling Laws',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-scaling',
      selectedText: 'Loss scales as a power law with compute budget.',
    })

    render(<WorkspaceEvidenceRail document={activeDraftDoc} />)

    const attachClaimBtn = screen.getByRole('button', { name: /\+ Attach to a claim/i })
    fireEvent.click(attachClaimBtn)

    const claimInput = screen.getByRole('textbox', { name: 'Claim statement' })
    fireEvent.change(claimInput, {
      target: { value: 'Compute budget is the primary driver of performance' },
    })

    const saveBtn = screen.getByRole('button', { name: 'Save' })
    fireEvent.click(saveBtn)

    await waitFor(() =>
      expect(screen.getByText('Compute budget is the primary driver of performance')).toBeTruthy(),
    )
  })

  it('detects when source has changed and provides a version comparison dialog', async () => {
    await workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'doc-src-changed',
      sourceTitle: 'Protocol V2',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-pinned',
      selectedText: 'All handshake packets must include HMAC signatures.',
    })

    render(<WorkspaceEvidenceRail document={activeDraftDoc} />)

    expect(screen.getByText('Source changed')).toBeTruthy()
    const compareBtn = screen.getByRole('button', { name: 'Compare source versions' })
    fireEvent.click(compareBtn)

    expect(screen.getByRole('dialog', { name: 'Compare source versions' })).toBeTruthy()
    expect(screen.getByText(/Pinned revision \(rev-pinn\)/i)).toBeTruthy()
  })

  it('compares two kept evidence excerpts side by side', async () => {
    await workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'source-a',
      sourceTitle: 'Paper A',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-original',
      selectedText: 'Passage from paper A.',
    })
    await workspaceEvidenceStore.keepEvidence({
      sourceDocumentId: 'source-b',
      sourceTitle: 'Paper B',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-original',
      selectedText: 'Passage from paper B.',
    })

    render(<WorkspaceEvidenceRail document={activeDraftDoc} />)

    const compareButtons = screen.getAllByRole('button', { name: 'Compare' })
    fireEvent.click(compareButtons[0]!)

    expect(screen.getByText(/Select another excerpt below to compare side by side/i)).toBeTruthy()

    // Click compare on second card
    const remainingCompareButtons = screen.getAllByRole('button', { name: 'Compare' })
    fireEvent.click(remainingCompareButtons[1]!)

    const dialog = screen.getByRole('dialog', { name: 'Compare evidence excerpts' })
    expect(dialog).toBeTruthy()
    expect(within(dialog).getByText('Passage from paper A.')).toBeTruthy()
    expect(within(dialog).getByText('Passage from paper B.')).toBeTruthy()
  })
})
