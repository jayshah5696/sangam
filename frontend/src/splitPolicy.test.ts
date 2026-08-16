// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  canSplitActiveGroup,
  minimumHorizontalGroupWidth,
  minimumVerticalGroupHeight,
  preferredSplitDirection,
} from './splitPolicy'

describe('splitPolicy', () => {
  it('exports documented minimum dimensions', () => {
    expect(minimumHorizontalGroupWidth).toBe(420)
    expect(minimumVerticalGroupHeight).toBe(300)
  })

  it('returns true when no active editor group is in the DOM', () => {
    document.body.innerHTML = ''
    expect(canSplitActiveGroup('horizontal')).toBe(true)
    expect(canSplitActiveGroup('vertical')).toBe(true)
  })

  it('enforces minimum width constraints when active group is present', () => {
    document.body.innerHTML = '<div class="editor-group active"></div>'
    const group = document.querySelector<HTMLElement>('.editor-group.active')!

    // Width less than 2 * 420 + 4 (844px) cannot split horizontally
    Object.defineProperty(group, 'clientWidth', { configurable: true, value: 800 })
    Object.defineProperty(group, 'clientHeight', { configurable: true, value: 700 })
    expect(canSplitActiveGroup('horizontal')).toBe(false)
    expect(canSplitActiveGroup('vertical')).toBe(true)
    expect(preferredSplitDirection()).toBe('vertical')

    // Width greater than or equal to 844px can split horizontally
    Object.defineProperty(group, 'clientWidth', { configurable: true, value: 900 })
    expect(canSplitActiveGroup('horizontal')).toBe(true)
    expect(preferredSplitDirection()).toBe('horizontal')
  })
})
