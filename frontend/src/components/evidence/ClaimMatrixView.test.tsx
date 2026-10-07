// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvidenceItem } from '../../evidenceCitation'
import { ClaimMatrixView } from './ClaimMatrixView'

describe('ClaimMatrixView', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const mockEvidence: EvidenceItem[] = [
    {
      id: 'item-1',
      sourceDocumentId: 'doc-bench',
      sourceTitle: 'Benchmark Paper',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-1',
      selectedText: 'Smaller model achieves 94% accuracy on domain tasks.',
      claim: 'Smaller model is sufficient',
      claimClassification: 'Supports',
      createdAt: '2026-10-06T12:00:00Z',
    },
    {
      id: 'item-2',
      sourceDocumentId: 'doc-local',
      sourceTitle: 'Local Experiment',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-2',
      selectedText: 'In local inference, the smaller model diverged on complex math.',
      claim: 'Smaller model is sufficient',
      claimClassification: 'Challenges',
      note: 'Divergence observed on GSM8K prompts.',
      createdAt: '2026-10-06T12:01:00Z',
    },
    {
      id: 'item-3',
      sourceDocumentId: 'doc-local',
      sourceTitle: 'Local Experiment',
      sourceContentType: 'text/markdown',
      pinnedRevisionId: 'rev-2',
      selectedText: 'Model comfortably loaded in 8GB VRAM with 4-bit quant.',
      claim: 'Memory fits target machine',
      claimClassification: 'Supports',
      createdAt: '2026-10-06T12:02:00Z',
    },
  ]

  it('renders empty notice when evidence has no sources', () => {
    render(<ClaimMatrixView evidence={[]} onOpenPassage={vi.fn()} onUpdateClassification={vi.fn()} />)
    expect(screen.getByText('No sources found in kept evidence.')).toBeTruthy()
  })

  it('renders matrix headers and claim rows with stance badges', () => {
    render(
      <ClaimMatrixView evidence={mockEvidence} onOpenPassage={vi.fn()} onUpdateClassification={vi.fn()} />,
    )

    // Table column headers
    expect(screen.getByText('Benchmark Paper')).toBeTruthy()
    expect(screen.getByText('Local Experiment')).toBeTruthy()

    // Claim rows
    expect(screen.getByText('Smaller model is sufficient')).toBeTruthy()
    expect(screen.getByText('Memory fits target machine')).toBeTruthy()

    // Status badges
    const supportsBadges = screen.getAllByRole('button', { name: /Status: Supports/i })
    expect(supportsBadges.length).toBeGreaterThanOrEqual(1)

    const challengesBadge = screen.getByRole('button', { name: /Status: Challenges/i })
    expect(challengesBadge).toBeTruthy()

    // Missing pairing cell shows "Not checked"
    expect(screen.getAllByText('Not checked').length).toBeGreaterThanOrEqual(1)
  })

  it('filters claims based on search input', () => {
    render(
      <ClaimMatrixView evidence={mockEvidence} onOpenPassage={vi.fn()} onUpdateClassification={vi.fn()} />,
    )

    const searchInput = screen.getByPlaceholderText('Filter claims or sources...')
    fireEvent.change(searchInput, { target: { value: 'Memory' } })

    expect(screen.getByText('Memory fits target machine')).toBeTruthy()
    expect(screen.queryByText('Smaller model is sufficient')).toBeNull()
  })

  it('allows adding a new custom claim to evaluate', () => {
    render(
      <ClaimMatrixView evidence={mockEvidence} onOpenPassage={vi.fn()} onUpdateClassification={vi.fn()} />,
    )

    const addInput = screen.getByPlaceholderText('Add a new claim to evaluate...')
    fireEvent.change(addInput, { target: { value: 'Latency under 50ms' } })

    const addBtn = screen.getByRole('button', { name: 'Add claim' })
    fireEvent.click(addBtn)

    expect(screen.getByText('Latency under 50ms')).toBeTruthy()
  })

  it('opens details modal when a cell badge is clicked and updates classification', () => {
    const onUpdateClassification = vi.fn()
    const onOpenPassage = vi.fn()

    render(
      <ClaimMatrixView
        evidence={mockEvidence}
        onOpenPassage={onOpenPassage}
        onUpdateClassification={onUpdateClassification}
      />,
    )

    const challengesBadge = screen.getByRole('button', { name: /Status: Challenges/i })
    fireEvent.click(challengesBadge)

    // Modal dialog opens
    expect(screen.getByText('Evidence & Stance Details')).toBeTruthy()
    expect(screen.getByText('In local inference, the smaller model diverged on complex math.')).toBeTruthy()
    expect(screen.getByText('Divergence observed on GSM8K prompts.')).toBeTruthy()

    // Update stance to Assumption
    const assumptionBtn = screen.getByRole('button', { name: 'Assumption' })
    fireEvent.click(assumptionBtn)

    expect(onUpdateClassification).toHaveBeenCalledWith('item-2', 'Assumption')

    // Navigate to passage
    const openPassageBtn = screen.getByRole('button', { name: 'Open passage in source' })
    fireEvent.click(openPassageBtn)

    expect(onOpenPassage).toHaveBeenCalledWith(expect.objectContaining({ id: 'item-2' }))
  })

  it('copies Markdown matrix table to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText,
      },
    })

    render(
      <ClaimMatrixView evidence={mockEvidence} onOpenPassage={vi.fn()} onUpdateClassification={vi.fn()} />,
    )

    const copyBtn = screen.getByRole('button', { name: 'Copy markdown matrix' })
    fireEvent.click(copyBtn)

    expect(writeText).toHaveBeenCalled()
    // SAFETY: clipboard writeText argument is guaranteed to be a string
    const copiedText = String(writeText.mock.calls[0]?.[0] ?? '')
    expect(copiedText).toContain('| Claim | Benchmark Paper | Local Experiment |')
    expect(copiedText).toContain('Smaller model is sufficient')
    expect(copiedText).toContain('Supports')
    expect(copiedText).toContain('Challenges')
  })
})
