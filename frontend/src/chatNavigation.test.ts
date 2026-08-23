import { describe, expect, it } from 'vitest'
import { chatNavigationState } from './chatNavigation'

describe('chatNavigationState', () => {
  it('keeps selection out of the URL and bounds browser history state', () => {
    const selectedText = 'x'.repeat(25_000)
    expect(chatNavigationState(selectedText)).toEqual({
      sangamChatContext: { selectedText: 'x'.repeat(20_000) },
    })
  })

  it('omits empty selection state', () => {
    expect(chatNavigationState('')).toEqual({})
  })
})
