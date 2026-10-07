// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Document } from '../../api'
import { interactiveExplanationsStore } from '../../interactiveExplanations'
import { InteractiveExplanationRail } from './InteractiveExplanationRail'

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => state.navigate,
}))

vi.mock('../HtmlPreview', () => ({
  HtmlPreview: ({ content }: { content: string }) => (
    <div data-testid="mock-html-preview">{content}</div>
  ),
}))

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

describe('InteractiveExplanationRail', () => {
  const mockDoc: Document = {
    document_id: 'doc-target',
    title: 'Model Evaluation Paper',
    content_type: 'text/markdown',
    path: 'eval.md',
    current_revision_id: 'rev-target-1',
    content: '# Evaluation\n\nDiscussion.',
    content_hash: 'hash-target',
    size_bytes: 40,
    materialization_state: 'clean',
    created_at: '2026-10-06T10:00:00Z',
    updated_at: '2026-10-06T10:00:00Z',
  }

  beforeEach(async () => {
    Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), configurable: true })
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async (_name: string, callback: () => void) => callback() },
    })
    await interactiveExplanationsStore.clear()
    state.navigate.mockReset()
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders empty state and template buttons when none are attached', () => {
    render(<InteractiveExplanationRail document={mockDoc} />)

    expect(screen.getByText('No interactive explanations attached')).toBeTruthy()
    expect(screen.getByText('calculator')).toBeTruthy()
    expect(screen.getByText('timeline')).toBeTruthy()
    expect(screen.getByText('comparison')).toBeTruthy()
  })

  it('attaches an explanation via create modal and displays preview and assumptions', async () => {
    render(<InteractiveExplanationRail document={mockDoc} />)

    const attachBtn = screen.getByRole('button', { name: 'Attach interactive explanation' })
    fireEvent.click(attachBtn)

    expect(screen.getByText('Attach Interactive Explanation')).toBeTruthy()

    const submitBtn = screen.getByRole('button', { name: 'Attach Explanation' })
    fireEvent.click(submitBtn)

    // Card should now be rendered
    expect(screen.getByText('Parameter Estimation Calculator')).toBeTruthy()
    expect(screen.getByTestId('mock-html-preview')).toBeTruthy()

    // Switch to Source Inputs tab
    const assumptionsTab = screen.getByRole('tab', { name: /Source Inputs/i })
    fireEvent.click(assumptionsTab)

    expect(screen.getByText('Model Evaluation Paper')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Inspect in source' })).toBeTruthy()

    // Switch to HTML spec tab
    const codeTab = screen.getByRole('tab', { name: 'HTML Spec' })
    fireEvent.click(codeTab)

    expect(screen.getAllByText(/Interactive Model Memory Estimator/i).length).toBeGreaterThanOrEqual(1)
  })

  it('removes an attached explanation', async () => {
    await interactiveExplanationsStore.addExplanation({
      documentId: mockDoc.document_id,
      title: 'Timeline Attachment',
      kind: 'timeline',
      htmlContent: '<p>Timeline</p>',
      assumptions: [],
    })

    render(<InteractiveExplanationRail document={mockDoc} />)

    expect(screen.getByText('Timeline Attachment')).toBeTruthy()

    const removeBtn = screen.getByRole('button', { name: 'Remove explanation' })
    fireEvent.click(removeBtn)

    expect(screen.queryByText('Timeline Attachment')).toBeNull()
  })
})
