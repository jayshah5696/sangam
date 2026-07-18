// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PierreRevisionDiff } from './PierreRevisionDiff'

const { preloadMultiFileDiff } = vi.hoisted(() => ({
  preloadMultiFileDiff: vi.fn(async () => ({ prerenderedHTML: '<pre>rendered diff</pre>' })),
}))

vi.mock('@pierre/diffs/ssr', () => ({ preloadMultiFileDiff }))
vi.mock('@pierre/diffs/react', () => ({
  MultiFileDiff: ({
    prerenderedHTML,
    disableWorkerPool,
  }: {
    prerenderedHTML: string
    disableWorkerPool: boolean
  }) => (
    <div data-testid="hydrated-diff" data-worker-pool={String(disableWorkerPool)}>
      {prerenderedHTML}
    </div>
  ),
}))

afterEach(cleanup)

describe('PierreRevisionDiff', () => {
  it('preloads highlighted HTML before hydrating the Pierre renderer', async () => {
    const oldFile = { name: 'previous-revision.md', contents: '# Before' }
    const newFile = { name: 'current-revision.md', contents: '# After' }
    const options = { diffStyle: 'unified' as const }

    render(<PierreRevisionDiff oldFile={oldFile} newFile={newFile} options={options} />)

    expect(screen.getByText('Preparing revision comparison…')).toBeTruthy()
    const diff = await screen.findByTestId('hydrated-diff')
    expect(diff.textContent).toContain('rendered diff')
    expect(diff.getAttribute('data-worker-pool')).toBe('true')
    expect(preloadMultiFileDiff).toHaveBeenCalledWith({ oldFile, newFile, options })
  })
})
