// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RevisionMergeView } from './RevisionMergeView'

vi.mock('../theme', () => ({
  useTheme: () => ({ preferences: { theme: 'river' } }),
}))

vi.mock('./PierreRevisionDiff', () => ({
  PierreRevisionDiff: ({
    oldFile,
    newFile,
    options,
  }: {
    oldFile: { name: string; contents: string }
    newFile: { name: string; contents: string }
    options: { diffStyle: string; overflow: string }
  }) => (
    <div data-testid="pierre-diff" data-layout={options.diffStyle} data-overflow={options.overflow}>
      <span>{oldFile.contents}</span>
      <span>{newFile.contents}</span>
    </div>
  ),
}))

afterEach(cleanup)

describe('RevisionMergeView', () => {
  it('passes both immutable revision snapshots to the lazy Pierre diff renderer', async () => {
    render(<RevisionMergeView original="# Before" modified="# After" />)

    const diff = await screen.findByTestId('pierre-diff')
    expect(diff.getAttribute('data-layout')).toBe('unified')
    expect(diff.getAttribute('data-overflow')).toBe('wrap')
    expect(screen.getByText('# Before')).toBeTruthy()
    expect(screen.getByText('# After')).toBeTruthy()
  })
})
