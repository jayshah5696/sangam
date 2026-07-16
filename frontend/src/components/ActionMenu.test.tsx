// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActionMenu, ActionMenuItem } from './ActionMenu'

afterEach(cleanup)

describe('ActionMenu', () => {
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
})
