// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionDialog, ActionMenu, ActionMenuItem } from './ActionMenu'

afterEach(cleanup)

describe('ActionMenu', () => {
  it('renders menu role and aria-haspopup="menu"', () => {
    render(
      <ActionMenu label="File actions" icon={<span>•••</span>}>
        {(close) => <ActionMenuItem onSelect={close}>Rename</ActionMenuItem>}
      </ActionMenu>,
    )

    const trigger = screen.getByRole('button', { name: 'File actions' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('menu', { name: 'File actions' })).toBeDefined()
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeDefined()
  })

  it('closes after an action and supports Escape dismissal', () => {
    const action = vi.fn()
    render(
      <ActionMenu label="File actions" icon={<span>•••</span>}>
        {(close) => (
          <ActionMenuItem
            onSelect={() => {
              action()
              close()
            }}
          >
            Rename
          </ActionMenuItem>
        )}
      </ActionMenu>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'File actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename' }))
    expect(action).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'File actions' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('supports ArrowUp and ArrowDown keyboard navigation', () => {
    render(
      <ActionMenu label="Options" icon={<span>•••</span>}>
        {() => (
          <>
            <ActionMenuItem onSelect={() => {}}>Option 1</ActionMenuItem>
            <ActionMenuItem onSelect={() => {}}>Option 2</ActionMenuItem>
            <ActionMenuItem onSelect={() => {}}>Option 3</ActionMenuItem>
          </>
        )}
      </ActionMenu>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    const menu = screen.getByRole('menu')
    const item1 = screen.getByRole('menuitem', { name: 'Option 1' })
    const item2 = screen.getByRole('menuitem', { name: 'Option 2' })

    item1.focus()
    expect(document.activeElement).toBe(item1)

    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item2)
  })

  it('sets data-side and data-align from available viewport space', () => {
    const originalInnerHeight = window.innerHeight
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 })

    const makeRect = (left: number, top: number, width: number, height: number): DOMRect => ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    })

    const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.getAttribute('role') === 'menu') {
        return makeRect(0, 0, 180, 140)
      }
      if (this.getAttribute('aria-label') === 'Bottom trigger') {
        return makeRect(40, 350, 32, 32)
      }
      return makeRect(480, 40, 32, 32)
    })

    try {
      const { unmount } = render(
        <ActionMenu label="Top trigger" icon={<span>•••</span>}>
          {(close) => <ActionMenuItem onSelect={close}>Action</ActionMenuItem>}
        </ActionMenu>,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Top trigger' }))
      const belowMenu = screen.getByRole('menu', { name: 'Top trigger' })
      expect(belowMenu.getAttribute('data-side')).toBe('bottom')
      expect(belowMenu.getAttribute('data-align')).toBe('right')
      unmount()

      render(
        <ActionMenu label="Bottom trigger" icon={<span>•••</span>}>
          {(close) => <ActionMenuItem onSelect={close}>Action</ActionMenuItem>}
        </ActionMenu>,
      )

      fireEvent.click(screen.getByRole('button', { name: 'Bottom trigger' }))
      const flippedMenu = screen.getByRole('menu', { name: 'Bottom trigger' })
      expect(flippedMenu.getAttribute('data-side')).toBe('top')
      expect(flippedMenu.getAttribute('data-align')).toBe('left')
    } finally {
      rectSpy.mockRestore()
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalInnerHeight })
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    }
  })
})

describe('ActionDialog', () => {
  it('renders dialog role, aria-modal="true", and aria-haspopup="dialog"', () => {
    render(
      <ActionDialog label="Document settings" icon={<span>⚙</span>}>
        {(close) => (
          <div>
            <label>
              Title
              <input data-testid="title-input" />
            </label>
            <button onClick={close}>Save</button>
          </div>
        )}
      </ActionDialog>,
    )

    const trigger = screen.getByRole('button', { name: 'Document settings' })
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    const dialog = screen.getByRole('dialog', { name: 'Document settings' })
    expect(dialog).toBeDefined()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
  })

  it('traps focus with Tab and Shift+Tab cycling', () => {
    render(
      <ActionDialog label="Edit form" icon={<span>✏</span>}>
        {(close) => (
          <div>
            <input data-testid="first-input" />
            <input data-testid="second-input" />
            <button data-testid="last-button" onClick={close}>
              Close
            </button>
          </div>
        )}
      </ActionDialog>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Edit form' }))
    const firstInput = screen.getByTestId('first-input')
    const lastButton = screen.getByTestId('last-button')

    lastButton.focus()
    expect(document.activeElement).toBe(lastButton)

    // Tab from last wraps to first
    fireEvent.keyDown(lastButton, { key: 'Tab', shiftKey: false })
    expect(document.activeElement).toBe(firstInput)

    // Shift+Tab from first wraps to last
    firstInput.focus()
    fireEvent.keyDown(firstInput, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(lastButton)
  })

  it('closes dialog on Escape and restores focus', () => {
    render(
      <ActionDialog label="Dialog test" icon={<span>⚙</span>}>
        {() => (
          <div>
            <input data-testid="dialog-input" />
          </div>
        )}
      </ActionDialog>,
    )

    const trigger = screen.getByRole('button', { name: 'Dialog test' })
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeDefined()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
