import { describe, expect, it } from 'vitest'
import { linkSelection, toggleInlineMarker } from './markdownFormatting'

function apply(doc: string, edit: ReturnType<typeof toggleInlineMarker>) {
  const next = doc.slice(0, edit.from) + edit.insert + doc.slice(edit.to)
  return { next, selected: next.slice(edit.selection.anchor, edit.selection.head) }
}

describe('toggleInlineMarker', () => {
  it('wraps the selection and keeps the same words selected', () => {
    const doc = 'make this bold now'
    const result = apply(doc, toggleInlineMarker(doc, 5, 9, '**'))
    expect(result.next).toBe('make **this** bold now')
    expect(result.selected).toBe('this')
  })

  it('unwraps when the selection is already surrounded by the marker', () => {
    const doc = 'make **this** bold'
    const result = apply(doc, toggleInlineMarker(doc, 7, 11, '**'))
    expect(result.next).toBe('make this bold')
    expect(result.selected).toBe('this')
  })

  it('unwraps when the marker is inside the selection', () => {
    const doc = 'make _this_ italic'
    const result = apply(doc, toggleInlineMarker(doc, 5, 11, '_'))
    expect(result.next).toBe('make this italic')
    expect(result.selected).toBe('this')
  })

  it('inserts an empty pair and places the cursor between the markers', () => {
    const doc = 'ab'
    const edit = toggleInlineMarker(doc, 1, 1, '`')
    const result = apply(doc, edit)
    expect(result.next).toBe('a``b')
    expect(edit.selection).toEqual({ anchor: 2, head: 2 })
  })

  it('keeps surrounding whitespace outside the markers', () => {
    const doc = 'say  word  here'
    const result = apply(doc, toggleInlineMarker(doc, 3, 11, '**'))
    expect(result.next).toBe('say  **word**  here')
  })
})

describe('linkSelection', () => {
  it('turns selected words into a link and selects the URL placeholder', () => {
    const doc = 'see the docs today'
    const result = apply(doc, linkSelection(doc, 8, 12))
    expect(result.next).toBe('see the [docs](https://) today')
    expect(result.selected).toBe('https://')
  })

  it('uses a selected URL as the destination and selects the label', () => {
    const doc = 'at https://example.com now'
    const result = apply(doc, linkSelection(doc, 3, 22))
    expect(result.next).toBe('at [link text](https://example.com) now')
    expect(result.selected).toBe('link text')
  })
})
