import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'

export function OneTimeSecret({
  title,
  description,
  value,
  copyLabel,
  compact = false,
  icon,
  dismissLabel,
  onDismiss,
}: {
  title: string
  description?: string
  value: string
  copyLabel: string
  compact?: boolean
  icon?: ReactNode
  dismissLabel?: string
  onDismiss?: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }

  return (
    <div className={`one-time-token${compact ? ' compact' : ''}`}>
      <div className="one-time-secret-heading" role="status">
        {icon}
        <span>
          <strong>{title}</strong>
          {description && <small>{description}</small>}
        </span>
      </div>
      <code>{value}</code>
      <div className="token-actions">
        <button className="secondary-action" type="button" onClick={() => void copy()}>
          {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
          {copyState === 'copied' ? 'Copied' : copyLabel}
        </button>
        {onDismiss && (
          <button className="secondary-action" type="button" onClick={onDismiss}>
            <Check size={14} /> {dismissLabel ?? 'Done'}
          </button>
        )}
        {copyState === 'failed' && (
          <small className="copy-feedback error-text" role="alert">
            Clipboard access failed. Copy the value manually.
          </small>
        )}
      </div>
    </div>
  )
}
