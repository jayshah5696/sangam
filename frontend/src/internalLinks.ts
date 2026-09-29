const internalDocumentPattern = /^sangam:\/\/document\/([0-9a-f-]+)(\?[^#\s]*)?$/i

export function internalDocumentHref(href: string): string | null {
  const match = internalDocumentPattern.exec(href)
  if (!match) return null
  const search = new URLSearchParams(match[2]?.slice(1))
  const output = new URLSearchParams()
  const page = search.get('page')
  const annotation = search.get('annotation')
  const revision = search.get('revision')
  if (page && /^\d+$/.test(page)) output.set('page', page)
  if (annotation && /^[0-9a-f-]+$/i.test(annotation)) output.set('annotation', annotation)
  if (revision && /^[0-9a-f-]+$/i.test(revision)) output.set('revision', revision)
  const text = search.get('text')
  const start = search.get('start')
  if (text) output.set('text', text)
  if (start && /^\d+$/.test(start)) output.set('start', start)
  const representation = search.get('representation')
  if (representation === 'rendered' || representation === 'source')
    output.set('representation', representation)
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
