const internalDocumentPattern = /^sangam:\/\/document\/([0-9a-f-]+)$/i

export function internalDocumentHref(href: string): string | null {
  const match = internalDocumentPattern.exec(href)
  return match ? `/documents/${match[1]}` : null
}

export function internalDocumentMarkdown(document: { document_id: string; title: string; path: string | null }) {
  const label = document.path ?? document.title
  return `[${label}](sangam://document/${document.document_id})`
}
