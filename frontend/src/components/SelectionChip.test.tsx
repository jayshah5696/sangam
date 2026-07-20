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

import { SelectionChip } from './ChatPanel'

afterEach(cleanup)

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
