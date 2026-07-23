// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '../api'
import { CitationNavigationStatus, parsePublishConfirmation, PublishConfirmationCard } from './ChatPanel'

vi.mock('@openai/chatkit-react', () => ({ ChatKit: () => null, useChatKit: () => ({ control: {} }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => Promise.resolve() }))
vi.mock('../theme', () => ({ useTheme: () => ({ preferences: { theme: 'river' } }) }))
vi.mock('./RevisionMergeView', () => ({ RevisionMergeView: () => null }))

afterEach(cleanup)

describe('chat trust controls', () => {
  it('parses only a complete, supported publication request', () => {
    expect(
      parsePublishConfirmation({
        document_id: 'doc-1',
        document_title: 'Release notes',
        slug: 'release-notes',
        access_policy: 'public',
      }),
    ).toEqual({
      documentId: 'doc-1',
      documentTitle: 'Release notes',
      slug: 'release-notes',
      accessPolicy: 'public',
    })
    expect(parsePublishConfirmation({ document_id: 'doc-1', slug: 'x', access_policy: 'world' })).toBeNull()
  })

  it('requires an explicit approval or cancellation for the exact public request', () => {
    const onApprove = vi.fn()
    const onCancel = vi.fn()
    render(
      <PublishConfirmationCard
        request={{
          documentId: 'doc-1',
          documentTitle: 'Release notes',
          slug: 'release-notes',
          accessPolicy: 'public',
        }}
        publishing={false}
        error={false}
        onApprove={onApprove}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByText('No publication is created unless you approve this exact request.')).toBeTruthy()
    expect(onApprove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('shows when the current head differs from a pinned citation', () => {
    const currentDocument = {
      document_id: 'doc-1',
      current_revision_id: 'rev-current',
    } as Document
    render(
      <CitationNavigationStatus
        target={{ documentId: 'doc-1', revisionId: 'rev-cited', pageNumber: 8, annotationId: 'note-3' }}
        currentDocument={currentDocument}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('Source changed since the answer')).toBeTruthy()
    expect(screen.getByText(/PDF page 8/)).toBeTruthy()
    expect(screen.getByText(/annotation note-3/)).toBeTruthy()
  })
})
