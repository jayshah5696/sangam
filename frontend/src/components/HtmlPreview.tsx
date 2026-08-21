import { useEffect, useState } from 'react'

type HtmlPreviewProps = {
  content: string
  resolveAsset?: (reference: string) => Promise<string>
}

export function HtmlPreview({ content, resolveAsset }: HtmlPreviewProps) {
  const [resolved, setResolved] = useState<{ input: string; output: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    const objectUrls: string[] = []
    if (!resolveAsset) return () => undefined
    void (async () => {
      const parsed = new DOMParser().parseFromString(content, 'text/html')
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
        setResolved({ input: content, output: `<!doctype html>${parsed.documentElement.outerHTML}` })
      }
    })().catch(() => undefined)
    return () => {
      cancelled = true
      objectUrls.forEach(URL.revokeObjectURL)
    }
  }, [content, resolveAsset])

  return (
    <iframe
      className="html-preview"
      title="HTML preview"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      srcDoc={resolved?.input === content ? resolved.output : content}
    />
  )
}
