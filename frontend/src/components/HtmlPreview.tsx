import DOMPurify from 'dompurify'
import { useEffect, useMemo, useState } from 'react'

type HtmlPreviewProps = {
  content: string
  resolveAsset?: (reference: string) => Promise<string>
}

const csp = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  "font-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function safeDocument(content: string) {
  const sanitized = DOMPurify.sanitize(content, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base'],
    FORBID_ATTR: ['srcdoc'],
  })
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"></head><body>${sanitized}</body></html>`
}

export function HtmlPreview({ content, resolveAsset }: HtmlPreviewProps) {
  const initial = useMemo(() => safeDocument(content), [content])
  const [resolved, setResolved] = useState<{ input: string; output: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    const objectUrls: string[] = []
    if (!resolveAsset) return () => undefined
    void (async () => {
      const parsed = new DOMParser().parseFromString(initial, 'text/html')
      const elements = Array.from(parsed.querySelectorAll<HTMLElement>('[src]'))
      await Promise.all(
        elements.map(async (element) => {
          const reference = element.getAttribute('src') ?? ''
          if (!reference || /^(?:[a-z]+:|\/|#)/i.test(reference)) return
          const objectUrl = await resolveAsset(reference)
          objectUrls.push(objectUrl)
          element.setAttribute('src', objectUrl)
        }),
      )
      if (!cancelled) {
        setResolved({ input: initial, output: `<!doctype html>${parsed.documentElement.outerHTML}` })
      }
    })().catch(() => undefined)
    return () => {
      cancelled = true
      objectUrls.forEach(URL.revokeObjectURL)
    }
  }, [initial, resolveAsset])

  return (
    <iframe
      className="html-preview"
      title="Safe HTML preview"
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={resolved?.input === initial ? resolved.output : initial}
    />
  )
}
