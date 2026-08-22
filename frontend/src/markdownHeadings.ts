import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({ html: false })

export type MarkdownHeading = {
  level: number
  line: number
  text: string
}

/** Extract headings from the same block grammar used by preview rendering. */
export function extractMarkdownHeadings(content: string): MarkdownHeading[] {
  const tokens = markdown.parse(content, {})
  const headings: MarkdownHeading[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const opening = tokens[index]
    if (opening?.type !== 'heading_open' || !opening.map) continue
    const inline = tokens[index + 1]
    if (inline?.type !== 'inline') continue
    const text = inline.children
      ?.filter((token) => token.type !== 'image')
      .map((token) =>
        ['code_inline', 'text', 'html_inline'].includes(token.type)
          ? token.content.replace(/<[^>]+>/g, '')
          : '',
      )
      .join('')
      .trim()
    const fallback = inline.content.replace(/<[^>]+>/g, '').trim()
    const cleaned = (text || fallback).replace(/#+\s*$/, '').trim()
    headings.push({
      level: Number(opening.tag.slice(1)),
      line: opening.map[0] + 1,
      text: cleaned,
    })
  }
  return headings
}
