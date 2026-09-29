import { evidenceSourceText } from '../evidenceCitation'
import { internalDocumentHref } from '../internalLinks'
import { useMemo } from 'react'

// Plain source text remains selectable without granting an article's iframe
// same-origin access, script privileges, or authority to submit selections.
export function SelectableHtmlText({
  content,
  initiallyOpen = false,
}: {
  content: string
  initiallyOpen?: boolean
}) {
  const citations = useMemo(() => {
    const parsed = new DOMParser().parseFromString(content, 'text/html')
    return Array.from(parsed.querySelectorAll('a[href]')).flatMap((element) => {
      const reference = element.getAttribute('href') ?? ''
      const href = internalDocumentHref(reference.replace(/^\/documents\//, 'sangam://document/'))
      return href ? [{ href, label: element.textContent?.trim() || 'Open source' }] : []
    })
  }, [content])
  return (
    <details className="html-source-text" open={initiallyOpen}>
      <summary>Selectable article text</summary>
      <article aria-label="Article source text">
        {evidenceSourceText(content, 'text/html')
          .split('\n')
          .filter(Boolean)
          .map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
      </article>
      {citations.length > 0 && (
        <nav aria-label="Article citations">
          {citations.map((citation, index) => (
            <p key={index}>
              <a href={citation.href}>{citation.label}</a>
            </p>
          ))}
        </nav>
      )}
    </details>
  )
}
