import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'

export function OneTimeSecret({
  title,
  description,
  value,
  copyLabel,
  secondaryCopy,
  compact = false,
  icon,
  dismissLabel,
  onDismiss,
}: {
  title: string
  description?: string
  value: string
  copyLabel: string
  secondaryCopy?: { label: string; value: string }
  compact?: boolean
  icon?: ReactNode
  dismissLabel?: string
  onDismiss?: () => void
}) {
  const [copyState, setCopyState] = useState<'idle' | 'secret' | 'secondary' | 'failed'>('idle')

  const copy = async (copyValue: string, success: 'secret' | 'secondary') => {
    try {
      await navigator.clipboard.writeText(copyValue)
      setCopyState(success)
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
        <button className="secondary-action" type="button" onClick={() => void copy(value, 'secret')}>
          {copyState === 'secret' ? <Check size="var(--icon-inline)" /> : <Copy size="var(--icon-inline)" />}
          {copyState === 'secret' ? 'Copied' : copyLabel}
        </button>
        {secondaryCopy && (
          <button
            className="secondary-action"
            type="button"
            onClick={() => void copy(secondaryCopy.value, 'secondary')}
          >
            {copyState === 'secondary' ? (
              <Check size="var(--icon-inline)" />
            ) : (
              <Copy size="var(--icon-inline)" />
            )}
            {copyState === 'secondary' ? 'Setup copied' : secondaryCopy.label}
          </button>
        )}
        {onDismiss && (
          <button className="secondary-action" type="button" onClick={onDismiss}>
            <Check size="var(--icon-inline)" /> {dismissLabel ?? 'Done'}
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
