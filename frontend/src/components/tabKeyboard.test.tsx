// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activateTabFromKeyboard } from './tabKeyboard'

afterEach(cleanup)

describe('activateTabFromKeyboard', () => {
  it('wraps with arrow keys and activates the focused tab', () => {
    const activate = vi.fn()
    render(
      <div role="tablist" aria-label="Example tabs">
        {['first', 'second', 'third'].map((name) => (
          <button key={name} role="tab" onKeyDown={activateTabFromKeyboard} onClick={() => activate(name)}>
            {name}
          </button>
        ))}
      </div>,
    )

    screen.getByRole('tab', { name: 'first' }).focus()
    fireEvent.keyDown(screen.getByRole('tab', { name: 'first' }), { key: 'ArrowLeft' })

    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'third' }))
    expect(activate).toHaveBeenLastCalledWith('third')
  })

  it('supports Home and End without reacting to unrelated keys', () => {
    const activate = vi.fn()
    render(
      <div role="tablist" aria-label="Example tabs">
        {['first', 'second', 'third'].map((name) => (
          <button key={name} role="tab" onKeyDown={activateTabFromKeyboard} onClick={() => activate(name)}>
            {name}
          </button>
        ))}
      </div>,
    )

    const second = screen.getByRole('tab', { name: 'second' })
    fireEvent.keyDown(second, { key: 'End' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'third' }))
    fireEvent.keyDown(screen.getByRole('tab', { name: 'third' }), { key: 'Home' })
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'first' }))
    fireEvent.keyDown(screen.getByRole('tab', { name: 'first' }), { key: 'Enter' })
    expect(activate).toHaveBeenCalledTimes(2)
  })
})
