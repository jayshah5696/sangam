import { z } from 'zod'
import MarkdownIt from 'markdown-it'
import { citationLink, textLocatorSchema, type TextLocator } from './citationNavigation'
const markdownText = new MarkdownIt({ html: false, linkify: true, typographer: true })

// The locator is relative to the immutable source text, never the destination draft.
export function locatePassage(content: string, exact: string, occurrence = 0): TextLocator | undefined {
  let start = content.indexOf(exact)
  for (let index = 0; index < occurrence && start >= 0; index++)
    start = content.indexOf(exact, start + exact.length)
  if (start < 0) return undefined
  return passageAt(content, exact, start)
}

function passageAt(content: string, exact: string, start: number): TextLocator {
  const end = start + exact.length
  return {
    exact,
    start,
    end,
    prefix: content.slice(Math.max(0, start - 80), start),
    suffix: content.slice(end, end + 80),
  }
}

export function evidenceSourceText(content: string, contentType: string): string {
  if (contentType !== 'text/html') return content
  const parsed = new DOMParser().parseFromString(content, 'text/html')
  parsed.querySelectorAll('script, style, template, noscript').forEach((element) => element.remove())
  parsed
    .querySelectorAll('p, div, section, article, li, h1, h2, h3, h4, br')
    .forEach((element) => element.append('\n'))
  return (parsed.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim()
}

export type EvidenceReference = {
  documentId: string
  title?: string
  revisionId?: string
  pageNumber?: number
  annotationId?: string
  selectedText: string
  note?: string
  claim?: string
  textLocator?: TextLocator
}

export function locateEvidencePassage(
  content: string,
  contentType: string,
  exact: string,
  occurrence = 0,
): TextLocator | undefined {
  const source = contentType === 'text/html' ? undefined : locatePassage(content, exact, occurrence)
  if (source) return source
  const rendered = evidenceSourceText(
    contentType === 'text/markdown' ? markdownText.render(content) : content,
    'text/html',
  )
  const locator = locatePassage(rendered, exact, occurrence)
  if (locator) return { ...locator, representation: 'rendered' }
  return locatePassage(content, exact, occurrence)
}

export function evidenceTextForLocator(content: string, contentType: string, locator?: TextLocator) {
  return locator?.representation === 'rendered'
    ? evidenceSourceText(
        contentType === 'text/markdown' ? markdownText.render(content) : content,
        'text/html',
      )
    : content
}

export function remapEvidencePassage(
  content: string,
  item: Pick<EvidenceItem, 'sourceContentType' | 'selectedText' | 'textLocator'>,
): TextLocator | undefined {
  const first = locateEvidencePassage(content, item.sourceContentType, item.selectedText)
  if (!first) return undefined
  const text = evidenceTextForLocator(content, item.sourceContentType, first)
  if (text.indexOf(item.selectedText, first.end) < 0) return first
  const original = item.textLocator
  if (!original) return undefined
  let match: TextLocator | undefined
  for (
    let start = first.start;
    start >= 0;
    start = text.indexOf(item.selectedText, start + item.selectedText.length)
  ) {
    const candidate = passageAt(text, item.selectedText, start)
    if (
      (original.prefix && candidate.prefix.endsWith(original.prefix)) ||
      (original.suffix && candidate.suffix.startsWith(original.suffix))
    ) {
      if (match) return undefined
      match = { ...candidate, representation: first.representation }
    }
  }
  return match
}

export const evidenceItemSchema = z
  .object({
    id: z.string().min(1),
    sourceDocumentId: z.string().min(1),
    sourceTitle: z.string(),
    sourcePath: z.string().nullable().optional(),
    sourceContentType: z.enum(['text/markdown', 'text/html', 'application/pdf']),
    pinnedRevisionId: z.string().min(1).optional(),
    pageNumber: z.number().int().positive().optional(),
    annotationId: z.string().min(1).optional(),
    geometry: z
      .array(
        z.object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          width: z.number().min(0).max(1),
          height: z.number().min(0).max(1),
        }),
      )
      .optional(),
    selectedText: z.string().min(1),
    note: z.string().nullable().optional(),
    claim: z.string().nullable().optional(),
    claimTarget: z
      .object({
        documentId: z.string().min(1),
        anchor: z.number().int().nonnegative(),
        head: z.number().int().nonnegative(),
        revisionId: z.string().min(1).optional(),
      })
      .optional(),
    textLocator: textLocatorSchema.optional(),
    createdAt: z.iso.datetime(),
  })
  .refine(
    (item) =>
      item.sourceContentType === 'application/pdf'
        ? Boolean(item.pageNumber)
        : Boolean(item.pinnedRevisionId),
    'Evidence needs an immutable revision or PDF page',
  )
  .refine(
    (item) => !item.textLocator || item.textLocator.exact === item.selectedText,
    'The locator must identify the kept passage',
  )
