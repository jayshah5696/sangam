// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OneTimeSecret } from './OneTimeSecret'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('OneTimeSecret', () => {
  it('copies the secret and confirms success without exposing it again', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    render(
      <OneTimeSecret
        title="Copy this token now"
        description="This value will not be shown again."
        value="secret-token"
        copyLabel="Copy token"
      />,
    )

    expect(screen.getByRole('status').textContent).toContain('Copy this token now')
    fireEvent.click(screen.getByRole('button', { name: 'Copy token' }))

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('secret-token'))
    expect(screen.getByRole('button', { name: 'Copied' })).not.toBeNull()
  })

  it('keeps the value visible and reports clipboard failures', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })

    render(
      <OneTimeSecret
        compact
        title="Copy this link now"
        value="https://example.test/#token=secret"
        copyLabel="Copy link"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Copy link' }))

    expect((await screen.findByRole('alert')).textContent).toContain('Copy the value manually')
    expect(screen.getByText('https://example.test/#token=secret')).not.toBeNull()
  })
})
