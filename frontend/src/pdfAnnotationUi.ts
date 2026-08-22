import type { Annotation } from './api'

export type FloatingAnchor = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width'>

export function floatingPosition(
  anchor: FloatingAnchor,
  floating: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
) {
  const inset = 8
  const idealLeft = anchor.left + anchor.width / 2 - floating.width / 2
  const left = Math.min(Math.max(inset, idealLeft), Math.max(inset, viewport.width - floating.width - inset))
  const above = anchor.top - floating.height - gap
  const top =
    above >= inset
      ? above
      : Math.min(anchor.bottom + gap, Math.max(inset, viewport.height - floating.height - inset))
  return { left, top }
}

export function annotationLink(annotation: Annotation) {
  return `sangam://document/${annotation.document_id}?page=${annotation.page_number}&annotation=${annotation.annotation_id}`
}

export function markdownSelectionCitation(
  title: string,
  documentId: string,
  pageNumber: number,
  selectedText: string,
) {
  const link = `sangam://document/${documentId}?page=${pageNumber}`
  return `> ${selectedText.replaceAll('\n', '\n> ')}\n\n[${title}, p. ${pageNumber}](${link})`
}
