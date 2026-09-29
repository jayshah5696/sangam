export type EvidenceReference = {
  documentId: string
  title?: string
  revisionId?: string
  pageNumber?: number
  annotationId?: string
  selectedText: string
  note?: string
  claim?: string
}

export type EvidenceItem = {
  id: string
  sourceDocumentId: string
  sourceTitle: string
  sourcePath?: string | null
  sourceContentType: string
  pinnedRevisionId?: string
  pageNumber?: number
  annotationId?: string
  selectedText: string
  note?: string
  claim?: string
  createdAt: string
}

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

  const params = new URLSearchParams()
  if (reference.revisionId) params.set('revision', reference.revisionId)
  if (reference.pageNumber && reference.pageNumber > 0) params.set('page', String(reference.pageNumber))
  if (reference.annotationId) params.set('annotation', reference.annotationId)

  const query = params.size ? `?${params.toString()}` : ''
  const link = `sangam://document/${reference.documentId}${query}`

  let label = reference.title?.trim() || (reference.pageNumber ? 'PDF' : 'Source')
  if (reference.pageNumber && reference.pageNumber > 0) {
    label = `${label} p. ${reference.pageNumber}`
  }

  return `\n\n${lines.join('\n')}\n\n[Source: ${label}](${link})\n`
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
    note: item.note,
    claim: item.claim,
  }
}
