// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DraftRecoveryNotice, offlineRecoveryMessage, recoveryFilename } from './DraftRecoveryNotice'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('DraftRecoveryNotice', () => {
  it('does not claim browser durability until persistence is confirmed', () => {
    expect(offlineRecoveryMessage('pending')).toContain('not yet confirmed')
    expect(offlineRecoveryMessage('failed')).toContain('not yet confirmed')
    expect(offlineRecoveryMessage('persisted')).toContain('recovery copy is stored')
  })

  it('offers retry, clipboard, and download recovery actions', async () => {
    const writeText = vi.fn(async () => undefined)
    const createObjectURL = vi.fn(() => 'blob:recovery')
    const revokeObjectURL = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const onRetry = vi.fn()

    render(
      <DraftRecoveryNotice
        title="Design notes"
        contentType="text/markdown"
        content="# Unsaved"
        operation="write"
        error="quota exceeded"
        retrying={false}
        onRetry={onRetry}
      />,
    )

    expect(screen.getByRole('alert').textContent).toContain('Closing this tab could lose changes')
    fireEvent.click(screen.getByRole('button', { name: 'Retry browser storage' }))
    expect(onRetry).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: 'Copy draft' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('# Unsaved'))
    expect(screen.getByRole('status').textContent).toContain('Draft copied')
    fireEvent.click(screen.getByRole('button', { name: 'Download recovery file' }))
    expect(createObjectURL).toHaveBeenCalledOnce()
    expect(click).toHaveBeenCalledOnce()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:recovery')
    click.mockRestore()
  })

  it('uses safe recovery filenames for markdown and HTML', () => {
    expect(recoveryFilename('Quarterly plan.md', 'text/markdown')).toBe('Quarterly-plan.recovery.md')
    expect(recoveryFilename('Prototype.html', 'text/html')).toBe('Prototype.recovery.html')
  })
})
