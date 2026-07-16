// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorGroupErrorBoundary } from './EditorGroupErrorBoundary'

afterEach(cleanup)

function BrokenGroup(): never {
  throw new Error('broken group')
}

describe('EditorGroupErrorBoundary', () => {
  it('isolates a broken group and exposes recovery', () => {
    const recover = vi.fn()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(
      <div>
        <p>Healthy group</p>
        <EditorGroupErrorBoundary groupId="group-1" resetKey="doc-1" onRecover={recover}>
          <BrokenGroup />
        </EditorGroupErrorBoundary>
      </div>,
    )

    expect(screen.getByText('Healthy group')).toBeTruthy()
    expect(screen.getByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close this group' }))
    expect(recover).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})
