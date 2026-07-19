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
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base'],
    FORBID_ATTR: ['srcdoc'],
  })
  const parsed = new DOMParser().parseFromString(sanitized, 'text/html')
  parsed.querySelectorAll('meta[http-equiv], meta[name="referrer"]').forEach((element) => element.remove())
  const charset = parsed.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  const policy = parsed.createElement('meta')
  policy.setAttribute('http-equiv', 'Content-Security-Policy')
  policy.setAttribute('content', csp)
  const referrer = parsed.createElement('meta')
  referrer.setAttribute('name', 'referrer')
  referrer.setAttribute('content', 'no-referrer')
  parsed.head.prepend(charset, policy, referrer)
  return `<!doctype html>${parsed.documentElement.outerHTML}`
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
