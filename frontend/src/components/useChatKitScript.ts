import { useCallback, useEffect, useState } from 'react'

export const CHATKIT_SCRIPT_SRC = 'https://cdn.platform.openai.com/deployments/chatkit/chatkit.js'

export type ChatKitScriptStatus = 'loading' | 'ready' | 'error'

const SCRIPT_LOAD_TIMEOUT_MS = 20_000

export function useChatKitScript(enabled: boolean) {
  const [attempt, setAttempt] = useState(0)
  const [status, setStatus] = useState<ChatKitScriptStatus>(
    customElements.get('openai-chatkit') ? 'ready' : 'loading',
  )

  useEffect(() => {
    if (!enabled) return
    if (customElements.get('openai-chatkit')) return
    let script = window.document.querySelector<HTMLScriptElement>(`script[src="${CHATKIT_SCRIPT_SRC}"]`)
    if (!script) {
      script = window.document.createElement('script')
      script.src = CHATKIT_SCRIPT_SRC
      script.async = true
      window.document.head.append(script)
    }
    const loaded = () => {
      clearTimeout(timeout)
      setStatus('ready')
    }
    const failed = () => {
      clearTimeout(timeout)
      setStatus('error')
    }
    // A blocked or stalled CDN request must surface as a retryable error
    // instead of leaving an eternally blank chat panel.
    const timeout = window.setTimeout(() => {
      setStatus((current) => (current === 'loading' ? 'error' : current))
    }, SCRIPT_LOAD_TIMEOUT_MS)
    script.addEventListener('load', loaded)
    script.addEventListener('error', failed)
    return () => {
      clearTimeout(timeout)
      script?.removeEventListener('load', loaded)
      script?.removeEventListener('error', failed)
    }
  }, [attempt, enabled])

  const retry = useCallback(() => {
    window.document.querySelector(`script[src="${CHATKIT_SCRIPT_SRC}"]`)?.remove()
    setStatus(customElements.get('openai-chatkit') ? 'ready' : 'loading')
    setAttempt((value) => value + 1)
  }, [])

  return { status, retry }
}
