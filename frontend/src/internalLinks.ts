const internalDocumentPattern = /^sangam:\/\/document\/([0-9a-f-]+)(\?[^#\s]*)?$/i

export function internalDocumentHref(href: string): string | null {
  const match = internalDocumentPattern.exec(href)
  if (!match) return null
  const search = new URLSearchParams(match[2]?.slice(1))
  const output = new URLSearchParams()
  const page = search.get('page')
  const annotation = search.get('annotation')
  if (page && /^\d+$/.test(page)) output.set('page', page)
  if (annotation && /^[0-9a-f-]+$/i.test(annotation)) output.set('annotation', annotation)
  const suffix = output.size ? `?${output.toString()}` : ''
  return `/documents/${match[1]}${suffix}`
}

export function internalDocumentMarkdown(document: {
  document_id: string
  title: string
  path: string | null
}) {
  const label = document.path ?? document.title
  return `[${label}](sangam://document/${document.document_id})`
}
