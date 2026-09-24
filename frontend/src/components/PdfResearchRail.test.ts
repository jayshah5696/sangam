import { describe, expect, it } from 'vitest'
import { citationMarkdown } from './PdfResearchRail'

describe('PDF research handoff', () => {
  it('turns selected evidence into a stable cited Markdown block', () => {
    expect(
      citationMarkdown({
        document_id: 'source-1',
        annotation_id: 'annotation-1',
        page_number: 4,
        selected_text: 'A useful source passage.',
        note: 'Use this in the introduction.',
      }),
    ).toBe(
      '\n\n> A useful source passage.\n> \n> Use this in the introduction.\n\n[Source: PDF p. 4](sangam://document/source-1?page=4&annotation=annotation-1)\n',
    )
  })

  it('falls back to the note when selected text is empty', () => {
    expect(
      citationMarkdown({
        document_id: 'source-1',
        annotation_id: 'annotation-2',
        page_number: 7,
        selected_text: '',
        note: "Capture the author's definition.",
      }),
    ).toContain("> Capture the author's definition.")
  })
})