export type EvidenceItem = z.infer<typeof evidenceItemSchema>

export function evidenceCitationMarkdown(reference: EvidenceReference): string {
  const selectedText = reference.selectedText.trim()
  const noteText = reference.note?.trim()
  const claimText = reference.claim?.trim()
  const lines: string[] = []

  if (selectedText) {
    for (const line of selectedText.split('\n')) {
      lines.push(`> ${line}`)
    }
  }

  if (noteText) {
    if (lines.length > 0) lines.push('> ')
    for (const line of noteText.split('\n')) {
      lines.push(`> ${line}`)
    }
  }

  if (claimText) {
    if (lines.length > 0) lines.push('> ')
    lines.push(`> Claim: ${claimText}`)
  }

  if (lines.length === 0) {
    lines.push('> Evidence from source.')
  }

  const { link, label } = evidenceSourceLink(reference)
  const literalLabel = ['\\', '[', ']', '<', '>', '*', '_', '`', '!', '~'].reduce(
    (text, character) => text.replaceAll(character, `\\${character}`),
    label,
  )
  return `\n\n${lines.join('\n')}\n\n[Source: ${literalLabel}](${link})\n`
}

function evidenceSourceLink(reference: EvidenceReference) {
  const link = citationLink({
    documentId: reference.documentId,
    revisionId: reference.revisionId,
    pageNumber: reference.pageNumber && reference.pageNumber > 0 ? reference.pageNumber : undefined,
    annotationId: reference.annotationId,
    textLocator: reference.textLocator,
  })

  let label = reference.title?.trim() || (reference.pageNumber ? 'PDF' : 'Source')
  if (reference.pageNumber && reference.pageNumber > 0) {
    label = `${label} p. ${reference.pageNumber}`
  }

  return { link, label }
}

export function evidenceCitationForType(reference: EvidenceReference, contentType: string): string {
  if (contentType !== 'text/html') return evidenceCitationMarkdown(reference)
  const escape = (text: string) =>
    text
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;')
  const { link, label } = evidenceSourceLink(reference)
  const paragraphs = [
    reference.selectedText,
    reference.note,
    reference.claim ? `Claim: ${reference.claim}` : undefined,
  ]
    .filter((text): text is string => Boolean(text?.trim()))
    .map((text) => `<p>${escape(text).replaceAll('\n', '<br>')}</p>`)
    .join('\n')
  return `\n\n<blockquote>\n${paragraphs}\n</blockquote>\n<p><a href="${escape(link.replace('sangam://document/', '/documents/'))}">Source: ${escape(label)}</a></p>\n`
}

export function shortRevision(value?: string): string {
  return value ? value.slice(0, 8) : 'unknown'
}

export function itemToEvidenceReference(item: EvidenceItem): EvidenceReference {
  return {
    documentId: item.sourceDocumentId,
    title: item.sourceTitle,
    revisionId: item.pinnedRevisionId,
    pageNumber: item.pageNumber,
    annotationId: item.annotationId,
    selectedText: item.selectedText,
    note: item.note ?? undefined,
    claim: item.claim ?? undefined,
    textLocator: item.textLocator,
  }
}
