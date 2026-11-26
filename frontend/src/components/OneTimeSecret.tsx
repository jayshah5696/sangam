import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'

export function OneTimeSecret({
  title,
  description,
  value,
  copyLabel,
  setupCopies = [],
  compact = false,
  icon,
  dismissLabel,
  onDismiss,
}: {
  title: string
  description?: string
  value: string
  copyLabel: string
  setupCopies?: readonly { label: string; copiedLabel: string; value: string }[]
  compact?: boolean
  icon?: ReactNode
  dismissLabel?: string
  onDismiss?: () => void
}) {
  const [copyState, setCopyState] = useState<{ label: string; status: 'copied' | 'failed' } | null>(null)
  const copied = copyState?.status === 'copied' ? copyState.label : null

  const copy = async (copyValue: string, label: string) => {
    try {
      await navigator.clipboard.writeText(copyValue)
      setCopyState({ label, status: 'copied' })
    } catch {
      setCopyState({ label, status: 'failed' })
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
        <button className="secondary-action" type="button" onClick={() => void copy(value, copyLabel)}>
          {copied === copyLabel ? <Check size="var(--icon-inline)" /> : <Copy size="var(--icon-inline)" />}
          {copied === copyLabel ? 'Copied' : copyLabel}
        </button>
        {onDismiss && (
          <button className="secondary-action" type="button" onClick={onDismiss}>
            <Check size="var(--icon-inline)" /> {dismissLabel ?? 'Done'}
          </button>
        )}
      </div>
      {setupCopies.length > 0 && (
        <div className="one-time-secret-setup" role="group" aria-label="Client setup">
          <small>Client setup</small>
          <div className="token-actions">
            {setupCopies.map(({ label, copiedLabel, value: instructions }) => (
              <button
                className="secondary-action"
                key={label}
                type="button"
                onClick={() => void copy(instructions, label)}
              >
                {copied === label ? <Check size="var(--icon-inline)" /> : <Copy size="var(--icon-inline)" />}
                {copied === label ? copiedLabel : label}
              </button>
            ))}
          </div>
        </div>
      )}
      {copyState?.status === 'failed' && (
        <small className="copy-feedback error-text" role="alert">
          {copyState.label === copyLabel
            ? 'Clipboard access failed. Copy the value manually.'
            : 'Clipboard access failed. Try copying the setup again.'}
        </small>
      )}
    </div>
  )
}
