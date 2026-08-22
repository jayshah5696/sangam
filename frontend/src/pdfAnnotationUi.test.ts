import { describe, expect, it } from 'vitest'
import { floatingPosition, markdownSelectionCitation } from './pdfAnnotationUi'

describe('floatingPosition', () => {
  it('centers above the selection and clamps to the viewport', () => {
    expect(
      floatingPosition(
        { left: 2, right: 42, top: 80, bottom: 100, width: 40 },
        { width: 120, height: 40 },
        { width: 300, height: 200 },
      ),
    ).toEqual({ left: 8, top: 32 })
  })

  it('moves below a selection near the viewport top', () => {
    expect(
      floatingPosition(
        { left: 100, right: 140, top: 6, bottom: 24, width: 40 },
        { width: 100, height: 40 },
        { width: 300, height: 200 },
      ),
    ).toEqual({ left: 70, top: 32 })
  })
})

describe('markdownSelectionCitation', () => {
  it('quotes each selected line and links to the PDF page', () => {
    expect(markdownSelectionCitation('Paper', 'doc-1', 3, 'first\nsecond')).toBe(
      '> first\n> second\n\n[Paper, p. 3](sangam://document/doc-1?page=3)',
    )
  })
})
