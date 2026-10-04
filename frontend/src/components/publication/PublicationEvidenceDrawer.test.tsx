// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublishedEvidenceItem } from '../../api'
import { PublicationEvidenceDrawer } from './PublicationEvidenceDrawer'

afterEach(cleanup)

const sampleEvidence: PublishedEvidenceItem[] = [
  {
    id: 'ev_1',
    claim: 'Solar arrays degrade slower under mild temperature cycles',
    selected_text: 'Degradation rate was limited to 0.2% per 1000 hours in controlled cycling.',
    note: 'Tested over 5000 operational cycles in chamber B.',
    source_title: 'Thermal Stress Report',
    source_document_id: 'doc_1',
    pinned_revision_id: 'rev_abcdef123456',
    page_number: 14,
    source_is_public: false,
    source_slug: null,
  },
  {
    id: 'ev_2',
    claim: 'Baseline efficiency matches industry consensus',
    selected_text: 'Standard test conditions report 22.4% module efficiency.',
    note: null,
    source_title: 'Global Photovoltaic Benchmark',
    source_document_id: 'doc_2',
    pinned_revision_id: 'rev_999888777666',
    page_number: null,
    source_is_public: true,
    source_slug: 'pv-benchmark-2025',
  },
]

describe('PublicationEvidenceDrawer', () => {
  it('does not render when closed', () => {
    const { container } = render(
      <PublicationEvidenceDrawer evidence={sampleEvidence} isOpen={false} onClose={vi.fn()} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders evidence list with claims, quotes, badges, and public links', () => {
    const onClose = vi.fn()
    const onHighlight = vi.fn()
    render(
      <PublicationEvidenceDrawer
        evidence={sampleEvidence}
        isOpen={true}
        onClose={onClose}
        onHighlightPassage={onHighlight}
      />,
    )

    expect(screen.getByRole('heading', { name: /Evidence Drawer/i })).toBeDefined()
    expect(screen.getByText('Thermal Stress Report')).toBeDefined()
    expect(screen.getByText(/Solar arrays degrade slower/i)).toBeDefined()
    expect(screen.getByText(/Degradation rate was limited to 0.2%/i)).toBeDefined()
    expect(screen.getByText(/Page 14/i)).toBeDefined()
    expect(screen.getByText(/rev_abcd/i)).toBeDefined()
    expect(screen.getByText('Workspace source')).toBeDefined()

    // Public source link
    const publicLink = screen.getByRole('link', { name: /Public source/i })
    expect(publicLink.getAttribute('href')).toBe('/p/pv-benchmark-2025')

    // Find in text button
    const findButtons = screen.getAllByRole('button', { name: /Find in text/i })
    expect(findButtons).toHaveLength(2)
    fireEvent.click(findButtons[0]!)
    expect(onHighlight).toHaveBeenCalledWith(sampleEvidence[0]!.selected_text)

    // Close button
    const closeBtn = screen.getByRole('button', { name: /Close evidence drawer/i })
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalled()
  })

  it('closes on Escape key press', () => {
    const onClose = vi.fn()
    render(<PublicationEvidenceDrawer evidence={sampleEvidence} isOpen={true} onClose={onClose} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })
})
