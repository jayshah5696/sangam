import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { useEffect, useMemo, useRef } from 'react'
import { internalDocumentHref } from '../internalLinks'

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
})

const defaultLinkOpen = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, environment, self) => {
  const token = tokens[index]!
  const href = token.attrGet('href') ?? ''
  const internal = internalDocumentHref(href)
  if (internal) {
    token.attrSet('href', internal)
    token.attrSet('data-sangam-document', 'true')
  } else if (/^https?:\/\//i.test(href)) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, environment, self)
    : self.renderToken(tokens, index, options)
}

const defaultValidateLink = markdown.validateLink.bind(markdown)
markdown.validateLink = (url) => internalDocumentHref(url) !== null || defaultValidateLink(url)

type MarkdownPreviewProps = {
  content: string
}

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const previewRef = useRef<HTMLDivElement>(null)
  const safeHtml = useMemo(
    () => DOMPurify.sanitize(markdown.render(content), {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target'],
    }),
    [content],
  )

  useEffect(() => {
    const host = previewRef.current
    if (!host) return
    const diagrams = Array.from(host.querySelectorAll('code.language-mermaid'))
    if (diagrams.length === 0) return
    let cancelled = false
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'neutral',
        deterministicIds: true,
        deterministicIDSeed: 'sangam-preview',
      })
      for (const [index, code] of diagrams.entries()) {
        if (cancelled) return
        const pre = code.parentElement
        if (!pre) continue
        try {
          const result = await mermaid.render(`sangam-mermaid-${index}`, code.textContent ?? '')
          const container = document.createElement('figure')
          container.className = 'mermaid-diagram'
          container.innerHTML = DOMPurify.sanitize(result.svg, {
            USE_PROFILES: { svg: true, svgFilters: true },
          })
          pre.replaceWith(container)
        } catch {
          pre.classList.add('mermaid-error')
          pre.setAttribute('aria-label', 'Mermaid diagram could not be rendered')
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [safeHtml])

  return (
    <article
      className="markdown-preview"
      ref={previewRef}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
    />
  )
}
