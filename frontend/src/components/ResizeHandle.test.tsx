// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResizeHandle } from './ResizeHandle'

afterEach(cleanup)

describe('ResizeHandle', () => {
  it('exposes its range and resizes a left rail with the keyboard', () => {
    const onChange = vi.fn()
    render(<ResizeHandle side="left" value={280} min={220} max={460} onChange={onChange} />)
    const handle = screen.getByRole('separator', { name: 'Resize left sidebar' })

    expect(handle.getAttribute('tabindex')).toBe('0')
    expect(handle.getAttribute('aria-valuenow')).toBe('280')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    fireEvent.keyDown(handle, { key: 'End' })

    expect(onChange).toHaveBeenNthCalledWith(1, 290)
    expect(onChange).toHaveBeenNthCalledWith(2, 460)
  })

  it('inverts arrow direction for the right rail and clamps its range', () => {
    const onChange = vi.fn()
    render(<ResizeHandle side="right" value={295} min={290} max={720} onChange={onChange} />)
    const handle = screen.getByRole('separator', { name: 'Resize right sidebar' })

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true })

    expect(onChange).toHaveBeenNthCalledWith(1, 290)
    expect(onChange).toHaveBeenNthCalledWith(2, 335)
  })
})
