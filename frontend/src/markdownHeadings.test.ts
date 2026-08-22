import { describe, expect, it } from 'vitest'
import { extractMarkdownHeadings } from './markdownHeadings'

describe('extractMarkdownHeadings', () => {
  it('uses rendered inline text and ignores fenced code headings', () => {
    const content = [
      '## What matters for LoRA[#](#what-matters-for-lora "Link")',
      '',
      '```markdown',
      '# Not an outline heading',
      '```',
      '',
      '### **Bold Section** and `Code Title`',
      '',
      'Setext heading',
      '---------------',
    ].join('\n')

    expect(extractMarkdownHeadings(content)).toEqual([
      { level: 2, line: 1, text: 'What matters for LoRA' },
      { level: 3, line: 7, text: 'Bold Section and Code Title' },
      { level: 2, line: 9, text: 'Setext heading' },
    ])
  })

  it('does not expose raw HTML or image syntax in an outline title', () => {
    expect(extractMarkdownHeadings('## <span>Hidden</span> Visible ![diagram](a.png)')).toEqual([
      { level: 2, line: 1, text: 'Hidden Visible' },
    ])
  })
})
